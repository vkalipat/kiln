import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, PHASES, saveConfig } from "../../src/core/config";
import type { RecordEvent } from "../../src/core/events";
import { RunRecord } from "../../src/core/record";
import { createRun, writeStatus } from "../../src/core/run";
import type { FeaturesFile } from "../../src/formation/features";
import { projectPaths } from "../../src/formation/paths";
import { derivedCaps } from "../../src/formation/features";
import { ATTEMPT_DISPOSITIONS, foldBuildMetrics, writeMetrics, type Metrics } from "../../src/build/metrics";
import { appendState, type FeatureTransition } from "../../src/build/state";

const file: FeaturesFile = {
  version: 1,
  init: { needs: [] },
  features: [1, 2, 3, 4].map((number) => ({
    id: `f0${number}`, title: `Feature ${number}`, description: "d",
    acceptance: number === 2 ? { type: "manual", instructions: "look" } : { type: "file", path: `${number}.txt` },
  })),
};

test("attempt disposition inventory includes refusal", () => {
  expect(ATTEMPT_DISPOSITIONS).toContain("refused");
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-build-metrics-"));
  saveConfig(home, defaultConfig());
  const run = createRun(home, "seed");
  const project = projectPaths(run.project);
  mkdirSync(project.dir, { recursive: true });
  writeFileSync(run.features, `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(run.acceptanceLock, "{\"lock\":true}\n");
  writeFileSync(run.featureState, "");
  return { run, record: new RunRecord(run.record) };
}

function model(role: "builder" | "auditor" | "reflector", costUsd: number): RecordEvent {
  return { t: "model.call", role, provider: "p", model: role, inputHash: role, usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 }, costUsd, stopReason: "stop", excerpt: "typed" };
}

describe("build metrics", () => {
  test("recovers every binding metric from typed events, authoritative state and terminal status", () => {
    const { run, record } = setup();
    const state = (event: FeatureTransition) => { record.append(event); appendState(run, event); };
    record.append({ t: "phase.start", phase: "form" });
    record.append({ t: "formation.attempt", ideaId: "idea-a", attempt: 1 });
    record.append({ t: "critique", verdict: "revise", scopeCreep: [], unverifiable: [], missing: [], crossProvider: true, provider: "p", model: "critic", stopped: "usd_cap", costUsd: 0.1, usdCapHit: true });
    record.append({ t: "formation.revision", ideaId: "idea-a", attempt: 1 });
    record.append({ t: "critique", verdict: "ok", scopeCreep: [], unverifiable: [], missing: [], crossProvider: false, provider: "p", model: "critic", stopped: "done", costUsd: 0.1, usdCapHit: false });
    record.append({ t: "freeze", featureCount: 4, lockIdsHash: "ids", lockHash: "lock", manualCount: 1, executableCount: 3, needsUnion: [] });
    record.append({ t: "phase.end", phase: "form", outcome: "ok" });
    record.append({ t: "phase.start", phase: "build" });
    record.append(model("builder", 10.5));
    record.append(model("auditor", 1.5));
    state({ t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1 });
    state({ t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f04" });
    state({ t: "feature.state", featureId: "f01", from: "regressed", to: "blocked", attempts: 1, repairs: 1, reason: "attempts_exhausted" });
    record.append({ t: "feature.pick", featureId: "f04", attempt: 1, phaseBudgetUsd: 11.875, featureBudgetUsd: 3.327 });
    state({ t: "feature.state", featureId: "f01", from: "blocked", to: "pending", attempts: 1, repairs: 1 });
    state({ t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 2, repairs: 1 });
    state({ t: "feature.state", featureId: "f02", from: "pending", to: "passed", source: "human", attempts: 0 });
    state({ t: "feature.state", featureId: "f03", from: "pending", to: "blocked", attempts: 0, reason: "missing_dependency:PG_URL" });
    state({ t: "feature.state", featureId: "f04", from: "pending", to: "failed", attempts: 1, reason: "verify" });
    const attempt = (featureId: string, number: number, arm: "fresh" | "single_session", overrides: Partial<Extract<RecordEvent, { t: "attempt" }>> = {}) => record.append({
      t: "attempt", featureId, attempt: number, arm, builderStopped: "done", builderSelfVerified: true,
      builderCommitted: false, contextPressure: true, declaredUnsatisfiable: false, declarationReasons: [],
      declarationOverruled: false, builderCostUsd: 1.5, auditorCostUsd: 0.5, costUsd: 2, counted: true, disposition: "verify_failed", ...overrides,
    });
    attempt("f01", 1, "fresh");
    attempt("f01", 2, "single_session", { builderStopped: "usd_cap", builderCommitted: true });
    attempt("f04", 1, "fresh", { contextPressure: false, declarationOverruled: true });
    record.append({ t: "check", checkId: "init", attempt: 0, kind: "shell", phase: "init", ok: false, exitCode: 1, durationMs: 5, overrunMs: 0, timedOut: false, outputPath: "init.txt", outputTruncated: false });
    record.append({ t: "check", checkId: "c1", featureId: "f01", attempt: 1, kind: "shell", phase: "acceptance", ok: true, exitCode: 0, durationMs: 10, overrunMs: 0, timedOut: false, outputPath: "c1", outputTruncated: false });
    record.append({ t: "check", checkId: "c2", featureId: "f04", attempt: 1, kind: "file", phase: "acceptance", ok: false, durationMs: 2, overrunMs: 0, timedOut: false, outputPath: "c2", outputTruncated: false });
    record.append({ t: "check", checkId: "void", featureId: "f01", attempt: 2, kind: "shell", phase: "acceptance", ok: false, exitCode: 1, durationMs: 3, overrunMs: 0, timedOut: false, outputPath: "void", outputTruncated: false });
    record.append({ t: "check", checkId: "missing", featureId: "f03", attempt: 1, kind: "shell", phase: "acceptance", ok: false, durationMs: 0, overrunMs: 0, timedOut: false, outputPath: "missing", outputTruncated: false, notRunReason: "missing_dependency:PG_URL" });
    record.append({ t: "check", checkId: "r1", featureId: "f01", attempt: 2, kind: "file", phase: "regression", ok: true, durationMs: 4, overrunMs: 0, timedOut: false, outputPath: "r1", outputTruncated: false });
    const audit = (checkId: string, verdict: "agree" | "disagree", quality: boolean, cap: boolean, cross: boolean) => record.append({
      t: "audit", featureId: "f01", attempt: 1, checkId, shape: "full", verdict, verifiedCount: 1,
      claimedUnverifiedCount: 0, regressions: [], checkQualityAdequate: quality, truncated: false, usdCapHit: cap, crossProvider: cross, costUsd: 0.5,
    });
    audit("c1", "agree", false, true, true); audit("c2", "disagree", true, false, false); audit("void", "agree", true, false, false);
    record.append({ t: "audit.disposition", featureId: "f01", attempt: 1, checkId: "c1", rawVerdict: "disagree", effectiveVerdict: "agree", emptyDisagree: true, malformed: false, truncated: false, retried: false, evidenceUsable: true, checkVoided: false });
    record.append({ t: "audit.disposition", featureId: "f04", attempt: 1, checkId: "c2", rawVerdict: "disagree", effectiveVerdict: "disagree", emptyDisagree: false, malformed: false, truncated: true, retried: true, evidenceUsable: false, checkVoided: false });
    record.append({ t: "audit.disposition", featureId: "f01", attempt: 2, checkId: "void", rawVerdict: "disagree", effectiveVerdict: "agree", emptyDisagree: true, malformed: false, truncated: false, retried: false, evidenceUsable: true, checkVoided: true });
    record.append({ t: "sweep", featureId: "f01", planned: 2, run: 1, skipped: ["f02"], durationMs: 1_500, complete: false, scope: "partial" });
    record.append({ t: "relock", before: "a", after: "b", confirmed: true });
    record.append({ t: "spec.drift", expected: "a", actual: "b" });
    record.append({ t: "digest", hash: "d", bytes: 16_000, truncated: true });
    record.append({ t: "delta", op: "edit", section: "build", id: "B1", accepted: true });
    record.append({ t: "delta", op: "add", section: "build", accepted: false, reason: "bad ref" });
    record.append({ t: "honest_exit", kind: "cannot_be_satisfied", reasons: ["raw declaration only"], source: "declared" });
    record.append({ t: "stop", stopKind: "deadline", wallTargetSeconds: 14_400 });
    record.append({ t: "phase.end", phase: "build", outcome: "stopped" });
    record.append({ t: "phase.start", phase: "reflect" });
    record.append(model("reflector", 14));
    record.append({ t: "phase.end", phase: "reflect", outcome: "ok" });
    writeStatus(run, { state: "stopped", outcome: { kind: "stopped", stopKind: "deadline", wallTargetSeconds: 14_400 }, relocked: true });

    const metrics: Metrics = writeMetrics(run);
    expect(metrics.featuresTotal).toBe(4);
    expect(metrics.featuresPassed).toEqual({ executed: 1, humanVerified: 1 });
    expect(metrics.featuresBlocked.missing_dependency).toBe(1);
    expect(metrics.attemptsByFeature).toEqual({ f01: 2, f02: 0, f03: 0, f04: 1 });
    expect(metrics.builderSessions).toBe(3);
    expect(metrics.checkPassRate).toEqual({ acceptance: 0.5, regression: 1 });
    expect(metrics.initExitCode).toBe(1);
    expect([metrics.regressionsCaught, metrics.regressionRepairs, metrics.regressionSweepSeconds]).toEqual([1, 1, 1.5]);
    expect([metrics.regressionChecksRun, metrics.regressionChecksSkipped, metrics.sweepsIncomplete]).toEqual([1, 1, 1]);
    expect([metrics.auditorAgreeRate, metrics.auditorDisagreeRate, metrics.auditorEmptyDisagreeRate]).toEqual([0.5, 0.5, 0.5]);
    expect([metrics.auditorTruncated, metrics.auditEvidenceUsable, metrics.auditRetried]).toEqual([1, 1, 1]);
    expect(metrics.auditorTokenShare).toBeGreaterThan(0);
    expect(metrics.auditorCostUsd).toBe(1.5);
    expect(metrics.checkQualityInadequate).toBe(1);
    expect(Object.keys(metrics.wallByPhase).sort()).toEqual(["build", "discover", "form", "frame", "ideate", "reflect"]);
    expect(metrics.stopKind).toBe("deadline");
    expect(metrics.honestExits.total).toBe(0);
    expect([metrics.formationAttempts, metrics.formationRevisions]).toEqual([1, 1]);
    expect(metrics.criticVerdicts).toEqual({ ok: 1, revise: 1 });
    expect([metrics.crossProviderCritic, metrics.crossProviderAuditor]).toEqual([1, 1]);
    expect(metrics.manualFeatureShare).toBe(0.25);
    expect([metrics.builderSelfVerified, metrics.builderCommitted, metrics.declarationOverruled]).toEqual([3, 1, 1]);
    expect([metrics.relocked, metrics.specDrift, metrics.overBudgetPlan, metrics.floorUnderestimated]).toEqual([true, true, true, true]);
    expect(metrics.skippedAfterBlocked).toBe(1);
    expect(metrics.usdCapHits).toBe(3);
    expect(metrics.budgetOvershootUsd).toBe(1);
    expect([metrics.checksVoided, metrics.censored]).toEqual([1, true]);
    expect(metrics.contextPressureByArm).toEqual({ fresh: 1, single_session: 1 });
    expect(metrics.digestTruncated).toBe(true);
    expect(metrics.deltaProposed).toEqual({ accepted: 1, rejected: 1 });
    expect(Object.keys(metrics.cost)).toEqual(PHASES);
    expect(metrics.cost.form).toMatchObject({ usd: 0, tokens: 0, turns: 0, successes: 1, usdPerSuccess: 0, tokensPerSuccess: 0, turnsPerSuccess: 0, cacheReadRatio: null });
    expect(metrics.cost.build).toEqual({
      usd: 12, tokens: 26, turns: 0, successes: metrics.featuresPassed.executed,
      usdPerSuccess: 12, tokensPerSuccess: 26, turnsPerSuccess: 0,
      cacheReadRatio: 1 / 11, cacheWrite: 0, reasoningTokens: null,
    });
    expect(metrics.cost.reflect).toEqual({
      usd: 14, tokens: 13, turns: 0, successes: 1, usdPerSuccess: 14,
      tokensPerSuccess: 13, turnsPerSuccess: 0, cacheReadRatio: 1 / 11,
      cacheWrite: 0, reasoningTokens: null,
    });
    expect(Object.values(metrics.costByPhase).reduce((sum, value) => sum + value, 0)).toBe(metrics.costUsd);
    expect(Object.keys(metrics)).toEqual(expect.arrayContaining(Object.keys(foldBuildMetrics(run))));
  });

  test("classifies only the final honest exit as mechanical or declared", () => {
    const { run, record } = setup();
    record.append({ t: "tool.call", name: "exit", args: { kind: "not_formable" }, ok: true, durationMs: 1, excerpt: "earlier declaration" });
    record.append({ t: "honest_exit", kind: "not_formable", reasons: ["earlier"], source: "declared" });
    record.append({ t: "honest_exit", kind: "not_formable", reasons: ["mechanical"], source: "mechanical" });
    writeStatus(run, { state: "done", outcome: { kind: "honest_exit", exitKind: "not_formable", reasons: ["mechanical"] } });
    expect(foldBuildMetrics(run).honestExits.not_formable).toEqual({ mechanical: 1, declared: 0 });
    record.append({ t: "honest_exit", kind: "not_formable", reasons: ["latest"], source: "declared" });
    expect(foldBuildMetrics(run).honestExits.not_formable).toEqual({ mechanical: 0, declared: 1 });
    writeStatus(run, { state: "done", outcome: { kind: "honest_exit", exitKind: "no_idea_clears_bar", reasons: ["empty frontier"] } });
    expect(foldBuildMetrics(run).honestExits).toMatchObject({ declaredNoIdea: 0, mechanicalNoIdea: 1 });
  });

  test("marks the planning floor only when a counted attempt strictly exceeds it", () => {
    const { run, record } = setup();
    const floor = derivedCaps(defaultConfig()).attemptCeiling;
    const attempt = (number: number, costUsd: number, counted: boolean) => record.append({
      t: "attempt", featureId: "f01", attempt: number, arm: "fresh", builderStopped: "done",
      builderSelfVerified: false, builderCommitted: false, contextPressure: false, declaredUnsatisfiable: false,
      declarationReasons: [], declarationOverruled: false, builderCostUsd: costUsd, auditorCostUsd: 0,
      costUsd, counted, disposition: "verify_failed",
    });
    attempt(1, floor, true);
    attempt(2, floor + 10, false);
    expect(foldBuildMetrics(run).floorUnderestimated).toBe(false);
    attempt(3, floor + Number.EPSILON * 16, true);
    expect(foldBuildMetrics(run).floorUnderestimated).toBe(true);
  });

  test("uses reconciled feature state, not an unmirrored record transition, for build successes", () => {
    const { run, record } = setup();
    record.append({ t: "phase.start", phase: "build" });
    record.append(model("builder", 2));
    record.append({ t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1 });
    expect(foldBuildMetrics(run).featuresPassed.executed).toBe(0);
    expect(writeMetrics(run).cost.build).toMatchObject({
      usd: 2, tokens: 13, turns: 0, successes: 0,
      usdPerSuccess: null, tokensPerSuccess: null, turnsPerSuccess: null,
    });
  });

  test("infers legacy declared exits only from the final event's adjacent matching tool call", () => {
    const { run, record } = setup();
    writeStatus(run, { state: "done", outcome: { kind: "honest_exit", exitKind: "not_formable", reasons: ["legacy"] } });
    record.append({ t: "tool.call", name: "exit", args: { kind: "not_formable" }, ok: true, durationMs: 1, excerpt: "earlier" });
    record.append({ t: "honest_exit", kind: "not_formable", reasons: ["legacy mechanical"] });
    record.append({ t: "note", text: "break adjacency" });
    expect(foldBuildMetrics(run).honestExits.not_formable).toEqual({ mechanical: 1, declared: 0 });

    record.append({ t: "honest_exit", kind: "not_formable", reasons: ["legacy declared"] });
    record.append({ t: "tool.call", name: "exit", args: { kind: "not_formable" }, ok: true, durationMs: 1, excerpt: "adjacent" });
    expect(foldBuildMetrics(run).honestExits.not_formable).toEqual({ mechanical: 0, declared: 1 });

    record.append({ t: "honest_exit", kind: "not_formable", reasons: ["explicit wins"], source: "mechanical" });
    record.append({ t: "tool.call", name: "exit", args: { kind: "not_formable" }, ok: true, durationMs: 1, excerpt: "ignored" });
    expect(foldBuildMetrics(run).honestExits.not_formable).toEqual({ mechanical: 1, declared: 0 });

    writeStatus(run, { state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied", reasons: ["legacy"] } });
    record.append({ t: "honest_exit", kind: "cannot_be_satisfied", reasons: ["legacy mechanical"] });
    record.append({ t: "tool.call", name: "exit", args: { kind: "not_formable" }, ok: true, durationMs: 1, excerpt: "wrong kind" });
    expect(foldBuildMetrics(run).honestExits.cannot_be_satisfied.declared).toBe(0);
    record.append({ t: "honest_exit", kind: "cannot_be_satisfied", reasons: ["legacy declared"] });
    record.append({ t: "tool.call", name: "exit", args: { kind: "cannot_be_satisfied" }, ok: true, durationMs: 1, excerpt: "adjacent" });
    expect(foldBuildMetrics(run).honestExits.cannot_be_satisfied.declared).toBe(1);
  });
});
