import { existsSync, readFileSync } from "node:fs";
import type { AttemptDisposition, StoredEvent } from "../core/events";
import { excerpt, hashInput } from "../core/record";
import { writeStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { parseFeatures, type Feature, type FeaturesFile } from "../formation/features";
import { verifyAcceptanceLock } from "../formation/lock";
import type { ProjectPaths } from "../formation/paths";
import type { PhaseDeps, PhaseResult } from "../phases/frame";
import type { BuilderSessionResult, createBuilderDriver, runBuilderSession } from "./builder";
import type { AuditorSessionResult, runAuditorSession } from "./auditor";
import { readAudits } from "./audit-contract";
import { archiveBlocked } from "./blocked";
import type { GitRunner } from "./git";
import { writeMetrics } from "./metrics";
import { appendProgress } from "./progress";
import { appendRecordedState, foldState, type FeatureFold } from "./state";
import type { SweepOptions, SweepResult } from "./sweep";
import type { CheckResult, RunCheckOptions } from "./verify";
import { buildFail } from "./loop-outcomes";

export const BUILD_BOUNDARIES = [
  "entry", "lock", "pick", "builder", "post_builder_lock", "check",
  "audit", "decide", "commit", "state_and_sweep", "progress", "cursor_and_metrics",
] as const;
export type BuildBoundary = typeof BUILD_BOUNDARIES[number];

export function loadBuildFeatures(deps: PhaseDeps): FeaturesFile {
  try { return parseFeatures(readFileSync(deps.run.features, "utf8")) as FeaturesFile; }
  catch (error) { throw new Error(`integrity: cannot read authoritative features: ${(error as Error).message}`); }
}

export function buildPhaseOpen(deps: PhaseDeps): boolean {
  const event = deps.record.read().findLast((value) => (value.t === "phase.start" || value.t === "phase.end") && value.phase === "build");
  return event?.t === "phase.start";
}

export function verifyBuildLock(deps: PhaseDeps, features: FeaturesFile, project: ProjectPaths): PhaseResult | undefined {
  let lock: unknown;
  try { lock = JSON.parse(readFileSync(deps.run.acceptanceLock, "utf8")); }
  catch (error) { return buildFail(deps, "integrity", `cannot read acceptance.lock: ${(error as Error).message}`); }
  let actual: string;
  try { actual = hashInput(readFileSync(project.spec, "utf8")); }
  catch (error) { return buildFail(deps, "integrity", `cannot read spec.md: ${(error as Error).message}`); }
  const verified = verifyAcceptanceLock(features, lock, actual);
  if (!verified.ok) return buildFail(deps, "integrity", `acceptance lock mismatch: ${verified.changed.join(", ")}`);
  if (verified.specDrift && !deps.record.read().some((event) => event.t === "spec.drift" && event.actual === actual)) deps.record.append({ t: "spec.drift", expected: (lock as { specHash: string }).specHash, actual });
  return undefined;
}

export { elapsedByPhase, spentByPhase } from "../core/budget";

export function appendBuilderSession(deps: PhaseDeps, featureId: string, attempt: number, arm: "fresh" | "single_session", result: BuilderSessionResult): void {
  if (deps.record.read().some((event) => event.t === "builder.session" && event.featureId === featureId && event.attempt === attempt)) return;
  deps.record.append({
    t: "builder.session", featureId, attempt, arm, stopped: result.stopped, turns: result.turns, costUsd: result.costUsd,
    builderModelRef: result.builderModelRef, beforeHead: result.beforeHead, afterHead: result.afterHead,
    selfVerified: result.selfVerified, headMoved: result.headMoved, contextPressure: result.contextPressure,
    pinnedTruncated: result.pinnedTruncated, exitReasons: [...(result.exitReasons ?? [])],
    stallTool: result.stalled?.tool, stallFingerprint: result.stalled?.fingerprint,
    error: result.error, errorStatus: result.errorStatus, errorId: result.errorId,
  });
}

/** Journal a builder refusal once and retain its category across a boundary-resume. */
export function recordBuilderRefusal(deps: PhaseDeps, featureId: string, attempt: number, builder: BuilderSessionResult): string | undefined {
  if (builder.stopped !== "refused") return undefined;
  const prefix = `builder refused ${featureId} attempt ${attempt}:`;
  const events = deps.record.read();
  const existing = events.findLast((event) => event.t === "failure" && event.class === "refusal" && event.message.startsWith(prefix));
  if (existing?.t === "failure") return existing.category?.trim() || "unknown";
  const picked = events.findLast((event) => event.t === "feature.pick" && event.featureId === featureId && event.attempt === attempt);
  const session = events.findLast((event) => event.t === "builder.session" && event.featureId === featureId && event.attempt === attempt);
  const call = picked && session ? events.findLast((event) =>
    event.seq > picked.seq && event.seq < session.seq && event.t === "model.call" && event.role === "builder" &&
    (event.stopDetails?.type === "refusal" || event.stopDetails?.type === "sensitive")) : undefined;
  const category = builder.stopDetails?.category?.trim() || (call?.t === "model.call" ? call.stopDetails?.category?.trim() : undefined) || "unknown";
  deps.record.append({ t: "failure", class: "refusal", category, message: `${prefix} ${category}` });
  return category;
}

export function builderSession(events: readonly StoredEvent[], featureId: string, attempt: number): BuilderSessionResult | undefined {
  const event = events.findLast((value) => value.t === "builder.session" && value.featureId === featureId && value.attempt === attempt);
  if (!event || event.t !== "builder.session") return undefined;
  return {
    stopped: event.stopped, turns: event.turns, costUsd: event.costUsd, selfVerified: event.selfVerified,
    headMoved: event.headMoved, contextPressure: event.contextPressure, pinnedTruncated: event.pinnedTruncated,
    builderModelRef: event.builderModelRef, beforeHead: event.beforeHead, afterHead: event.afterHead,
    exitReasons: event.exitReasons, stalled: event.stallTool ? { tool: event.stallTool, fingerprint: event.stallFingerprint ?? "" } : undefined,
    error: event.error, errorStatus: event.errorStatus, errorId: event.errorId,
  };
}

function output(path: string): string {
  if (!existsSync(path)) return "(captured output missing)";
  const text = excerpt(readFileSync(path, "utf8"), 20, 20).text;
  if (text.length <= 1_000) return text;
  const note = "\n... [excerpt capped] ...\n"; const half = Math.floor((1_000 - note.length) / 2);
  return `${text.slice(0, half)}${note}${text.slice(-half)}`;
}

export function activeCheck(events: readonly StoredEvent[], featureId: string, attempt: number): { check?: CheckResult; finalVoided: boolean; recovered: boolean } {
  const checks = events.flatMap((event) => event.t === "check" && event.phase === "acceptance" && event.featureId === featureId && event.attempt === attempt ? [event] : []);
  const dispositions = events.flatMap((event) => event.t === "audit.disposition" && event.featureId === featureId && event.attempt === attempt ? [event] : []);
  const voided = new Set(dispositions.filter((event) => event.checkVoided).map((event) => event.checkId));
  const event = checks.findLast((check) => !voided.has(check.checkId)) ?? checks.at(-1);
  if (!event || event.t !== "check") return { finalVoided: false, recovered: false };
  return {
    check: {
      checkId: event.checkId, ok: event.ok, kind: event.kind, exitCode: event.exitCode, durationMs: event.durationMs,
      overrunMs: event.overrunMs, timedOut: event.timedOut, predicateMatched: event.predicateMatched,
      output: output(event.outputPath), outputPath: event.outputPath, outputTruncated: event.outputTruncated, notRunReason: event.notRunReason,
    },
    finalVoided: voided.has(event.checkId),
    recovered: dispositions.some((value) => value.checkVoided && value.checkId !== event.checkId),
  };
}

export function auditorSession(deps: PhaseDeps, featureId: string, attempt: number, check: CheckResult): AuditorSessionResult | undefined {
  const events = deps.record.read();
  const disposition = events.findLast((event) => event.t === "audit.disposition" && event.featureId === featureId && event.attempt === attempt && event.checkId === check.checkId);
  const audit = readAudits(deps.run).findLast((value) => value.featureId === featureId && value.attempt === attempt && value.checkId === check.checkId);
  if (!disposition || disposition.t !== "audit.disposition" || !audit) return undefined;
  const costs = events.reduce((sum, event) => event.t === "audit" && event.featureId === featureId && event.attempt === attempt ? sum + event.costUsd : sum, 0);
  return {
    audit, rawVerdict: disposition.rawVerdict, effectiveVerdict: disposition.effectiveVerdict,
    truncated: disposition.truncated, malformed: disposition.malformed, retried: disposition.retried,
    evidenceUsable: disposition.evidenceUsable,
    crossProvider: events.some((event) => event.t === "audit" && event.featureId === featureId && event.attempt === attempt && event.crossProvider),
    costUsd: costs, check, recoveredFromVoid: events.some((event) => event.t === "audit.disposition" && event.featureId === featureId && event.attempt === attempt && event.checkVoided && event.checkId !== check.checkId),
    finalCheckVoided: disposition.checkVoided, checkVoided: disposition.checkVoided,
  };
}

export function attemptRecorded(events: readonly StoredEvent[], featureId: string, attempt: number): boolean {
  return events.some((event) => event.t === "attempt" && event.featureId === featureId && event.attempt === attempt);
}

export function builderSessionArm(events: readonly StoredEvent[], featureId: string, attempt: number): "fresh" | "single_session" | undefined {
  const event = events.findLast((value) => value.t === "builder.session" && value.featureId === featureId && value.attempt === attempt);
  return event?.t === "builder.session" ? event.arm : undefined;
}

export function featureSpend(events: readonly StoredEvent[], featureId: string): number {
  return events.reduce((sum, event) => event.t === "attempt" && event.featureId === featureId ? sum + event.costUsd : sum, 0);
}

export function consecutive(events: readonly StoredEvent[], featureId: string, dispositions: readonly AttemptDisposition[]): number {
  const reset = events.findLast((event) => event.t === "stop" && event.stopKind === "transient")?.seq ?? 0;
  const attempts = events.flatMap((event) => event.t === "attempt" && event.featureId === featureId && event.seq > reset ? [event] : []).toReversed();
  let count = 0;
  for (const event of attempts) { if (!dispositions.includes(event.disposition)) break; count += 1; }
  return count;
}

export type AskFn = (prompt: string) => Promise<string>;
export interface BuildIo { ask?: AskFn }

export interface BuildDeps extends PhaseDeps {
  git?: GitRunner;
  stepHook?: (index: number, boundary: BuildBoundary) => void | Promise<void>;
  now?: () => number;
  runCheck?: (acceptance: Feature["acceptance"], options: RunCheckOptions) => Promise<CheckResult>;
  runBuilder?: typeof runBuilderSession;
  createDriver?: typeof createBuilderDriver;
  runAuditor?: typeof runAuditorSession;
  runSweep?: (deps: PhaseDeps, passed: readonly Feature[], options: SweepOptions) => Promise<SweepResult>;
  reinit?: boolean;
  initHook?: (stage: "check" | "commit") => void | Promise<void>;
}

export class BuildStepCrash extends Error {
  constructor(readonly index: number, readonly boundary: BuildBoundary, readonly originalCause: unknown) {
    super(`injected crash after build boundary ${index} (${boundary})`);
    this.name = "BuildStepCrash";
  }
}

export interface Decision {
  disposition: AttemptDisposition;
  counted: boolean;
  declarationOverruled: boolean;
}

/** A durable boundary: cursor hint, best-effort metrics, then the injectable crash seam. */
export async function boundary(deps: BuildDeps, index: number, featureId?: string, attempt?: number): Promise<void> {
  throwIfRunCancelled();
  writeStatus(deps.run, { phase: "build", state: "running", outcome: undefined, cursor: { featureId, attempt, step: BUILD_BOUNDARIES[index]! } });
  writeMetrics(deps.run);
  try { await deps.stepHook?.(index, BUILD_BOUNDARIES[index]!); throwIfRunCancelled(); }
  catch (error) { rethrowIfRunCancelled(error); throw new BuildStepCrash(index, BUILD_BOUNDARIES[index]!, error); }
}

/** The latest pick whose final attempt has not been written for a feature still in play. */
export function outstanding(deps: PhaseDeps): { featureId: string; attempt: number } | undefined {
  const events = deps.record.read();
  const state = foldState(deps.run);
  const pick = events.findLast((event) => event.t === "feature.pick" && !attemptRecorded(events, event.featureId, event.attempt)
    && !state[event.featureId]?.passes && !state[event.featureId]?.blocked);
  return pick?.t === "feature.pick" ? { featureId: pick.featureId, attempt: pick.attempt } : undefined;
}

/** The single final `attempt` per pick; a resume that already wrote it appends nothing. */
export function appendAttempt(deps: PhaseDeps, arm: "fresh" | "single_session", feature: Feature, attempt: number, builder: BuilderSessionResult, auditorCostUsd: number, value: Decision): void {
  if (attemptRecorded(deps.record.read(), feature.id, attempt)) return;
  deps.record.append({
    t: "attempt", featureId: feature.id, attempt, arm, builderStopped: builder.stopped,
    builderSelfVerified: builder.selfVerified, builderCommitted: builder.headMoved, contextPressure: builder.contextPressure,
    declaredUnsatisfiable: (builder.exitReasons?.length ?? 0) > 0, declarationReasons: builder.exitReasons ?? [], declarationOverruled: value.declarationOverruled,
    builderCostUsd: builder.costUsd, auditorCostUsd, costUsd: builder.costUsd + auditorCostUsd, counted: value.counted, disposition: value.disposition,
  });
}

function latestEvidence(deps: PhaseDeps, featureId: string) {
  const events = deps.record.read();
  const check = events.findLast((event) => event.t === "check" && event.featureId === featureId);
  const audit = readAudits(deps.run).findLast((value) => value.featureId === featureId);
  return { check: check?.t === "check" ? { path: check.outputPath, eventSeq: check.seq } : undefined, audit };
}

/** Every blocked transition archives its evidence (record §8). */
export function block(deps: PhaseDeps, featureId: string, state: FeatureFold, reason: string, attempt?: number): void {
  if (!state.blocked) appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId, from: state.state, to: "blocked", attempt, attempts: state.attempts, repairs: state.repairs, reason });
  archiveBlocked(deps.run, featureId, latestEvidence(deps, featureId));
}

/** A factual progress entry for a transition that ran no acceptance check. */
export function stateProgress(deps: PhaseDeps, feature: Feature, attempt: number, ok: boolean, reason: string, kind: "state" | "attempt" = "state", discardStat?: string): void {
  appendProgress(deps.run, {
    featureId: feature.id, attempt, kind, entryId: kind === "attempt" ? `attempt-${attempt}` : reason,
    check: { checkId: `state-${feature.id}-${attempt}`, ok, kind: feature.acceptance.type, durationMs: 0, notRunReason: ok ? undefined : reason, excerpt: reason },
    discardStat,
  });
}

/** Block at the pick's feature ceiling or the attempt cap; true when the feature is now blocked. */
export function enforceFailureCap(deps: PhaseDeps, featureId: string, attempt: number, attempts: number): boolean {
  const pick = deps.record.read().findLast((event) => event.t === "feature.pick" && event.featureId === featureId && event.attempt === attempt);
  const ceiling = pick?.t === "feature.pick" ? pick.featureBudgetUsd : undefined;
  const state = foldState(deps.run)[featureId]!;
  if (ceiling !== undefined && featureSpend(deps.record.read(), featureId) >= ceiling) { block(deps, featureId, state, "feature_budget", attempt); return true; }
  if (attempts >= deps.cfg.build.maxAttempts) { block(deps, featureId, state, "attempts_exhausted", attempt); return true; }
  return false;
}

/** Discard a failed session's work back to the head it started from, returning the discarded `--stat`. */
export async function restoreFailed(git: GitRunner, project: ProjectPaths, builder: BuilderSessionResult): Promise<string | undefined> {
  const stat = await git.diff(project.repo, { stat: true });
  await git.checkoutAndClean(project.repo, builder.beforeHead);
  return stat.trim() || undefined;
}

/** Record §12: a timed-out check is a counted `deadline` failure and the run continues; keyed on the check so a resume appends nothing. */
export function recordCheckTimeout(deps: PhaseDeps, featureId: string, attempt: number, check: CheckResult): void {
  if (!check.timedOut) return;
  const message = `acceptance check ${check.checkId} timed out for ${featureId} attempt ${attempt} after ${check.durationMs}ms`;
  if (!deps.record.read().some((event) => event.t === "failure" && event.class === "deadline" && event.message === message)) deps.record.append({ t: "failure", class: "deadline", message });
}
