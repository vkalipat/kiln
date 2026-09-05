import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBuild } from "../../src/build/loop";
import { AuditorRunError } from "../../src/build/auditor";
import { foldState } from "../../src/build/state";
import { parseProgress } from "../../src/build/progress";
import { readStatus, writeStatus } from "../../src/core/run";
import { saveConfig } from "../../src/core/config";
import { builderResult, feature, setupLoop } from "./loop-fixture";

const dispositions = (s: ReturnType<typeof setupLoop>) => s.record.read().flatMap((event) => event.t === "attempt" ? [event.disposition] : []);

describe("build loop failures and resume", () => {
  test("runs init once at 600 seconds, commits its changes, and rejects a dirty first entry", async () => {
    const s = setupLoop(undefined, { initRecorded: false }); const base = s.deps.runCheck!;
    s.deps.runCheck = async (acceptance, options) => {
      const result = await base(acceptance, options);
      if (options.phase === "init") s.git.status = " M generated.txt";
      return result;
    };
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.checkCalls.map((call) => call.phase)).toEqual(["init", "acceptance"]);
    expect(s.checkCalls[0]).toMatchObject({ cwd: s.project.repo, timeoutMs: 600_000 });
    expect(s.git.commits[0]?.options).toMatchObject({ message: "chore(init)", trailers: { "Kiln-Init": s.deps.run.id } });
    expect(s.record.read().filter((event) => event.t === "check" && event.phase === "init")).toHaveLength(1);

    const nonterminal = setupLoop(undefined, { initRecorded: false }); nonterminal.checkOutcomes.push(false, true);
    expect(await runBuild(nonterminal.deps)).toEqual({ outcome: "ok" });
    expect(nonterminal.record.read().find((event) => event.t === "check" && event.phase === "init")).toMatchObject({ ok: false, exitCode: 1 });

    const dirty = setupLoop(undefined, { initRecorded: false }); dirty.git.status = " M user-work";
    expect(await runBuild(dirty.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(dirty.checkCalls).toHaveLength(0);
  });

  test("discards a failed attempt's work once and records its stat in that attempt's entry only", async () => {
    const s = setupLoop(); const baseBuilder = s.deps.runBuilder!; let calls = 0;
    s.checkOutcomes.push(false, true);
    s.git.diffText = " file.ts | 2 +-";
    s.deps.runBuilder = async (...args) => { calls += 1; const result = await baseBuilder(...args); if (calls === 1) s.git.status = " M file.ts"; return result; };
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toHaveLength(1);
    const progress = parseProgress(readFileSync(s.project.progress, "utf8"));
    expect(progress.map((entry) => entry.key)).toEqual(["f01:1:attempt:attempt-1", "f01:2:attempt:attempt-2"]);
    expect(progress[0]?.text).toContain("discard: file.ts | 2 +-");
    expect(progress[1]?.text).not.toContain("discard:");
  });

  test("the pause window's transient stop precedes a budget stop and follows a deadline stop", async () => {
    const s = setupLoop(); s.deps.cfg.budgets.usd = 1; saveConfig(s.home, s.deps.cfg);
    s.deps.fetchUsage = async () => ({ used: 95, limit: 100, resetAt: "2026-09-05T00:00:00.000Z" });
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" }); expect(readStatus(s.deps.run)).toMatchObject({ state: "paused", pausedReason: "usage_limit" });
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(s.record.read().flatMap((event) => event.t === "stop" ? [event.stopKind] : [])).toEqual(["transient"]);
    expect(s.builderCalls).toHaveLength(0);

    const deadline = setupLoop(); deadline.deps.cfg.budgets.wallSeconds = 0; saveConfig(deadline.home, deadline.deps.cfg);
    deadline.deps.fetchUsage = async () => ({ used: 95, limit: 100 });
    expect(await runBuild(deadline.deps)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(deadline.record.read().some((event) => event.t === "pause")).toBe(false);
  });

  test("blocks immediately when a crossing attempt exceeds featureCeiling", async () => {
    const s = setupLoop(); s.deps.cfg.budgets.usd = 4; saveConfig(s.home, s.deps.cfg);
    s.checkOutcomes.push(false); s.builderResults.push(builderResult({ costUsd: 4 }));
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
    expect(foldState(s.deps.run).f01).toMatchObject({ blockedReason: "feature_budget", attempts: 1 });
    expect(s.builderCalls).toHaveLength(1);
  });

  test("genuine audit disagreement and final active-check void spend attempts and never commit", async () => {
    const disagree = setupLoop(); disagree.auditVerdicts.push("disagree", "disagree", "disagree");
    expect(await runBuild(disagree.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
    expect(disagree.record.read().filter((event) => event.t === "attempt").map((event) => event.t === "attempt" && event.disposition)).toEqual(["audit_disagreed", "audit_disagreed", "audit_disagreed"]);
    expect(disagree.git.commits).toHaveLength(0);

    const voided = setupLoop(); const baseAudit = voided.deps.runAuditor!;
    voided.deps.runAuditor = async (...args) => {
      const result = await baseAudit(...args);
      voided.record.append({ t: "audit.disposition", featureId: "f01", attempt: args[3].attempt, checkId: result.check.checkId, rawVerdict: "agree", effectiveVerdict: "agree", emptyDisagree: false, malformed: false, truncated: false, retried: false, evidenceUsable: false, checkVoided: true });
      return { ...result, effectiveVerdict: "agree", evidenceUsable: false, recoveredFromVoid: true, finalCheckVoided: true, checkVoided: true };
    };
    expect(await runBuild(voided.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
    expect(voided.git.commits).toHaveLength(0);
    expect(voided.record.read().filter((event) => event.t === "attempt").every((event) => event.t !== "attempt" || event.disposition === "verify_failed")).toBe(true);
  });

  test("a passing check overrules a declaration and auditor error cost survives into the eventual attempt fold", async () => {
    const declared = setupLoop(); declared.builderResults.push(builderResult({ stopped: "exit", exitReasons: ["I cannot"], headMoved: true }));
    expect(await runBuild(declared.deps)).toEqual({ outcome: "ok" });
    expect(declared.record.read().find((event) => event.t === "attempt")).toMatchObject({ declaredUnsatisfiable: true, declarationOverruled: true, disposition: "passed" });
    expect(declared.record.read().some((event) => event.t === "failure" && event.class === "policy" && event.message.includes("moved HEAD"))).toBe(true);
    expect(declared.git.commits[0]?.options.allowEmpty).toBe(true);

    const errored = setupLoop(); const base = errored.deps.runAuditor!; let first = true;
    errored.deps.runAuditor = async (...args) => {
      if (first) {
        first = false;
        throw new AuditorRunError("auditor server", { text: "", turns: 1, stopped: "error", costUsd: 0.4, error: "auditor server", errorStatus: 500 }, 0.4, true, "audit");
      }
      return base(...args);
    };
    expect(await runBuild(errored.deps)).toEqual({ outcome: "ok" });
    const attempts = errored.record.read().filter((event) => event.t === "attempt");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ disposition: "transient", auditorCostUsd: 0.4, counted: false });
    expect(attempts[1]).toMatchObject({ disposition: "passed", counted: true });
  });

  test("commit failures are counted, progressed, and eventually archived", async () => {
    const s = setupLoop(); s.git.failMethod = "commit";
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
    expect(s.record.read().filter((event) => event.t === "attempt" && event.disposition === "commit_failed")).toHaveLength(3);
    expect(foldState(s.deps.run).f01).toMatchObject({ blockedReason: "attempts_exhausted", attempts: 3 });
    expect(parseProgress(readFileSync(s.project.progress, "utf8"))).toHaveLength(3);
  });

  test("three transient retries stop separately from three reactive usage pauses", async () => {
    const transient = setupLoop();
    transient.builderResults.push(...Array.from({ length: 3 }, () => builderResult({ stopped: "error", error: "server", errorStatus: 500 })));
    expect(await runBuild(transient.deps)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(foldState(transient.deps.run).f01).toMatchObject({ attempts: 0, blocked: undefined });
    expect(dispositions(transient)).toEqual(["transient", "transient", "transient"]);

    // Below the 95 percent boundary poll, only the builder's 429 pauses: reactively, after an uncounted attempt.
    const paused = setupLoop(); paused.deps.fetchUsage = async () => ({ used: 50, limit: 100, resetAt: "2026-09-05T00:00:00.000Z" });
    for (let index = 0; index < 3; index += 1) {
      paused.builderResults.push(builderResult({ stopped: "error", error: "rate", errorStatus: 429 }));
      const result = await runBuild(paused.deps);
      if (index < 2) { expect(result).toEqual({ outcome: "ok" }); expect(readStatus(paused.deps.run)).toMatchObject({ state: "paused", pausedReason: "usage_limit", wakeAt: "2026-09-05T00:00:00.000Z" }); }
      else expect(result).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    }
    expect(dispositions(paused)).toEqual(["paused", "paused", "paused"]);
    expect(paused.record.read().filter((event) => event.t === "pause")).toHaveLength(2);
    expect(foldState(paused.deps.run).f01).toMatchObject({ attempts: 0, blocked: undefined });
  });

  test("a boundary usage poll at 95 percent pauses before any pick and stops after three consecutive proactive pauses", async () => {
    const s = setupLoop([feature("f01"), feature("f02")]);
    s.deps.fetchUsage = async () => ({ used: 95, limit: 100, resetAt: "2026-09-05T00:00:00.000Z" });
    for (let index = 0; index < 2; index += 1) {
      expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
      expect(readStatus(s.deps.run)).toMatchObject({ state: "paused", pausedReason: "usage_limit", wakeAt: "2026-09-05T00:00:00.000Z" });
    }
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(s.record.read().filter((event) => event.t === "pause")).toHaveLength(2);
    expect(s.record.read().some((event) => event.t === "feature.pick" || event.t === "attempt")).toBe(false);
    expect(s.builderCalls).toHaveLength(0);

    // The window is consecutive: a pick between pauses restarts it, so the next proactive pause is a pause, not a stop.
    const reset = setupLoop([feature("f01"), feature("f02")]); let used = 95; const base = reset.deps.runBuilder!;
    reset.deps.fetchUsage = async () => ({ used, limit: 100 });
    reset.deps.runBuilder = async (...args) => { used = 95; return base(...args); };
    expect(await runBuild(reset.deps)).toEqual({ outcome: "ok" }); expect(await runBuild(reset.deps)).toEqual({ outcome: "ok" });
    used = 50;
    expect(await runBuild(reset.deps)).toEqual({ outcome: "ok" });
    expect(readStatus(reset.deps.run)).toMatchObject({ state: "paused", pausedReason: "usage_limit" });
    expect(reset.builderCalls).toEqual(["f01"]); expect(foldState(reset.deps.run).f01).toMatchObject({ passes: true });
    const pick = reset.record.read().find((event) => event.t === "feature.pick")!;
    expect(reset.record.read().filter((event) => event.t === "pause").map((event) => event.seq > pick.seq)).toEqual([false, false, true]);
    expect(reset.record.read().some((event) => event.t === "stop")).toBe(false);
  });

  test("lock and Git exceptions end with typed status and metrics instead of escaping", async () => {
    const lock = setupLoop(); writeFileSync(lock.deps.run.acceptanceLock, "{}\n");
    expect(await runBuild(lock.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(readStatus(lock.deps.run)).toMatchObject({ state: "failed", outcome: { failureClass: "integrity" } });
    expect(readFileSync(lock.deps.run.metrics, "utf8")).toContain('"featuresTotal"');

    const git = setupLoop(); git.git.failMethod = "log";
    expect(await runBuild(git.deps)).toMatchObject({ outcome: "failed", failureClass: "verify" });
    expect(readStatus(git.deps.run)).toMatchObject({ state: "failed", outcome: { failureClass: "verify" } });
  });

  test("shape drift fails before build phase.start", async () => {
    const s = setupLoop(); writeStatus(s.deps.run, { shape: "product", shapeHash: "frozen-shape" });
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(s.record.read().some((event) => event.t === "phase.start" && event.phase === "build")).toBe(false);
    expect(s.builderCalls).toHaveLength(0);
  });

  test("lock drift is terminal both immediately after the builder and immediately before the check", async () => {
    const postBuilder = setupLoop(); const base = postBuilder.deps.runBuilder!;
    postBuilder.deps.runBuilder = async (...args) => { const result = await base(...args); writeFileSync(postBuilder.deps.run.acceptanceLock, "{}\n"); return result; };
    expect(await runBuild(postBuilder.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(postBuilder.record.read().filter((event) => event.t === "builder.session")).toHaveLength(1);
    expect(postBuilder.record.read().filter((event) => event.t === "check" && event.phase === "acceptance")).toHaveLength(0);

    const precheck = setupLoop();
    precheck.deps.stepHook = (index) => { if (index === 4) writeFileSync(precheck.deps.run.acceptanceLock, "{}\n"); };
    expect(await runBuild(precheck.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(precheck.record.read().filter((event) => event.t === "check" && event.phase === "acceptance")).toHaveLength(0);
  });

  test("corrupt authoritative state still leaves a durable integrity failure and status when metrics cannot fold", async () => {
    const s = setupLoop(); writeFileSync(s.deps.run.featureState, "{corrupt\n");
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(s.record.read().some((event) => event.t === "failure" && event.class === "integrity")).toBe(true);
    expect(readStatus(s.deps.run)).toMatchObject({ state: "failed", outcome: { failureClass: "integrity" } });
  });

  test("a partial sweep is a recorded degradation: the run continues while wall remains and stops deadline only once it is gone", async () => {
    const partial = (s: ReturnType<typeof setupLoop>, onSweep: () => void = () => {}) => {
      s.deps.runSweep = async (_deps, passed, options) => {
        const skipped = passed.map((value) => value.id); onSweep();
        s.record.append({ t: "sweep", featureId: options.triggerFeatureId, planned: passed.length, run: 0, skipped, durationMs: 1, complete: false, scope: "partial" });
        return { regressed: [], scope: "partial", skipped, seconds: 0.001 };
      };
    };
    const continues = setupLoop([feature("f01"), feature("f02")]); partial(continues);
    expect(await runBuild(continues.deps)).toEqual({ outcome: "ok" });
    expect(continues.builderCalls).toEqual(["f01", "f02"]);
    expect(continues.record.read().flatMap((event) => event.t === "sweep" ? [event.scope] : [])).toEqual(["partial", "partial"]);
    expect(continues.record.read().some((event) => event.t === "stop")).toBe(false);

    const expired = setupLoop([feature("f01"), feature("f02")]); const start = Date.now(); let sweeps = 0;
    partial(expired, () => { sweeps += 1; });
    expired.deps.now = () => start + (sweeps > 0 ? (expired.deps.cfg.budgets.wallSeconds + 1) * 1_000 : 0);
    expect(await runBuild(expired.deps)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(expired.builderCalls).toEqual(["f01"]);
    expect(foldState(expired.deps.run).f01).toMatchObject({ passes: true });
    expect(expired.record.read().flatMap((event) => event.t === "stop" ? [event.stopKind] : [])).toEqual(["deadline"]);
  });

  test("a timed-out check is a counted deadline failure and the run continues", async () => {
    const s = setupLoop(); const base = s.deps.runCheck!; let first = true;
    s.deps.runCheck = async (acceptance, options) => {
      if (!first) return base(acceptance, options);
      first = false;
      const checkId = "timed-out"; const outputPath = join(s.project.checksDir, `${checkId}.txt`); writeFileSync(outputPath, "hung\n");
      options.record.append({ t: "check", checkId, featureId: options.featureId, attempt: options.attempt, kind: acceptance.type, phase: options.phase, ok: false, durationMs: 300_000, overrunMs: 12, timedOut: true, outputPath, outputTruncated: false });
      return { checkId, ok: false, kind: acceptance.type, durationMs: 300_000, overrunMs: 12, timedOut: true, output: "hung", outputPath, outputTruncated: false };
    };
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.record.read().filter((event) => event.t === "failure")).toEqual([expect.objectContaining({ class: "deadline", message: expect.stringContaining("timed-out") })]);
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([
      expect.objectContaining({ attempt: 1, disposition: "verify_failed", counted: true }),
      expect.objectContaining({ attempt: 2, disposition: "passed", counted: true }),
    ]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 2 });
    expect(parseProgress(readFileSync(s.project.progress, "utf8")).map((entry) => entry.key)).toEqual(["f01:1:attempt:attempt-1", "f01:2:attempt:attempt-2"]);
  });

  test("a wall expiry during the third transient attempt stops deadline, not transient", async () => {
    const s = setupLoop(); const start = Date.now(); let calls = 0; const base = s.deps.runBuilder!;
    s.builderResults.push(...Array.from({ length: 3 }, () => builderResult({ stopped: "error", error: "server", errorStatus: 500 })));
    s.deps.runBuilder = async (...args) => { calls += 1; return base(...args); };
    s.deps.now = () => start + (calls >= 3 ? (s.deps.cfg.budgets.wallSeconds + 1) * 1_000 : 0);
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(dispositions(s)).toEqual(["transient", "transient", "transient"]);
    expect(s.record.read().flatMap((event) => event.t === "stop" ? [event.stopKind] : [])).toEqual(["deadline"]);
  });
});
