import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { derivedCaps } from "../../src/formation/features";
import { foldState } from "../../src/build/state";
import { runBuild, runBuildSingleSession } from "../../src/phases/build";
import { parseProgress } from "../../src/build/progress";
import { readStatus } from "../../src/core/run";
import { saveConfig } from "../../src/core/config";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { builderResult, feature, setupLoop } from "./loop-fixture";

describe("build loop", () => {
  test("cancellation at a durable boundary stops before attempt evidence", async () => {
    const s = setupLoop();
    const control = new RunControl();
    s.deps.stepHook = (index) => { if (index === 2) control.cancel("stop at pick boundary"); };
    await expect(withRunControl(control, () => runBuild(s.deps))).rejects.toBeInstanceOf(RunCancelledError);
    expect(s.record.read().some((event) => event.t === "attempt" || event.t === "feature.state" || event.t === "phase.end")).toBe(false);
  });

  test("a manual answer resolving with cancellation cannot record a human decision", async () => {
    const s = setupLoop([feature("f01", { type: "manual", instructions: "look" })]);
    const control = new RunControl();
    await expect(withRunControl(control, () => runBuild(s.deps, { ask: async () => {
      control.cancel("cancel manual prompt");
      return "yes";
    } }))).rejects.toBeInstanceOf(RunCancelledError);
    expect(s.record.read().some((event) => event.t === "feature.state" || event.t === "phase.end")).toBe(false);
  });

  test("runs the eleven durable stages, authenticates its commit, records state, progress and metrics", async () => {
    const s = setupLoop(); const boundaries: number[] = [];
    s.deps.stepHook = (index) => { boundaries.push(index); };
    const result = await runBuild(s.deps);
    expect(result).toEqual({ outcome: "ok" });
    expect(boundaries).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(s.builderCalls).toEqual(["f01"]); expect(s.auditCalls).toEqual(["f01"]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1, passSource: "executed" });
    expect(s.record.read().filter((event) => event.t === "builder.session")).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "attempt")).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "feature.state" && event.to === "passed")).toHaveLength(1);
    expect(s.git.commits[0]?.options.trailers).toMatchObject({ "Kiln-Feature": "f01", "Kiln-Run": s.deps.run.id, "Kiln-Attempt": 1, "Kiln-Check": "check-1" });
    expect(parseProgress(readFileSync(s.project.progress, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(s.deps.run.metrics, "utf8"))).toMatchObject({ featuresPassed: { executed: 1 }, builderSessions: 1 });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "reflect", state: "running" });
  });

  test("blocks a missing dependency before a pick or builder and writes factual progress/archive", async () => {
    const s = setupLoop([feature("f01", { type: "shell", command: "missing-kiln-command", needs: ["KILN_MISSING_DEPENDENCY_X"] })]);
    const result = await runBuild(s.deps);
    expect(result).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
    expect(s.builderCalls).toHaveLength(0);
    expect(s.record.read().filter((event) => event.t === "feature.pick")).toHaveLength(0);
    expect(s.record.read().filter((event) => event.t === "attempt")).toHaveLength(0);
    expect(foldState(s.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "missing_dependency:KILN_MISSING_DEPENDENCY_X", attempts: 0 });
    expect(parseProgress(readFileSync(s.project.progress, "utf8"))[0]).toMatchObject({ featureId: "f01", attempt: 0 });
    expect(existsSync(join(s.project.blockedDir, "f01", "manifest.json"))).toBe(true);
  });

  test("a reversible dependency block records its unblock before the next real attempt", async () => {
    const name = "KILN_DYNAMIC_BUILD_DEP";
    const s = setupLoop([feature("f01", { type: "file", path: "f01.txt", needs: [name] })]);
    delete process.env[name];
    try {
      expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
      process.env[name] = "ready";
      expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
      expect(s.record.read().some((event) => event.t === "feature.state" && event.from === "blocked" && event.to === "pending")).toBe(true);
      expect(readFileSync(s.project.progress, "utf8")).toContain("unblocked:missing_dependency");
    } finally { delete process.env[name]; }
  });

  test("manual yes passes as human with no fake builder/attempt; autonomous blocks factually", async () => {
    const manual = feature("f01", { type: "manual", instructions: "look" });
    const human = setupLoop([manual]);
    expect(await runBuild(human.deps, { ask: async () => "yes" })).toEqual({ outcome: "ok" });
    expect(foldState(human.deps.run).f01).toMatchObject({ passes: true, passSource: "human", attempts: 0 });
    expect(human.record.read().some((event) => event.t === "builder.session" || event.t === "attempt")).toBe(false);
    expect(parseProgress(readFileSync(human.project.progress, "utf8"))).toHaveLength(1);

    const autonomous = setupLoop([manual]); autonomous.deps.cfg.autonomous = true; saveConfig(autonomous.home, autonomous.deps.cfg);
    expect(await runBuild(autonomous.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });
    expect(foldState(autonomous.deps.run).f01).toMatchObject({ blockedReason: "not_verifiable", attempts: 0 });
    expect(parseProgress(readFileSync(autonomous.project.progress, "utf8"))).toHaveLength(1);
  });

  test("checks both declarations, blocks on the second, and reserves honest exit for zero executed passes", async () => {
    const s = setupLoop(); s.checkOutcomes.push(false, false);
    s.builderResults.push(builderResult({ stopped: "exit", exitReasons: ["reason one"] }), builderResult({ stopped: "exit", exitReasons: ["reason two"] }));
    const result = await runBuild(s.deps);
    expect(result).toEqual({ outcome: "honest_exit", kind: "cannot_be_satisfied", reasons: ["reason one", "reason two"] });
    expect(s.builderCalls).toHaveLength(2);
    expect(foldState(s.deps.run).f01).toMatchObject({ blockedReason: "declared_unsatisfiable", attempts: 2 });
    expect(s.record.read().filter((event) => event.t === "attempt" && event.declaredUnsatisfiable)).toHaveLength(2);
  });

  test("an unchanged budget stop is idempotent and a larger target resumes without a phantom call", async () => {
    const s = setupLoop(); s.deps.cfg.budgets.usd = 1; saveConfig(s.home, s.deps.cfg);
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "budget" });
    const events = s.record.read().length;
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "budget" });
    expect(s.record.read()).toHaveLength(events); expect(s.builderCalls).toHaveLength(0);
    s.deps.cfg.budgets.usd = 50; saveConfig(s.home, s.deps.cfg);
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.builderCalls).toHaveLength(1);
  });

  test("an unchanged deadline stop is idempotent and resumes only after the wall target grows", async () => {
    const s = setupLoop(); s.deps.cfg.budgets.wallSeconds = 0; saveConfig(s.home, s.deps.cfg);
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    const events = s.record.read().length;
    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(s.record.read()).toHaveLength(events); expect(s.builderCalls).toHaveLength(0);
    s.deps.cfg.budgets.wallSeconds = 20_000; saveConfig(s.home, s.deps.cfg);
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
  });

  test("single-session arm creates one persistent driver with equal aggregate caps", async () => {
    const s = setupLoop([feature("f01"), feature("f02")]); let creates = 0; const options: any[] = [];
    s.deps.createDriver = (_deps, value) => {
      creates += 1; options.push(value);
      return { spentUsd: 0, turns: 0, runFeature: async (current) => { s.builderCalls.push(current.id); return builderResult(); } };
    };
    expect(await runBuildSingleSession(s.deps)).toEqual({ outcome: "ok" });
    expect(creates).toBe(1); expect(s.builderCalls).toEqual(["f01", "f02"]);
    const aggregate = derivedCaps(s.deps.cfg).maxFeatures * s.deps.cfg.build.expectedAttempts;
    expect(options[0]).toMatchObject({ turnCap: s.deps.cfg.build.sessionTurnCap * aggregate, usdCap: s.deps.cfg.build.builderUsdCap * aggregate });
    expect(s.record.read().filter((event) => event.t === "attempt").map((event) => event.t === "attempt" && event.arm)).toEqual(["single_session", "single_session"]);
  });

  test("single-session resume counts recorded builder calls even without a completed session", async () => {
    const s = setupLoop();
    const call = (role: "builder" | "auditor", costUsd: number) => s.record.append({
      t: "model.call", role, provider: "mock", model: role, inputHash: role,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd, stopReason: "stop", excerpt: "",
    });
    s.record.append({ t: "turn", role: "builder", phase: "build", n: 1 });
    s.record.append({ t: "turn", role: "builder", phase: "build", n: 2 });
    s.record.append({ t: "turn", role: "auditor", phase: "build", n: 1 });
    call("builder", 0.2); call("builder", 0.3); call("auditor", 9);
    let priorCost = -1; let priorTurns = -1;
    s.deps.createDriver = (_deps, options) => {
      priorCost = options.priorSpentUsd?.() ?? 0;
      priorTurns = options.priorTurns?.() ?? 0;
      return { spentUsd: 0, turns: 0, runFeature: async () => builderResult() };
    };
    expect(await runBuildSingleSession(s.deps)).toEqual({ outcome: "ok" });
    expect(priorCost).toBeCloseTo(0.5, 12);
    expect(priorTurns).toBe(2);
  });
});
