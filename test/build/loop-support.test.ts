import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { BuildStepCrash, appendAttempt, block, boundary, consecutive, elapsedByPhase, enforceFailureCap, outstanding, restoreFailed, spentByPhase, stateProgress } from "../../src/build/loop-support";
import { elapsedByPhase as coreElapsedByPhase, spentByPhase as coreSpentByPhase } from "../../src/core/budget";
import { parseProgress } from "../../src/build/progress";
import { foldState } from "../../src/build/state";
import { readStatus } from "../../src/core/run";
import { builderResult, feature, setupLoop, type LoopFixture } from "./loop-fixture";

const f01 = feature();

function pick(s: LoopFixture, attempt: number, featureBudgetUsd = 5) {
  s.record.append({ t: "feature.pick", featureId: "f01", attempt, phaseBudgetUsd: 10, featureBudgetUsd });
}

describe("loop support", () => {
  test("re-exports the shared phase ledgers from core/budget", () => {
    expect(spentByPhase).toBe(coreSpentByPhase);
    expect(elapsedByPhase).toBe(coreElapsedByPhase);
  });

  test("boundary writes the cursor hint and metrics, and wraps a hook failure as the boundary's crash", async () => {
    const s = setupLoop(); const seen: Array<[number, string]> = [];
    s.deps.stepHook = (index, name) => { seen.push([index, name]); if (index === 5) throw new Error("kill"); };
    await boundary(s.deps, 2, "f01", 1);
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "build", state: "running", cursor: { featureId: "f01", attempt: 1, step: "pick" } });
    expect(existsSync(s.deps.run.metrics)).toBe(true);
    let error: unknown;
    try { await boundary(s.deps, 5); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(BuildStepCrash);
    expect(error).toMatchObject({ index: 5, boundary: "check", originalCause: new Error("kill") });
    expect(seen).toEqual([[2, "pick"], [5, "check"]]);
  });

  test("appendAttempt writes one final attempt per pick and sums the seat costs", () => {
    const s = setupLoop();
    appendAttempt(s.deps, "fresh", f01, 1, builderResult({ costUsd: 0.25, exitReasons: ["declared"] }), 0.5, { disposition: "passed", counted: true, declarationOverruled: true });
    appendAttempt(s.deps, "fresh", f01, 1, builderResult(), 0, { disposition: "verify_failed", counted: true, declarationOverruled: false });
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([expect.objectContaining({ attempt: 1, disposition: "passed", builderCostUsd: 0.25, auditorCostUsd: 0.5, costUsd: 0.75, declaredUnsatisfiable: true, declarationOverruled: true })]);
  });

  test("outstanding is the latest pick without a final attempt for a feature still in play", () => {
    const s = setupLoop([feature("f01"), feature("f02")]);
    expect(outstanding(s.deps)).toBeUndefined();
    pick(s, 1); expect(outstanding(s.deps)).toEqual({ featureId: "f01", attempt: 1 });
    appendAttempt(s.deps, "fresh", f01, 1, builderResult(), 0, { disposition: "verify_failed", counted: true, declarationOverruled: false });
    expect(outstanding(s.deps)).toBeUndefined();
    s.record.append({ t: "feature.pick", featureId: "f02", attempt: 1, phaseBudgetUsd: 10 });
    block(s.deps, "f02", foldState(s.deps.run).f02!, "not_verifiable");
    expect(outstanding(s.deps)).toBeUndefined();
  });

  test("enforceFailureCap blocks at the pick's feature ceiling or the attempt cap and archives evidence", () => {
    const budget = setupLoop(); pick(budget, 1, 0.1);
    appendAttempt(budget.deps, "fresh", f01, 1, builderResult({ costUsd: 0.2 }), 0, { disposition: "verify_failed", counted: true, declarationOverruled: false });
    expect(enforceFailureCap(budget.deps, "f01", 1, 1)).toBe(true);
    expect(foldState(budget.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "feature_budget" });
    expect(existsSync(`${budget.project.blockedDir}/f01/manifest.json`)).toBe(true);

    const attempts = setupLoop(); pick(attempts, 1);
    expect(enforceFailureCap(attempts.deps, "f01", 1, attempts.deps.cfg.build.maxAttempts - 1)).toBe(false);
    expect(foldState(attempts.deps.run).f01.blocked).toBeUndefined();
    expect(enforceFailureCap(attempts.deps, "f01", 1, attempts.deps.cfg.build.maxAttempts)).toBe(true);
    expect(foldState(attempts.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "attempts_exhausted" });
    expect(attempts.record.read().find((event) => event.t === "feature.state")).toMatchObject({ to: "blocked", attempt: 1 });
  });

  test("restoreFailed resets to the session's starting head and reports the discarded stat", async () => {
    const s = setupLoop(); s.git.diffText = " file.ts | 2 +-\n"; const before = "c".repeat(40);
    expect(await restoreFailed(s.git, s.project, builderResult({ beforeHead: before }))).toBe("file.ts | 2 +-");
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toEqual([{ method: "checkoutAndClean", dir: s.project.repo, restoreRef: before }]);
    expect(s.git.head).toBe(before);
    s.git.diffText = "";
    expect(await restoreFailed(s.git, s.project, builderResult({ beforeHead: before }))).toBeUndefined();
  });

  test("stateProgress keys factual entries by kind and consecutive resets at a transient stop", () => {
    const s = setupLoop();
    stateProgress(s.deps, f01, 0, false, "missing_dependency:X");
    stateProgress(s.deps, f01, 1, false, "builder_transient", "attempt");
    expect(parseProgress(readFileSync(s.project.progress, "utf8")).map((entry) => entry.key)).toEqual(["f01:0:state:missing_dependency:X", "f01:1:attempt:attempt-1"]);

    const transient = { disposition: "transient", counted: false, declarationOverruled: false } as const;
    appendAttempt(s.deps, "fresh", f01, 1, builderResult(), 0, transient);
    appendAttempt(s.deps, "fresh", f01, 2, builderResult(), 0, transient);
    expect(consecutive(s.record.read(), "f01", ["transient"])).toBe(2);
    s.record.append({ t: "stop", stopKind: "transient" });
    expect(consecutive(s.record.read(), "f01", ["transient"])).toBe(0);
    appendAttempt(s.deps, "fresh", f01, 3, builderResult(), 0, transient);
    appendAttempt(s.deps, "fresh", f01, 4, builderResult(), 0, { disposition: "verify_failed", counted: true, declarationOverruled: false });
    expect(consecutive(s.record.read(), "f01", ["transient"])).toBe(0);
    expect(consecutive(s.record.read(), "f01", ["transient", "verify_failed"])).toBe(2);
  });
});
