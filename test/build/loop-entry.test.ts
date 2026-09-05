import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { enterBuild, type BuildEntry } from "../../src/build/loop-entry";
import { BuildStepCrash } from "../../src/build/loop-support";
import { parseProgress } from "../../src/build/progress";
import { appendRecordedState, foldState } from "../../src/build/state";
import { saveConfig } from "../../src/core/config";
import { readStatus, writeStatus } from "../../src/core/run";
import { builderResult, feature, setupLoop, type LoopFixture } from "./loop-fixture";

const HEAD = "a".repeat(40);

function entered(outcome: Awaited<ReturnType<typeof enterBuild>>): BuildEntry {
  if ("exit" in outcome) throw new Error(`expected an entry, got ${JSON.stringify(outcome.exit)}`);
  return outcome.entry;
}

function attempt(s: LoopFixture, attempt: number, disposition: "verify_failed" | "passed", exitReasons: string[] = []) {
  s.record.append({ t: "feature.pick", featureId: "f01", attempt, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
  s.record.append({ t: "builder.session", featureId: "f01", attempt, arm: "fresh", builderModelRef: "producer/builder", beforeHead: HEAD, afterHead: HEAD, stopped: "done", turns: 1, costUsd: 0.2, selfVerified: false, headMoved: false, contextPressure: false, pinnedTruncated: false, exitReasons });
  s.record.append({ t: "attempt", featureId: "f01", attempt, arm: "fresh", builderStopped: "done", builderSelfVerified: false, builderCommitted: false, contextPressure: false, declaredUnsatisfiable: exitReasons.length > 0, declarationReasons: exitReasons, declarationOverruled: false, builderCostUsd: 0.2, auditorCostUsd: 0.1, costUsd: 0.3, counted: true, disposition });
}

describe("build entry", () => {
  test("opens the phase, verifies the lock, and hands the loop its context through boundaries 0 and 1", async () => {
    const s = setupLoop(); const boundaries: number[] = []; s.deps.stepHook = (index) => { boundaries.push(index); };
    const entry = entered(await enterBuild(s.deps, {}));
    expect(entry.features.features.map((value) => value.id)).toEqual(["f01"]);
    expect(entry.project.repo).toBe(s.project.repo); expect(entry.git).toBe(s.git); expect(entry.discardStat).toBeUndefined();
    expect(boundaries).toEqual([0, 1]);
    expect(s.record.read().filter((event) => event.t === "phase.start" && event.phase === "build")).toHaveLength(1);
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "build", state: "running", cursor: { step: "lock" } });
    expect(existsSync(s.deps.run.metrics)).toBe(true);
    expect(s.git.calls.map((call) => call.method)).toEqual(["log", "hasTrailer", "statusPorcelain", "statusPorcelain"]);
    expect(s.builderCalls).toHaveLength(0); expect(s.checkCalls).toHaveLength(0);
    entered(await enterBuild(s.deps, {}));
    expect(s.record.read().filter((event) => event.t === "phase.start" && event.phase === "build")).toHaveLength(1);
  });

  test("routes terminal and unchanged-target resumes before any Git or record work", async () => {
    const failed = setupLoop(); writeStatus(failed.deps.run, { phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "integrity", message: "lock" } });
    expect(await enterBuild(failed.deps, {})).toEqual({ exit: { outcome: "failed", failureClass: "integrity", message: "lock" } });
    const honest = setupLoop(); writeStatus(honest.deps.run, { phase: "build", state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied", reasons: ["no"] } });
    expect(await enterBuild(honest.deps, {})).toEqual({ exit: { outcome: "honest_exit", kind: "cannot_be_satisfied", reasons: ["no"] } });

    const budget = setupLoop(); writeStatus(budget.deps.run, { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: budget.deps.cfg.budgets.usd, wallTargetSeconds: 1 } });
    expect(await enterBuild(budget.deps, {})).toEqual({ exit: { outcome: "stopped", stopKind: "budget", budgetTargetUsd: budget.deps.cfg.budgets.usd, wallTargetSeconds: 1 } });
    const deadline = setupLoop(); writeStatus(deadline.deps.run, { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "deadline", budgetTargetUsd: 1, wallTargetSeconds: deadline.deps.cfg.budgets.wallSeconds } });
    expect(await enterBuild(deadline.deps, {})).toEqual({ exit: { outcome: "stopped", stopKind: "deadline", budgetTargetUsd: 1, wallTargetSeconds: deadline.deps.cfg.budgets.wallSeconds } });
    for (const s of [failed, honest, budget, deadline]) { expect(s.git.calls).toHaveLength(0); expect(s.record.read().some((event) => event.t === "phase.start")).toBe(false); }

    budget.deps.cfg.budgets.usd += 1; saveConfig(budget.home, budget.deps.cfg);
    entered(await enterBuild(budget.deps, {}));
    const transient = setupLoop(); writeStatus(transient.deps.run, { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "transient" } });
    entered(await enterBuild(transient.deps, {}));
  });

  test("runs init.sh once under a 600 second deadline and repairs a crash between its check and its commit", async () => {
    const s = setupLoop(undefined, { initRecorded: false }); const base = s.deps.runCheck!; const stages: string[] = [];
    s.deps.runCheck = async (acceptance, options) => { const result = await base(acceptance, options); if (options.phase === "init") s.git.status = " M generated.txt"; return result; };
    s.deps.initHook = (stage) => { stages.push(stage); if (stages.length === 1) throw new Error("kill after init check"); };
    let error: unknown;
    try { await enterBuild(s.deps, {}); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(BuildStepCrash); expect(error).toMatchObject({ index: 0, boundary: "entry" });
    expect(s.checkCalls).toEqual([{ featureId: undefined, phase: "init", cwd: s.project.repo, timeoutMs: 600_000 }]);
    expect(s.git.commits).toHaveLength(0);

    entered(await enterBuild(s.deps, {}));
    expect(s.checkCalls).toHaveLength(1); expect(stages).toEqual(["check", "commit"]);
    expect(s.git.commits.map((commit) => commit.options)).toEqual([{ message: "chore(init)", trailers: { "Kiln-Init": s.deps.run.id, "Kiln-Run": s.deps.run.id } }]);
    expect(s.record.read().filter((event) => event.t === "check" && event.phase === "init")).toHaveLength(1);

    entered(await enterBuild(s.deps, {}));
    expect(s.checkCalls).toHaveLength(1); expect(s.git.commits).toHaveLength(1);
    // An explicit reinit runs init.sh again and commits whatever it changed.
    s.deps.reinit = true;
    entered(await enterBuild(s.deps, {}));
    expect(s.checkCalls).toHaveLength(2); expect(s.git.commits).toHaveLength(2); expect(stages).toEqual(["check", "commit", "check", "commit"]);
  });

  test("a durable marker restores an init killed before its check append, then reruns it once", async () => {
    const s = setupLoop(undefined, { initRecorded: false }); const base = s.deps.runCheck!;
    const interruptedHead = "b".repeat(40); let interrupted = true;
    s.deps.runCheck = async (acceptance, options) => {
      if (options.phase === "init" && interrupted) {
        interrupted = false; s.git.head = interruptedHead; s.git.status = " M half-generated.txt";
        throw new Error("process killed during init");
      }
      const result = await base(acceptance, options);
      if (options.phase === "init") s.git.status = " M generated.txt";
      return result;
    };

    await expect(enterBuild(s.deps, {})).rejects.toThrow("process killed during init");
    const marker = join(s.deps.run.dir, "init-start.json");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ version: 1, runId: s.deps.run.id, beforeHead: HEAD, priorCheckSeq: 0, reinit: false });
    expect(s.record.read().filter((event) => event.t === "check" && event.phase === "init")).toHaveLength(0);

    entered(await enterBuild(s.deps, {}));
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toContainEqual({ method: "checkoutAndClean", dir: s.project.repo, restoreRef: HEAD });
    expect(s.checkCalls.map((call) => call.phase)).toEqual(["init"]);
    expect(s.git.commits.map((commit) => commit.options.message)).toEqual(["chore(init)"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("an interrupted explicit reinit reruns from its own marker even when an older init check and commit exist", async () => {
    const s = setupLoop();
    await s.git.commit(s.project.repo, { message: "chore(init)", trailers: { "Kiln-Init": s.deps.run.id, "Kiln-Run": s.deps.run.id } });
    const beforeHead = s.git.head; const base = s.deps.runCheck!; let interrupted = true;
    s.deps.runCheck = async (acceptance, options) => {
      if (options.phase === "init" && interrupted) {
        interrupted = false; s.git.head = "c".repeat(40); s.git.status = " M half-reinit.txt";
        throw new Error("process killed during reinit");
      }
      const result = await base(acceptance, options);
      if (options.phase === "init") s.git.status = " M regenerated.txt";
      return result;
    };
    s.deps.reinit = true;

    await expect(enterBuild(s.deps, {})).rejects.toThrow("process killed during reinit");
    expect(JSON.parse(readFileSync(join(s.deps.run.dir, "init-start.json"), "utf8"))).toMatchObject({ beforeHead, reinit: true });
    s.deps.reinit = false;
    entered(await enterBuild(s.deps, {}));

    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toContainEqual({ method: "checkoutAndClean", dir: s.project.repo, restoreRef: beforeHead });
    expect(s.record.read().filter((event) => event.t === "check" && event.phase === "init")).toHaveLength(2);
    expect(s.git.commits.map((commit) => commit.options.message)).toEqual(["chore(init)", "chore(init)"]);
  });

  test("a dirty tree before a first init is an integrity failure and later dirt is discarded at the resume point", async () => {
    const dirty = setupLoop(undefined, { initRecorded: false }); dirty.git.status = " M user-work";
    expect(await enterBuild(dirty.deps, {})).toMatchObject({ exit: { outcome: "failed", failureClass: "integrity" } });
    expect(dirty.checkCalls).toHaveLength(0);
    expect(dirty.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);

    // Once init is committed, dirt with no session behind it is orphaned work and is discarded with its stat.
    const orphaned = setupLoop();
    await orphaned.git.commit(orphaned.project.repo, { message: "chore(init)", trailers: { "Kiln-Init": orphaned.deps.run.id, "Kiln-Run": orphaned.deps.run.id } });
    orphaned.git.status = " M stray.ts"; orphaned.git.diffText = " stray.ts | 3 +++";
    expect(entered(await enterBuild(orphaned.deps, {})).discardStat).toBe(" stray.ts | 3 +++");
    expect(orphaned.git.calls.filter((call) => call.method === "checkoutAndClean")).toEqual([{ method: "checkoutAndClean", dir: orphaned.project.repo, restoreRef: undefined }]);
    expect(orphaned.git.commits).toHaveLength(1);

    const failed = setupLoop(); attempt(failed, 1, "verify_failed"); failed.git.diffText = " file.ts | 2 +-";
    expect(entered(await enterBuild(failed.deps, {})).discardStat).toBe("file.ts | 2 +-");
    expect(failed.git.calls.filter((call) => call.method === "checkoutAndClean")).toEqual([{ method: "checkoutAndClean", dir: failed.project.repo, restoreRef: HEAD }]);

    const inFlight = setupLoop(); inFlight.git.status = " M work.ts";
    inFlight.record.append({ t: "feature.pick", featureId: "f01", attempt: 1, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
    inFlight.record.append({ t: "builder.session", featureId: "f01", attempt: 1, arm: "fresh", ...builderResult(), exitReasons: [] });
    entered(await enterBuild(inFlight.deps, {}));
    expect(inFlight.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);
    expect(readStatus(inFlight.deps.run)).toMatchObject({ cursor: { featureId: "f01", attempt: 1, step: "lock" } });
  });

  test("restores a failed attempt only while nothing has been picked since, and before a reinit", async () => {
    // A later in-flight session's uncommitted work is never touched.
    const inFlight = setupLoop(); attempt(inFlight, 1, "verify_failed"); inFlight.git.status = " M work.ts";
    inFlight.record.append({ t: "feature.pick", featureId: "f01", attempt: 2, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
    inFlight.record.append({ t: "builder.session", featureId: "f01", attempt: 2, arm: "fresh", ...builderResult(), exitReasons: [] });
    expect(entered(await enterBuild(inFlight.deps, {})).discardStat).toBeUndefined();
    expect(inFlight.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);
    expect(inFlight.git.status).toBe(" M work.ts");

    // A later pick alone already ends the restore window.
    const picked = setupLoop(); attempt(picked, 1, "verify_failed");
    picked.record.append({ t: "feature.pick", featureId: "f01", attempt: 2, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
    entered(await enterBuild(picked.deps, {}));
    expect(picked.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);

    // reinit after a failed attempt: restore first, init on the clean tree, and the chore(init) commit stays HEAD.
    const reinit = setupLoop(); attempt(reinit, 1, "verify_failed"); reinit.git.status = " M crashed.ts"; reinit.git.diffText = " crashed.ts | 1 +";
    const base = reinit.deps.runCheck!;
    reinit.deps.runCheck = async (acceptance, options) => { const result = await base(acceptance, options); if (options.phase === "init") reinit.git.status = " M generated.txt"; return result; };
    reinit.deps.reinit = true;
    expect(entered(await enterBuild(reinit.deps, {})).discardStat).toBe("crashed.ts | 1 +");
    const methods = reinit.git.calls.map((call) => call.method);
    expect(methods.indexOf("checkoutAndClean")).toBeLessThan(methods.indexOf("commit"));
    expect(reinit.checkCalls.map((call) => call.phase)).toEqual(["init"]);
    expect(reinit.git.commits.map((commit) => commit.options.message)).toEqual(["chore(init)"]);
    expect(reinit.git.head).toBe(reinit.git.commits[0]!.sha);
  });

  test("replays an incomplete sweep and continues past a still-partial rerun as a recorded degradation", async () => {
    const s = setupLoop([feature("f01"), feature("f02")]); const swept: Array<{ trigger: string; passed: string[] }> = [];
    s.record.append({ t: "sweep", featureId: "f02", planned: 1, run: 0, skipped: ["f01"], durationMs: 1, complete: false, scope: "partial" });
    s.deps.runSweep = async (_deps, passed, options) => { swept.push({ trigger: options.triggerFeatureId, passed: passed.map((value) => value.id) }); return { regressed: [], scope: "full", skipped: [], seconds: 0.001 }; };
    entered(await enterBuild(s.deps, {}));
    expect(swept).toEqual([{ trigger: "f02", passed: [] }]);

    // Ruling L10: a partial sweep is replayed, never a stop; the loop's precheck weighs the wall on its own.
    const partial = setupLoop(); let reruns = 0;
    partial.record.append({ t: "sweep", featureId: "f01", planned: 1, run: 0, skipped: ["f02"], durationMs: 1, complete: false, scope: "partial" });
    partial.deps.runSweep = async () => { reruns += 1; return { regressed: [], scope: "partial", skipped: ["f02"], seconds: 0.001 }; };
    entered(await enterBuild(partial.deps, {}));
    expect(reruns).toBe(1);
    expect(partial.record.read().some((event) => event.t === "stop")).toBe(false);
    expect(readStatus(partial.deps.run)).toMatchObject({ state: "running", cursor: { step: "lock" } });
  });

  test("removes a stale git index lock at entry and notes it exactly once", async () => {
    const s = setupLoop(); const lock = join(s.project.repo, ".git", "index.lock");
    mkdirSync(dirname(lock), { recursive: true }); writeFileSync(lock, "");
    entered(await enterBuild(s.deps, {}));
    expect(existsSync(lock)).toBe(false);
    expect(s.record.read().filter((event) => event.t === "note")).toEqual([expect.objectContaining({ text: expect.stringContaining(lock) })]);
    expect(s.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);

    entered(await enterBuild(s.deps, {}));
    expect(s.record.read().filter((event) => event.t === "note")).toHaveLength(1);
  });

  test("a reinit after a failed attempt closes the restore window, so a crash before the next pick never orphans chore(init)", async () => {
    const s = setupLoop(); attempt(s, 1, "verify_failed"); s.git.status = " M crashed.ts"; s.git.diffText = " crashed.ts | 1 +";
    const base = s.deps.runCheck!;
    s.deps.runCheck = async (acceptance, options) => { const result = await base(acceptance, options); if (options.phase === "init") s.git.status = " M generated.txt"; return result; };
    s.deps.reinit = true;
    entered(await enterBuild(s.deps, {}));
    const initSha = s.git.commits[0]!.sha;
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toEqual([{ method: "checkoutAndClean", dir: s.project.repo, restoreRef: HEAD }]);
    expect(s.git.head).toBe(initSha);

    // The process dies before the next pick; the resume must not reset to the failed attempt's beforeHead again.
    s.deps.reinit = false;
    entered(await enterBuild(s.deps, {}));
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toHaveLength(1);
    expect(s.git.head).toBe(initSha);
    expect(s.checkCalls.map((call) => call.phase)).toEqual(["init"]);
    expect(s.git.commits.map((commit) => commit.options.message)).toEqual(["chore(init)"]);
  });

  test("blocks a feature declared unsatisfiable twice before the crash and archives it", async () => {
    const s = setupLoop(); attempt(s, 1, "verify_failed", ["one"]); attempt(s, 2, "verify_failed", ["two"]);
    entered(await enterBuild(s.deps, {}));
    expect(foldState(s.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "declared_unsatisfiable" });
    expect(parseProgress(readFileSync(s.project.progress, "utf8")).some((entry) => entry.entryId === "declared_unsatisfiable")).toBe(true);
    expect(existsSync(`${s.project.blockedDir}/f01/manifest.json`)).toBe(true);
  });

  test("repairs a blocked-state prefix whose archive manifest did not land, without duplicating the transition", async () => {
    const s = setupLoop();
    expect(() => appendRecordedState(s.deps.run, s.record, { t: "feature.state", featureId: "f01", from: "pending", to: "blocked", attempts: 0, repairs: 0, reason: "attempts_exhausted" }, {
      afterState: () => { throw new Error("process killed after blocked state append"); },
    })).toThrow("process killed after blocked state append");
    const manifest = join(s.project.blockedDir, "f01", "manifest.json");
    expect(existsSync(manifest)).toBe(false);
    expect(s.record.read().filter((event) => event.t === "feature.state" && event.featureId === "f01" && event.to === "blocked")).toHaveLength(0);

    entered(await enterBuild(s.deps, {}));
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({ version: 1, featureId: "f01", check: { present: false }, audit: { present: false } });
    expect(s.record.read().filter((event) => event.t === "feature.state" && event.featureId === "f01" && event.to === "blocked")).toHaveLength(1);

    const first = readFileSync(manifest, "utf8");
    entered(await enterBuild(s.deps, {}));
    expect(readFileSync(manifest, "utf8")).toBe(first);
  });
});
