import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PHASES, loadConfig, type Phase } from "../core/config";
import type { AttemptDisposition, StopKind, StoredEvent } from "../core/events";
import { writeAtomic } from "../core/paths";
import { RunRecord } from "../core/record";
import { readStatus, type RunPaths } from "../core/run";
import { derivedCaps, parseFeatures, type FeaturesFile } from "../formation/features";
import { computeMetrics, type IdeationMetrics } from "../ideation/metrics";
import { foldState, reconcile, type BuildState } from "./state";

const BLOCK_REASONS = ["attempts_exhausted", "not_verifiable", "missing_dependency", "declared_unsatisfiable", "regression_unrepairable", "feature_budget"] as const;
type BlockReason = (typeof BLOCK_REASONS)[number];
const DISPOSITIONS: readonly AttemptDisposition[] = ["passed", "verify_failed", "audit_disagreed", "stalled", "transient", "budget", "declared_failed", "commit_failed", "refused", "paused"];

export interface BuildMetrics {
  featuresTotal: number;
  featuresPassed: { executed: number; humanVerified: number };
  featuresBlocked: Record<BlockReason, number>;
  attemptsByFeature: Record<string, number>;
  builderSessions: number;
  checkPassRate: { acceptance: number | null; regression: number | null };
  initExitCode: number | null;
  regressionsCaught: number;
  regressionRepairs: number;
  regressionSweepSeconds: number;
  regressionChecksRun: number;
  regressionChecksSkipped: number;
  sweepsIncomplete: number;
  auditorAgreeRate: number | null;
  auditorDisagreeRate: number | null;
  auditorEmptyDisagreeRate: number | null;
  auditorTruncated: number;
  auditEvidenceUsable: number;
  auditRetried: number;
  auditorTokenShare: number | null;
  auditorCostUsd: number;
  checkQualityInadequate: number;
  wallByPhase: Record<Phase, number>;
  stopKind: StopKind | null;
  honestExits: IdeationMetrics["honestExits"] & {
    cannot_be_satisfied: { declared: number };
    not_formable: { mechanical: number; declared: number };
  };
  formationRevisions: number;
  formationAttempts: number;
  criticVerdicts: { ok: number; revise: number };
  crossProviderCritic: number;
  crossProviderAuditor: number;
  manualFeatureShare: number;
  builderSelfVerified: number;
  builderCommitted: number;
  relocked: boolean;
  specDrift: boolean;
  overBudgetPlan: boolean | null;
  skippedAfterBlocked: number;
  floorUnderestimated: boolean;
  usdCapHits: number;
  budgetOvershootUsd: number;
  checksVoided: number;
  censored: boolean;
  contextPressureByArm: { fresh: number; single_session: number };
  digestTruncated: boolean;
  deltaProposed: { accepted: number; rejected: number };
  declarationOverruled: number;
}

export type Metrics = IdeationMetrics & BuildMetrics;

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function features(paths: RunPaths): FeaturesFile | undefined {
  if (!existsSync(paths.features)) return undefined;
  try { return parseFeatures(readFileSync(paths.features, "utf8")) as FeaturesFile; } catch { return undefined; }
}

function finalState(paths: RunPaths, events: readonly StoredEvent[]): BuildState {
  if (!existsSync(paths.features)) return {};
  const fold = foldState(paths);
  const commits = events.flatMap((event) => event.t === "commit" ? [{ featureId: event.featureId, sha: event.sha }] : []).toReversed();
  return reconcile(fold, commits);
}

function rate(values: readonly { ok: boolean }[]): number | null {
  return values.length === 0 ? null : values.filter((value) => value.ok).length / values.length;
}

type CheckEvent = Extract<StoredEvent, { t: "check" }>;

function usableCheck(event: StoredEvent, voided: ReadonlySet<string>): event is CheckEvent {
  return event.t === "check" && event.phase !== "init" && event.kind !== "manual" && event.notRunReason === undefined && !voided.has(event.checkId);
}

function wallByPhase(events: readonly StoredEvent[]): Record<Phase, number> {
  const totals = zeros(PHASES);
  const starts = new Map<Phase, number>();
  for (const event of events) {
    if (event.t === "phase.start") starts.set(event.phase, Date.parse(event.ts));
    if (event.t === "phase.end") {
      const start = starts.get(event.phase);
      const end = Date.parse(event.ts);
      if (start !== undefined && Number.isFinite(start) && Number.isFinite(end)) totals[event.phase] += Math.max(0, end - start) / 1_000;
      starts.delete(event.phase);
    }
  }
  return totals;
}

function skippedAfterBlocked(events: readonly StoredEvent[], file: FeaturesFile | undefined): number {
  if (!file) return 0;
  const order = new Map(file.features.map((feature, index) => [feature.id, index]));
  const blocked = new Set<string>();
  let skipped = 0;
  for (const event of events) {
    if (event.t === "feature.state") {
      if (event.to === "blocked") blocked.add(event.featureId); else blocked.delete(event.featureId);
    } else if (event.t === "feature.pick") {
      const at = order.get(event.featureId) ?? 0;
      skipped += [...blocked].filter((id) => (order.get(id) ?? Number.POSITIVE_INFINITY) < at).length;
    }
  }
  return skipped;
}

function terminalHonestExits(status: ReturnType<typeof readStatus>, events: readonly StoredEvent[]): BuildMetrics["honestExits"] {
  const terminal = status.outcome?.kind === "honest_exit" ? status.outcome.exitKind : undefined;
  const index = terminal === undefined ? -1 : events.findLastIndex((event) => event.t === "honest_exit" && event.kind === terminal);
  const matching = index < 0 ? undefined : events[index];
  const adjacent = index < 0 ? undefined : events[index + 1];
  const legacyDeclared = matching?.t === "honest_exit" && matching.source === undefined
    && adjacent?.seq === matching.seq + 1 && adjacent.t === "tool.call" && adjacent.name === "exit" && adjacent.ok
    && (adjacent.args as { kind?: unknown } | undefined)?.kind === terminal;
  const source = matching?.t === "honest_exit" ? matching.source ?? (legacyDeclared ? "declared" : "mechanical") : "mechanical";
  const declared = source === "declared";
  return {
    total: terminal ? 1 : 0,
    declaredNoIdea: terminal === "no_idea_clears_bar" && declared ? 1 : 0,
    mechanicalNoIdea: terminal === "no_idea_clears_bar" && !declared ? 1 : 0,
    cannot_be_satisfied: { declared: terminal === "cannot_be_satisfied" && declared ? 1 : 0 },
    not_formable: { mechanical: terminal === "not_formable" && !declared ? 1 : 0, declared: terminal === "not_formable" && declared ? 1 : 0 },
  };
}

export function foldBuildMetrics(paths: RunPaths): BuildMetrics {
  const events = new RunRecord(paths.record).read();
  const status = readStatus(paths);
  const file = features(paths);
  const state = finalState(paths, events);
  const cfg = loadConfig(dirname(dirname(paths.dir)));
  const blocked = zeros(BLOCK_REASONS);
  const attemptsByFeature: Record<string, number> = {};
  let repairs = 0;
  for (const feature of file?.features ?? []) {
    const held = state[feature.id];
    attemptsByFeature[feature.id] = held?.attempts ?? 0;
    repairs += held?.repairs ?? 0;
    const reason = held?.blockedReason?.split(":")[0] as BlockReason | undefined;
    if (held?.blocked && reason && BLOCK_REASONS.includes(reason)) blocked[reason] += 1;
  }
  const attempts = events.filter((event) => event.t === "attempt");
  const sessions = events.filter((event) => event.t === "builder.session");
  const counted = attempts.filter((event) => event.counted);
  for (const event of counted) attemptsByFeature[event.featureId] = Math.max(attemptsByFeature[event.featureId] ?? 0, event.attempt);
  const voided = new Set(events.flatMap((event) => event.t === "audit.disposition" && event.checkVoided ? [event.checkId] : []));
  const checks = events.filter((event) => usableCheck(event, voided));
  const acceptance = checks.filter((event) => event.phase === "acceptance");
  const regression = checks.filter((event) => event.phase === "regression");
  const dispositions = events.filter((event) => event.t === "audit.disposition");
  const effective = dispositions.filter((event) => !event.checkVoided);
  const audits = events.filter((event) => event.t === "audit");
  const sweeps = events.filter((event) => event.t === "sweep");
  const totalTokens = events.reduce((sum, event) => event.t === "model.call" ? sum + event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite : sum, 0);
  const auditorTokens = events.reduce((sum, event) => event.t === "model.call" && event.role === "auditor" ? sum + event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite : sum, 0);
  const observedMean = counted.length === 0 ? 0 : counted.reduce((sum, event) => sum + event.costUsd, 0) / counted.length;
  const projected = derivedCaps(cfg).maxFeatures * cfg.build.expectedAttempts * observedMean;
  const deltas = events.filter((event) => event.t === "delta");
  const critiques = events.filter((event) => event.t === "critique");
  const finalStop = status.outcome?.kind === "stopped" ? status.outcome.stopKind ?? null : null;
  const passed = Object.values(state).filter((held) => held.passes);
  const init = events.findLast((event) => event.t === "check" && event.phase === "init");
  return {
    featuresTotal: file?.features.length ?? 0,
    featuresPassed: { executed: passed.filter((held) => held.passSource === "executed").length, humanVerified: passed.filter((held) => held.passSource === "human").length },
    featuresBlocked: blocked,
    attemptsByFeature,
    builderSessions: sessions.length > 0 ? sessions.length : attempts.length,
    checkPassRate: { acceptance: rate(acceptance), regression: rate(regression) },
    initExitCode: init?.t === "check" ? init.exitCode ?? null : null,
    regressionsCaught: events.filter((event) => event.t === "feature.state" && event.to === "regressed").length,
    regressionRepairs: repairs,
    regressionSweepSeconds: sweeps.reduce((sum, event) => sum + event.durationMs, 0) / 1_000,
    regressionChecksRun: sweeps.reduce((sum, event) => sum + event.run, 0),
    regressionChecksSkipped: sweeps.reduce((sum, event) => sum + event.skipped.length, 0),
    sweepsIncomplete: sweeps.filter((event) => !event.complete || event.scope === "partial").length,
    auditorAgreeRate: effective.length === 0 ? null : effective.filter((event) => event.effectiveVerdict === "agree").length / effective.length,
    auditorDisagreeRate: effective.length === 0 ? null : effective.filter((event) => event.effectiveVerdict === "disagree").length / effective.length,
    auditorEmptyDisagreeRate: effective.length === 0 ? null : effective.filter((event) => event.emptyDisagree).length / effective.length,
    auditorTruncated: dispositions.filter((event) => event.truncated).length,
    auditEvidenceUsable: effective.filter((event) => event.evidenceUsable).length,
    auditRetried: dispositions.filter((event) => event.retried).length,
    auditorTokenShare: totalTokens === 0 ? null : auditorTokens / totalTokens,
    auditorCostUsd: audits.reduce((sum, event) => sum + event.costUsd, 0),
    checkQualityInadequate: audits.filter((event) => event.checkQualityAdequate === false).length,
    wallByPhase: wallByPhase(events),
    stopKind: finalStop,
    honestExits: terminalHonestExits(status, events),
    formationRevisions: new Set(events.flatMap((event) => event.t === "formation.revision" ? [`${event.ideaId}\0${event.attempt}`] : [])).size,
    formationAttempts: new Set(events.flatMap((event) => event.t === "formation.attempt" ? [`${event.ideaId}\0${event.attempt}`] : [])).size,
    criticVerdicts: { ok: critiques.filter((event) => event.verdict === "ok").length, revise: critiques.filter((event) => event.verdict === "revise").length },
    crossProviderCritic: critiques.filter((event) => event.crossProvider).length,
    crossProviderAuditor: audits.filter((event) => event.crossProvider).length,
    manualFeatureShare: file && file.features.length > 0 ? file.features.filter((feature) => feature.acceptance.type === "manual").length / file.features.length : 0,
    builderSelfVerified: attempts.filter((event) => event.builderSelfVerified).length,
    builderCommitted: attempts.filter((event) => event.builderCommitted).length,
    relocked: status.relocked === true || events.some((event) => event.t === "relock"),
    specDrift: events.some((event) => event.t === "spec.drift"),
    overBudgetPlan: counted.length < 3 ? null : projected > cfg.budgets.phaseBudgetUsd("build"),
    skippedAfterBlocked: skippedAfterBlocked(events, file),
    floorUnderestimated: counted.some((event) => event.costUsd > derivedCaps(cfg).attemptCeiling),
    usdCapHits: attempts.filter((event) => event.builderStopped === "usd_cap").length + audits.filter((event) => event.usdCapHit).length + critiques.filter((event) => event.usdCapHit).length,
    budgetOvershootUsd: Math.max(0, new RunRecord(paths.record).costUsd() - cfg.budgets.usd),
    checksVoided: dispositions.filter((event) => event.checkVoided).length,
    censored: finalStop === "deadline",
    contextPressureByArm: { fresh: attempts.filter((event) => event.arm === "fresh" && event.contextPressure).length, single_session: attempts.filter((event) => event.arm === "single_session" && event.contextPressure).length },
    digestTruncated: events.some((event) => event.t === "digest" && event.truncated),
    deltaProposed: { accepted: deltas.filter((event) => event.accepted).length, rejected: deltas.filter((event) => !event.accepted).length },
    declarationOverruled: attempts.filter((event) => event.declarationOverruled).length,
  };
}

export function writeMetrics(paths: RunPaths): Metrics {
  const build = foldBuildMetrics(paths);
  const metrics: Metrics = { ...computeMetrics(paths, { buildSuccesses: build.featuresPassed.executed }), ...build };
  writeAtomic(paths.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}

export { DISPOSITIONS as ATTEMPT_DISPOSITIONS };
