import { existsSync, readFileSync } from "node:fs";
import type { BuildConfig } from "../core/config";
import type { RecordEvent } from "../core/events";
import { appendLine, writeAtomic } from "../core/paths";
import { hashInput, RunRecord } from "../core/record";
import type { RunPaths } from "../core/run";
import { parseFeatures, type Feature, type FeaturesFile } from "../formation/features";
import { projectPaths } from "../formation/paths";
import type { FeatureCommitTrailer } from "./git";
import { readAudits } from "./audit-contract";

export type FeatureTransition = Extract<RecordEvent, { t: "feature.state" }>;
export type FeatureLifecycle = "pending" | "passed" | "failed" | "blocked" | "regressed";

export interface FeatureFold {
  state: FeatureLifecycle;
  passes: boolean;
  /** Absolute count of passed transitions, matched against unique feature trailers during recovery. */
  passTransitions: number;
  /** Commit identities consumed by pass transitions and all trailer identities already observed. */
  passCommitShas: string[];
  observedCommitShas: string[];
  /** Historical pass transitions written before commitSha existed. */
  legacyPassTransitions: number;
  legacyCommitShas: string[];
  passSource?: "executed" | "human";
  attempts: number;
  blocked?: true;
  blockedReason?: string;
  regressedBy?: string;
  repairs: number;
}

export type BuildState = Record<string, FeatureFold>;

interface StoredTransition extends FeatureTransition {
  ts?: string;
}

function authoritativeFeatures(paths: RunPaths): FeaturesFile {
  if (!existsSync(paths.features)) throw new Error("integrity: authoritative features.json is missing");
  try { return parseFeatures(readFileSync(paths.features, "utf8")) as FeaturesFile; }
  catch (error) { throw new Error(`integrity: cannot read authoritative features.json: ${(error as Error).message}`); }
}

function initialState(file: FeaturesFile): BuildState {
  return Object.fromEntries(file.features.map((feature) => [feature.id, {
    state: "pending", passes: false, passTransitions: 0, passCommitShas: [], observedCommitShas: [], legacyPassTransitions: 0, legacyCommitShas: [], attempts: 0, repairs: 0,
  } satisfies FeatureFold]));
}

function transitionKey(event: FeatureTransition): string {
  const { ts: _ts, seq: _seq, ...plain } = event as FeatureTransition & { ts?: string; seq?: number };
  return hashInput(plain);
}

function transitions(paths: RunPaths): FeatureTransition[] {
  if (!existsSync(paths.featureState)) return [];
  const text = readFileSync(paths.featureState, "utf8");
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const out: FeatureTransition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as StoredTransition;
      if (event?.t !== "feature.state" || typeof event.featureId !== "string") throw new Error("not a feature.state event");
      const { ts: _ts, ...transition } = event;
      out.push(transition);
    } catch (error) {
      if (!terminated && index === lines.length - 1 && isInvalidJson(line)) continue;
      throw new Error(`integrity: malformed state.jsonl line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return out;
}

function isInvalidJson(line: string): boolean {
  try { JSON.parse(line); return false; } catch { return true; }
}

function repairTornTail(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  if (text === "" || text.endsWith("\n")) return;
  const start = text.lastIndexOf("\n") + 1;
  if (isInvalidJson(text.slice(start))) writeAtomic(path, text.slice(0, start));
}

function applyTransition(state: BuildState, event: FeatureTransition): void {
  const current = state[event.featureId];
  if (!current) throw new Error(`integrity: state transition names unknown feature ${event.featureId}`);
  const states: readonly FeatureLifecycle[] = ["pending", "passed", "failed", "blocked", "regressed"];
  if (!states.includes(event.from) || !states.includes(event.to)) throw new Error(`integrity: ${event.featureId} has an unknown lifecycle state`);
  if (current.state !== event.from) throw new Error(`integrity: ${event.featureId} transition expected ${current.state}, got ${event.from}`);
  const resetForRegression = event.to === "regressed" && event.attempts === 0;
  if (event.attempts !== undefined && (!Number.isInteger(event.attempts) || (event.attempts < current.attempts && !resetForRegression))) {
    throw new Error(`integrity: ${event.featureId} attempts must be an absolute non-decreasing integer`);
  }
  if (event.repairs !== undefined && (!Number.isInteger(event.repairs) || event.repairs < current.repairs)) {
    throw new Error(`integrity: ${event.featureId} repairs must be an absolute non-decreasing integer`);
  }
  if (event.observedCommitShas !== undefined || event.legacyCommitShas !== undefined) {
    const observed = event.observedCommitShas ?? [];
    const legacy = event.legacyCommitShas ?? [];
    if (event.from !== event.to || event.commitSha !== undefined || [...observed, ...legacy].some((sha) => typeof sha !== "string" || sha === "")) {
      throw new Error(`integrity: ${event.featureId} commit observation must be an identity-only transition`);
    }
    current.observedCommitShas = [...new Set([...current.observedCommitShas, ...observed, ...legacy])];
    current.legacyCommitShas = [...new Set([...current.legacyCommitShas, ...legacy])];
    current.passCommitShas = [...new Set([...current.passCommitShas, ...legacy])];
    return;
  }
  if (event.to === "passed" && event.source !== "executed" && event.source !== "human") throw new Error(`integrity: ${event.featureId} pass source is required`);
  if (event.to === "blocked" && !event.reason) throw new Error(`integrity: ${event.featureId} block reason is required`);
  if (event.to === "regressed" && !event.regressedBy) throw new Error(`integrity: ${event.featureId} regression source is required`);
  current.state = event.to;
  current.attempts = event.attempts ?? current.attempts;
  current.repairs = event.repairs ?? current.repairs;
  current.passes = event.to === "passed";
  if (current.passes) {
    if (event.commitSha) {
      if (!current.passCommitShas.includes(event.commitSha)) {
        current.passTransitions += 1;
        current.passCommitShas.push(event.commitSha);
      }
      if (!current.observedCommitShas.includes(event.commitSha)) current.observedCommitShas.push(event.commitSha);
    } else {
      current.passTransitions += 1;
      current.legacyPassTransitions += 1;
    }
  }
  current.passSource = current.passes ? event.source : undefined;
  current.blocked = event.to === "blocked" ? true : undefined;
  current.blockedReason = event.to === "blocked" ? event.reason : undefined;
  if (event.to === "regressed" && event.regressedBy) current.regressedBy = event.regressedBy;
}

/** Fold authoritative features plus absolute, append-only state transitions. */
export function foldState(paths: RunPaths): BuildState {
  const state = initialState(authoritativeFeatures(paths));
  const seen = new Set<string>();
  for (const event of transitions(paths)) {
    const key = transitionKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    applyTransition(state, event);
  }
  return state;
}

function regenerateMirrors(paths: RunPaths): void {
  const project = projectPaths(paths.project);
  writeAtomic(project.featuresMirror, readFileSync(paths.features, "utf8"));
  writeAtomic(project.lockMirror, readFileSync(paths.acceptanceLock, "utf8"));
}

/** Append once by absolute-transition identity, then always repair both inspection mirrors. */
export function appendState(paths: RunPaths, transition: FeatureTransition): BuildState {
  if (transition.t !== "feature.state") throw new Error("state.jsonl accepts only feature.state transitions");
  repairTornTail(paths.featureState);
  const existing = transitions(paths);
  const duplicate = existing.some((event) => transitionKey(event) === transitionKey(transition));
  if (!duplicate) {
    const projected = structuredClone(foldState(paths));
    applyTransition(projected, transition);
    appendLine(paths.featureState, JSON.stringify({ ...transition, ts: new Date().toISOString() }));
  }
  regenerateMirrors(paths);
  return foldState(paths);
}

/** Task 9 boundary: keep the state journal authoritative and mirror the same typed transition into the run record once. */
export function appendRecordedState(paths: RunPaths, record: RunRecord, transition: FeatureTransition, options: { afterState?: () => void } = {}): BuildState {
  const state = appendState(paths, transition);
  options.afterState?.();
  if (!record.read().some((event) => event.t === "feature.state" && transitionKey(event) === transitionKey(transition))) record.append(transition);
  return state;
}

/** Repair the internal state-written/record-missing crash window from authoritative state.jsonl. */
export function syncStateRecord(paths: RunPaths, record: RunRecord): number {
  let appended = 0;
  for (const transition of transitions(paths)) {
    if (record.read().some((event) => event.t === "feature.state" && transitionKey(event) === transitionKey(transition))) continue;
    record.append(transition); appended += 1;
  }
  return appended;
}

function trailerCommits(trailers: readonly { featureId: string; sha: string }[]): Map<string, string[]> {
  const commits = new Map<string, Set<string>>();
  for (const { featureId, sha } of trailers) {
    const held = commits.get(featureId) ?? new Set<string>();
    held.add(sha);
    commits.set(featureId, held);
  }
  return new Map([...commits].map(([featureId, shas]) => [featureId, [...shas]]));
}

interface ReconciliationPlan { recover: string[]; observe: string[]; bindLegacy: string[] }

/** `history` is the complete feature-trailer history, newest first. */
function reconciliationPlan(state: FeatureFold, history: readonly string[]): ReconciliationPlan {
  const known = new Set(state.passCommitShas);
  const observed = new Set(state.observedCommitShas);
  const remaining = history.filter((sha) => !known.has(sha));
  const unboundLegacy = Math.max(0, state.legacyPassTransitions - state.legacyCommitShas.length);
  const bindLegacy = remaining.slice(Math.max(0, remaining.length - unboundLegacy));
  const legacy = new Set(bindLegacy);
  const anchorIndices = history.flatMap((sha, index) => known.has(sha) ? [index] : []);
  if (known.size > 0 && anchorIndices.length === 0) return { recover: [], observe: [], bindLegacy: [] };
  if (known.size === 0 && observed.size > 0) return { recover: [], observe: [], bindLegacy: [] };
  if (known.size === 0) {
    const recover = remaining.filter((sha) => !legacy.has(sha));
    return { recover, observe: bindLegacy, bindLegacy };
  }
  const firstAnchor = Math.min(...anchorIndices);
  const prefix = history.slice(0, firstAnchor).filter((sha) => !known.has(sha) && !legacy.has(sha));
  const recover = prefix.some((sha) => observed.has(sha)) ? [] : prefix.filter((sha) => !observed.has(sha));
  const safeOlder = history.slice(firstAnchor + 1).filter((sha) => !observed.has(sha) && !known.has(sha));
  return { recover, observe: [...new Set([...safeOlder, ...bindLegacy])], bindLegacy };
}

function projectRecovery(state: FeatureFold, plan: ReconciliationPlan): void {
  for (const sha of plan.recover.toReversed()) {
    if (!state.passCommitShas.includes(sha)) {
      state.passTransitions += 1;
      state.passCommitShas.push(sha);
    }
    if (!state.observedCommitShas.includes(sha)) state.observedCommitShas.push(sha);
    state.state = "passed";
    state.passes = true;
    state.passSource = "executed";
    state.blocked = undefined;
    state.blockedReason = undefined;
  }
  state.observedCommitShas = [...new Set([...state.observedCommitShas, ...plan.observe])];
  state.legacyCommitShas = [...new Set([...state.legacyCommitShas, ...plan.bindLegacy])];
  state.passCommitShas = [...new Set([...state.passCommitShas, ...plan.bindLegacy])];
}

/** Trailer recovery as a pure projection for callers that only need a view. */
export function reconcile(fold: BuildState, trailers: readonly { featureId: string; sha: string }[]): BuildState {
  const next = structuredClone(fold);
  for (const [featureId, shas] of trailerCommits(trailers)) {
    const state = next[featureId];
    if (state) projectRecovery(state, reconciliationPlan(state, shas));
  }
  return next;
}

/** Persist each unmatched newer feature commit before any later transition consumes the fold. */
export interface ReconcileStateOptions { runId?: string; requireAuthenticated?: boolean; record?: RunRecord }

function authenticated(paths: RunPaths, trailer: FeatureCommitTrailer, runId: string): boolean {
  if (trailer.runId !== runId || !trailer.checkId) return false;
  const current = foldState(paths)[trailer.featureId];
  if (!current || trailer.attempt === undefined || trailer.attempt <= current.attempts) return false;
  const events = new RunRecord(paths.record).read();
  const one = <T>(values: readonly T[]) => values.length === 1;
  const named = (value: { featureId?: string; attempt?: number }) => value.featureId === trailer.featureId && value.attempt === trailer.attempt;
  /** A resumed auditor legitimately re-persists after an interior crash: at least one record, every one agreeing on feature, attempt and verdict. */
  const consistent = <T extends { featureId: string; attempt: number }>(values: readonly T[], verdict: (value: T) => string | undefined) =>
    values.length >= 1 && values.every((value) => named(value) && verdict(value) === verdict(values[0]!));
  const picks = events.filter((event) => event.t === "feature.pick" && named(event));
  const sessions = events.filter((event) => event.t === "builder.session" && named(event));
  const checks = events.filter((event) => event.t === "check" && event.checkId === trailer.checkId);
  const check = checks[0];
  const audits = events.flatMap((event) => event.t === "audit" && event.checkId === trailer.checkId ? [event] : []);
  const stored = readAudits(paths).filter((audit) => audit.checkId === trailer.checkId);
  const dispositions = events.filter((event) => event.t === "audit.disposition" && event.checkId === trailer.checkId);
  return one(picks) && one(sessions) && one(checks) && check?.t === "check" && check.ok && check.phase === "acceptance" && named(check)
    && consistent(audits, (audit) => audit.verdict) && consistent(stored, (audit) => audit.raw.verdict)
    && one(dispositions) && dispositions[0]?.t === "audit.disposition" && named(dispositions[0])
    && !dispositions[0].checkVoided && dispositions[0].effectiveVerdict === "agree";
}

export function reconcileState(paths: RunPaths, input: readonly FeatureCommitTrailer[], options: ReconcileStateOptions = {}): BuildState {
  const checkIds = new Map<string, number>();
  for (const trailer of input) if (trailer.checkId) checkIds.set(trailer.checkId, (checkIds.get(trailer.checkId) ?? 0) + 1);
  const trailers = options.requireAuthenticated
    ? input.filter((trailer) => options.runId !== undefined && authenticated(paths, trailer, options.runId) && checkIds.get(trailer.checkId ?? "") === 1)
    : input;
  const bySha = new Map(trailers.map((trailer) => [trailer.sha, trailer]));
  for (const [featureId, shas] of trailerCommits(trailers)) {
    let state = foldState(paths)[featureId];
    if (!state) continue;
    const plan = reconciliationPlan(state, shas);
    for (const commitSha of plan.recover.toReversed()) {
      const transition: FeatureTransition = {
        t: "feature.state", featureId, from: state.state, to: "passed", source: "executed",
        attempt: bySha.get(commitSha)?.attempt, attempts: Math.max(state.attempts, bySha.get(commitSha)?.attempt ?? state.attempts), repairs: state.repairs, commitSha,
      };
      state = (options.record ? appendRecordedState(paths, options.record, transition) : appendState(paths, transition))[featureId]!;
    }
    const current = foldState(paths)[featureId]!;
    const observedCommitShas = plan.observe.filter((sha) => !current.observedCommitShas.includes(sha));
    const legacyCommitShas = plan.bindLegacy.filter((sha) => !current.legacyCommitShas.includes(sha));
    if (observedCommitShas.length > 0 || legacyCommitShas.length > 0) {
      const transition: FeatureTransition = { t: "feature.state", featureId, from: current.state, to: current.state, observedCommitShas, legacyCommitShas };
      if (options.record) appendRecordedState(paths, options.record, transition); else appendState(paths, transition);
    }
  }
  regenerateMirrors(paths);
  return foldState(paths);
}

export function pickFeature(file: FeaturesFile, fold: BuildState, cfg: Pick<BuildConfig, "maxAttempts">): { feature: Feature; attempt: number } | undefined {
  for (const feature of file.features) {
    const state = fold[feature.id] ?? initialState({ ...file, features: [feature] })[feature.id]!;
    if (!state.passes && !state.blocked && state.attempts < cfg.maxAttempts) return { feature, attempt: state.attempts + 1 };
  }
  return undefined;
}
