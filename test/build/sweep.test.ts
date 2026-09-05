import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { regressionSweep } from "../../src/build/sweep";
import { appendRecordedState, foldState } from "../../src/build/state";
import { foldBuildMetrics } from "../../src/build/metrics";
import { runBuild } from "../../src/build/loop";
import { parseProgress } from "../../src/build/progress";
import { runCheck } from "../../src/build/verify";
import { feature, setupLoop } from "./loop-fixture";

function pass(s: ReturnType<typeof setupLoop>, id: string, repairs = 0): void {
  appendRecordedState(s.deps.run, s.record, { t: "feature.state", featureId: id, from: "pending", to: "passed", source: "executed", attempts: 1, repairs, commitSha: `${id}-pass` });
}

describe("regression sweep", () => {
  test("uses the last passing duration formula and records a regression in state, record, and metrics", async () => {
    const s = setupLoop([feature("f01"), feature("f02")]); pass(s, "f01");
    s.record.append({ t: "check", checkId: "prior", featureId: "f01", attempt: 1, kind: "file", phase: "acceptance", ok: true, durationMs: 3_000, overrunMs: 0, timedOut: false, outputPath: "prior", outputTruncated: false });
    s.checkOutcomes.push(false);
    const result = await regressionSweep(s.deps, [s.features.features[0]!], { project: s.project, triggerFeatureId: "f02", remainingWallSeconds: 100, check: s.deps.runCheck });
    expect(result).toEqual({ regressed: ["f01"], scope: "full", skipped: [], seconds: expect.any(Number) });
    expect(s.checkCalls[0]?.timeoutMs).toBe(6_000);
    expect(foldState(s.deps.run).f01).toMatchObject({ state: "regressed", attempts: 0, repairs: 1, regressedBy: "f02" });
    expect(s.record.read().some((event) => event.t === "feature.state" && event.to === "regressed")).toBe(true);
    expect(foldBuildMetrics(s.deps.run).regressionsCaught).toBe(1);
    expect(parseProgress(readFileSync(s.project.progress, "utf8"))[0]?.text).toContain("regressed_by:f02");
  });

  test("a partial sweep keeps every ever-regressed feature plus the most recent passing feature", async () => {
    const fs = ["f01", "f02", "f03", "f04"].map((id) => feature(id)); const s = setupLoop(fs);
    pass(s, "f01");
    appendRecordedState(s.deps.run, s.record, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 0, repairs: 1, regressedBy: "f04" });
    appendRecordedState(s.deps.run, s.record, { t: "feature.state", featureId: "f01", from: "regressed", to: "passed", source: "executed", attempts: 1, repairs: 1, commitSha: "repair" });
    for (const id of ["f02", "f03", "f04"]) pass(s, id);
    const result = await regressionSweep(s.deps, fs, { project: s.project, triggerFeatureId: "new", remainingWallSeconds: 60, check: s.deps.runCheck });
    expect(result.scope).toBe("partial");
    expect(s.checkCalls.map((call) => call.featureId)).toEqual(["f01", "f04"]);
    expect(result.skipped).toEqual(["f02", "f03"]);
  });

  test("does not dispatch below five seconds and records that skip with its reason, not as a partial scope", async () => {
    // A one-second projection keeps the plan full, so only the dispatch floor skips the check.
    const s = setupLoop(); pass(s, "f01"); s.deps.cfg.build.expectedCheckSeconds = 1;
    let calls = 0;
    const skipped = await regressionSweep(s.deps, [s.features.features[0]!], { project: s.project, triggerFeatureId: "f02", remainingWallSeconds: 4.9, check: async (...args) => { calls += 1; return s.deps.runCheck!(...args); } });
    expect(calls).toBe(0); expect(skipped).toMatchObject({ scope: "full", skipped: ["f01"] });
    expect(s.record.read().findLast((event) => event.t === "sweep")).toMatchObject({ featureId: "f02", scope: "full", complete: false, skipped: ["f01"], run: 0 });
    expect(s.record.read().flatMap((event) => event.t === "note" ? [event.text] : [])).toEqual([expect.stringMatching(/f01.*wall/)]);
  });

  test("a dependency the check cannot satisfy is a recorded skip with its reason, not a partial scope", async () => {
    const s = setupLoop(); pass(s, "f01");
    const result = await regressionSweep(s.deps, [s.features.features[0]!], { project: s.project, triggerFeatureId: "f02", remainingWallSeconds: 100, needs: ["KILN_WAVE2_ABSENT_DEPENDENCY"], check: runCheck });
    expect(result).toMatchObject({ regressed: [], scope: "full", skipped: ["f01"] });
    expect(s.record.read().findLast((event) => event.t === "check")).toMatchObject({ featureId: "f01", phase: "regression", notRunReason: "missing_dependency:KILN_WAVE2_ABSENT_DEPENDENCY" });
    expect(s.record.read().findLast((event) => event.t === "sweep")).toMatchObject({ scope: "full", complete: false, skipped: ["f01"] });
    expect(s.record.read().flatMap((event) => event.t === "note" ? [event.text] : [])).toEqual([expect.stringContaining("missing_dependency:KILN_WAVE2_ABSENT_DEPENDENCY")]);
    expect(foldState(s.deps.run).f01).toMatchObject({ state: "passed", passes: true });
  });

  test("allows maxRegressionRepairs repairs and blocks on the regression that would need one more", async () => {
    const s = setupLoop(); pass(s, "f01", 1); const f01 = s.features.features[0]!; const manifest = join(s.project.blockedDir, "f01", "manifest.json");
    s.checkOutcomes.push(false);
    await regressionSweep(s.deps, [f01], { project: s.project, triggerFeatureId: "f02", remainingWallSeconds: 100, check: s.deps.runCheck });
    expect(foldState(s.deps.run).f01).toMatchObject({ state: "regressed", blocked: undefined, attempts: 0, repairs: 2 });
    expect(existsSync(manifest)).toBe(false);

    appendRecordedState(s.deps.run, s.record, { t: "feature.state", featureId: "f01", from: "regressed", to: "passed", source: "executed", attempts: 1, repairs: 2, commitSha: "repair-2" });
    s.checkOutcomes.push(false);
    await regressionSweep(s.deps, [f01], { project: s.project, triggerFeatureId: "f03", remainingWallSeconds: 100, check: s.deps.runCheck });
    expect(foldState(s.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "regression_unrepairable", attempts: 0, repairs: 3 });
    expect(existsSync(manifest)).toBe(true);
    expect(parseProgress(readFileSync(s.project.progress, "utf8")).some((entry) => entry.text.includes("regression_unrepairable"))).toBe(true);
  });

  test("an incomplete prior sweep is rerun at the next build entry", async () => {
    const s = setupLoop(); let sweeps = 0;
    s.record.append({ t: "sweep", featureId: "previous", planned: 1, run: 0, skipped: ["f00"], durationMs: 1, complete: false, scope: "partial" });
    s.deps.runSweep = async (_deps, passed, options) => { sweeps += 1; s.record.append({ t: "sweep", featureId: options.triggerFeatureId, planned: passed.length, run: passed.length, skipped: [], durationMs: 1, complete: true, scope: "full" }); return { regressed: [], scope: "full", skipped: [], seconds: 0.001 }; };
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(sweeps).toBe(2); // entry rerun, then the newly passed feature's sweep
  });
});
