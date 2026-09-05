import { existsSync, readFileSync } from "node:fs";
import type { StoredEvent } from "../core/events";
import type { PhaseDeps } from "../phases/frame";
import type { Feature, FeaturesFile } from "../formation/features";
import { projectPaths } from "../formation/paths";
import { parseTrailers, type FeatureCommitTrailer, type GitRunner } from "./git";
import { appendProgress, parseProgress } from "./progress";
import { appendRecordedState, foldState } from "./state";
import { activeCheck, appendAttempt, attemptRecorded, auditorSession, builderSession } from "./loop-support";

type AttemptEvent = Extract<StoredEvent, { t: "attempt" }>;

function countedSinceReset(deps: PhaseDeps, featureId: string, throughSeq: number): number {
  const events = deps.record.read();
  const reset = events.findLast((event) => event.seq <= throughSeq && event.t === "feature.state" && event.featureId === featureId && event.to === "regressed")?.seq ?? 0;
  return events.filter((event) => event.seq > reset && event.seq <= throughSeq && event.t === "attempt" && event.featureId === featureId && event.counted).length;
}

/** A transition covers an attempt when it names it, or, in the legacy shape without `attempt`, when it follows the attempt for the same feature. */
function covered(events: readonly StoredEvent[], attempt: AttemptEvent): boolean {
  return events.some((event) => event.t === "feature.state" && event.featureId === attempt.featureId
    && (event.attempt === attempt.attempt || (event.attempt === undefined && event.seq > attempt.seq)));
}

/** Rebuild the state suffix when a final attempt reached record.jsonl immediately before a crash. */
export function repairAttemptStates(deps: PhaseDeps): number {
  let repaired = 0;
  for (const attempt of deps.record.read()) {
    if (attempt.t !== "attempt" || covered(deps.record.read(), attempt)) continue;
    const state = foldState(deps.run)[attempt.featureId];
    if (!state) throw new Error(`integrity: attempt names unknown feature ${attempt.featureId}`);
    if (attempt.disposition === "passed") {
      if (!state.passes) throw new Error(`integrity: passed attempt ${attempt.featureId}/${attempt.attempt} has no authenticated commit`);
      continue;
    }
    appendRecordedState(deps.run, deps.record, {
      t: "feature.state", featureId: attempt.featureId, from: state.state, to: "failed", attempt: attempt.attempt,
      attempts: Math.max(state.attempts, countedSinceReset(deps, attempt.featureId, attempt.seq)), repairs: state.repairs, reason: attempt.disposition,
    });
    repaired += 1;
  }
  return repaired;
}

/**
 * Recover the crash window between the authenticated feature commit and its final `attempt` (record §8): a builder session
 * whose feature passes through this attempt's own trailer, check and audit gets its `passed` attempt; a second resume appends nothing.
 */
export function repairPassedAttempts(deps: PhaseDeps, features: FeaturesFile, trailers: readonly FeatureCommitTrailer[]): number {
  let repaired = 0;
  for (const session of deps.record.read()) {
    if (session.t !== "builder.session") continue;
    const events = deps.record.read();
    if (attemptRecorded(events, session.featureId, session.attempt)) continue;
    const feature = features.features.find((value) => value.id === session.featureId);
    const state = foldState(deps.run)[session.featureId];
    if (!feature || !state?.passes) continue;
    const trailer = trailers.find((value) => value.featureId === session.featureId && value.attempt === session.attempt && state.passCommitShas.includes(value.sha));
    const checked = trailer ? activeCheck(events, session.featureId, session.attempt).check : undefined;
    const audited = checked && checked.checkId === trailer?.checkId ? auditorSession(deps, session.featureId, session.attempt, checked) : undefined;
    if (!audited) continue;
    const builder = builderSession(events, session.featureId, session.attempt)!;
    appendAttempt(deps, session.arm, feature, session.attempt, builder, audited.costUsd, { disposition: "passed", counted: true, declarationOverruled: session.exitReasons.length > 0 });
    repaired += 1;
  }
  return repaired;
}

/**
 * The harness's own commit for exactly this attempt and check, when a crash after `git commit` left it unrecorded and entry
 * could not authenticate it: the pass path adopts its sha instead of committing the same attempt twice (record §8).
 */
export async function existingFeatureCommit(git: GitRunner, repo: string, key: { runId: string; featureId: string; attempt: number; checkId: string }): Promise<string | undefined> {
  return parseTrailers(await git.log(repo)).find((trailer) => trailer.runId === key.runId && trailer.featureId === key.featureId && trailer.attempt === key.attempt && trailer.checkId === key.checkId)?.sha;
}

function synthetic(feature: Feature, disposition: string) {
  return {
    checkId: `not-run-${disposition}`, ok: false, kind: feature.acceptance.type, durationMs: 0, overrunMs: 0,
    timedOut: false, output: `check not run: ${disposition}`, outputPath: "", outputTruncated: false, notRunReason: disposition,
  } as const;
}

/**
 * Append the progress entry of every final attempt that crashed after boundary 7 before writing its own. Progress is
 * append-only (record §8 step 10): an entry the loop already wrote, with its discard stat and commit facts, is never rewritten.
 */
export function repairAttemptProgress(deps: PhaseDeps, features: FeaturesFile, trailers: readonly FeatureCommitTrailer[]): number {
  const path = projectPaths(deps.run.project).progress;
  const written = new Set(parseProgress(existsSync(path) ? readFileSync(path, "utf8") : "").flatMap((entry) => entry.kind === "attempt" ? [`${entry.featureId}:${entry.attempt}`] : []));
  let repaired = 0;
  for (const attempt of deps.record.read()) {
    if (attempt.t !== "attempt" || written.has(`${attempt.featureId}:${attempt.attempt}`)) continue;
    const events = deps.record.read();
    const feature = features.features.find((value) => value.id === attempt.featureId);
    const builder = builderSession(events, attempt.featureId, attempt.attempt);
    if (!feature || !builder) continue;
    const captured = activeCheck(events, attempt.featureId, attempt.attempt);
    const check = captured.check ?? synthetic(feature, attempt.disposition);
    const checkEvent = captured.check ? events.find((event) => event.t === "check" && event.checkId === captured.check!.checkId) : undefined;
    const audit = captured.check ? auditorSession(deps, attempt.featureId, attempt.attempt, captured.check) : undefined;
    const sha = trailers.find((trailer) => trailer.featureId === attempt.featureId && trailer.attempt === attempt.attempt && trailer.checkId === captured.check?.checkId)?.sha;
    appendProgress(deps.run, {
      featureId: attempt.featureId, attempt: attempt.attempt, kind: "attempt", entryId: `attempt-${attempt.attempt}`, iso: checkEvent?.ts ?? attempt.ts,
      check: { ...check, excerpt: check.output }, audit,
      commit: sha ? { sha } : attempt.disposition === "commit_failed" ? { error: "feature commit failed" } : undefined,
    });
    repaired += 1;
  }
  return repaired;
}
