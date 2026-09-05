import { phaseAvailableWallSeconds } from "../core/budget";
import type { StoredEvent } from "../core/events";
import { classifyFailure } from "../core/failure";
import type { Feature } from "../formation/features";
import type { ProjectPaths } from "../formation/paths";
import type { PhaseDeps, PhaseResult } from "../phases/frame";
import type { BuilderSessionResult } from "./builder";
import type { GitRunner } from "./git";
import { buildPause, buildStop } from "./loop-outcomes";
import { appendAttempt, boundary, consecutive, elapsedByPhase, enforceFailureCap, restoreFailed, stateProgress, type BuildDeps, type Decision } from "./loop-support";
import { appendRecordedState, foldState } from "./state";
import { isUsageLimit, pauseInfo, type UsagePause } from "./usage";

/** Proactive pauses since the last attempt, pick, or transient stop: the consecutive window record §8 caps at three. */
export function consecutivePauses(events: readonly StoredEvent[]): number {
  const reset = events.findLast((event) => event.t === "attempt" || event.t === "feature.pick" || (event.t === "stop" && event.stopKind === "transient"))?.seq ?? 0;
  return events.filter((event) => event.t === "pause" && event.reason === "usage_limit" && event.seq > reset).length;
}

/** Record §12's boundary poll before a pick: pause at 95 percent, and stop once the third consecutive pause would follow two. */
export async function pauseBeforePick(deps: PhaseDeps, nowMs: number): Promise<PhaseResult | undefined> {
  const usage = await pauseInfo(deps, String(deps.models("builder").model.provider), false, nowMs);
  if (!usage) return undefined;
  if (consecutivePauses(deps.record.read()) >= 2) return buildStop(deps, "transient");
  return buildPause(deps, usage.reason, usage.wakeAt);
}

/**
 * The retry-window exit every transient or paused attempt shares: a spent wall is the deadline stop first (record §12 order),
 * then three consecutive of either kind stop the run.
 */
export function retryWindowExit(deps: BuildDeps, featureId: string, value: Decision, usage?: UsagePause): PhaseResult | undefined {
  if (value.disposition !== "transient" && value.disposition !== "paused") return undefined;
  if (phaseAvailableWallSeconds(deps.cfg.budgets, "build", elapsedByPhase(deps.record.read(), deps.now?.() ?? Date.now())) <= 0) return buildStop(deps, "deadline");
  if (value.disposition === "paused" && usage) {
    if (consecutive(deps.record.read(), featureId, ["paused"]) >= 3) return buildStop(deps, "transient");
    return buildPause(deps, usage.reason, usage.wakeAt);
  }
  if (value.disposition === "transient" && consecutive(deps.record.read(), featureId, ["transient"]) >= 3) return buildStop(deps, "transient");
  return undefined;
}

export interface TransientOutcome { exit?: PhaseResult }

/** A builder that failed transiently (record §12): an uncounted `transient` or `paused` attempt, no check, and the tree restored with its stat in the attempt's own entry. */
export async function handleBuilderTransient(deps: BuildDeps, arm: "fresh" | "single_session", project: ProjectPaths, git: GitRunner, feature: Feature, attempt: number, builder: BuilderSessionResult): Promise<TransientOutcome | undefined> {
  if (builder.stopped !== "error" || classifyFailure({ message: builder.error, status: builder.errorStatus }) !== "transient") return undefined;
  const usage = isUsageLimit(builder.errorStatus, builder.error) ? await pauseInfo(deps, builder.builderModelRef.split("/", 1)[0]!, true, deps.now?.() ?? Date.now()) : undefined;
  const value: Decision = { disposition: usage ? "paused" : "transient", counted: false, declarationOverruled: false };
  appendAttempt(deps, arm, feature, attempt, builder, 0, value);
  const held = foldState(deps.run)[feature.id]!;
  appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: held.state, to: "failed", attempt, attempts: held.attempts, repairs: held.repairs, reason: `builder_${value.disposition}` });
  const capped = enforceFailureCap(deps, feature.id, attempt, held.attempts);
  await boundary(deps, 7, feature.id, attempt);
  const discardStat = await restoreFailed(git, project, builder);
  stateProgress(deps, feature, attempt, false, `builder_${value.disposition}`, "attempt", discardStat);
  await boundary(deps, 10, feature.id, attempt); await boundary(deps, 11, feature.id, attempt);
  return { exit: capped ? undefined : retryWindowExit(deps, feature.id, value, usage) };
}
