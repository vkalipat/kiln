import type { PhaseDeps } from "../phases/frame";
import type { Feature } from "../formation/features";
import type { ProjectPaths } from "../formation/paths";
import { archiveBlocked } from "./blocked";
import { readAudits } from "./audit-contract";
import { appendRecordedState, foldState } from "./state";
import { runCheck, type CheckResult, type RunCheckOptions } from "./verify";
import { appendProgress } from "./progress";

export interface SweepOptions {
  project: ProjectPaths;
  triggerFeatureId: string;
  remainingWallSeconds: number;
  needs?: string[];
  check?: (acceptance: Feature["acceptance"], options: RunCheckOptions) => Promise<CheckResult>;
  now?: () => number;
}

export interface SweepResult {
  regressed: string[];
  scope: "full" | "partial";
  skipped: string[];
  seconds: number;
}

function latestPassingDurations(deps: PhaseDeps): Map<string, number> {
  const events = deps.record.read();
  const voided = new Set(events.flatMap((event) => event.t === "audit.disposition" && event.checkVoided ? [event.checkId] : []));
  const out = new Map<string, number>();
  for (const event of events) {
    if (event.t === "check" && event.featureId && event.ok && !voided.has(event.checkId)) out.set(event.featureId, event.durationMs);
  }
  return out;
}

function selected(deps: PhaseDeps, passed: readonly Feature[], wallSeconds: number): { run: Feature[]; skipped: string[]; scope: "full" | "partial" } {
  const events = deps.record.read();
  const passSeq = new Map<string, number>();
  for (const event of events) if (event.t === "feature.state" && event.to === "passed") passSeq.set(event.featureId, event.seq);
  const ordered = [...passed].sort((a, b) => (passSeq.get(a.id) ?? 0) - (passSeq.get(b.id) ?? 0));
  const projected = ordered.length * deps.cfg.build.expectedCheckSeconds;
  if (projected <= wallSeconds) return { run: ordered, skipped: [], scope: "full" };
  const everRegressed = new Set(events.flatMap((event) => event.t === "feature.state" && event.to === "regressed" ? [event.featureId] : []));
  const capacity = Math.max(0, Math.floor(wallSeconds / Math.max(1, deps.cfg.build.expectedCheckSeconds)));
  const chosen = new Set(ordered.filter((feature) => everRegressed.has(feature.id)).map((feature) => feature.id));
  for (const feature of ordered.toReversed()) {
    if (chosen.size >= capacity && !everRegressed.has(feature.id)) continue;
    chosen.add(feature.id);
  }
  return { run: ordered.filter((feature) => chosen.has(feature.id)), skipped: ordered.filter((feature) => !chosen.has(feature.id)).map((feature) => feature.id), scope: "partial" };
}

function archive(deps: PhaseDeps, featureId: string, check: CheckResult): void {
  const event = deps.record.read().findLast((value) => value.t === "check" && value.checkId === check.checkId);
  const audit = readAudits(deps.run).findLast((value) => value.featureId === featureId);
  archiveBlocked(deps.run, featureId, { check: { path: check.outputPath, eventSeq: event?.seq ?? 0 }, audit });
}

export async function regressionSweep(deps: PhaseDeps, passed: readonly Feature[], options: SweepOptions): Promise<SweepResult> {
  const clock = options.now ?? Date.now;
  const started = clock();
  const plan = selected(deps, passed, options.remainingWallSeconds);
  const durations = latestPassingDurations(deps);
  const regressed: string[] = [];
  const skipped = [...plan.skipped];
  /** A skip outside the planned selection is recorded with its reason; it leaves the sweep incomplete without making it partial (ruling L10). */
  const skip = (featureId: string, reason: string) => { skipped.push(featureId); deps.record.append({ t: "note", text: `sweep for ${options.triggerFeatureId} skipped ${featureId}: ${reason}` }); };
  let run = 0;
  for (const feature of plan.run) {
    const elapsed = Math.max(0, clock() - started);
    const wallMs = Math.max(0, options.remainingWallSeconds * 1_000 - elapsed);
    if (wallMs < 5_000) { skip(feature.id, "remaining wall below the 5 s dispatch floor"); continue; }
    const priorMs = durations.get(feature.id) ?? deps.cfg.build.expectedCheckSeconds * 1_000;
    const timeoutMs = Math.min(deps.cfg.build.checkTimeoutSeconds * 1_000, Math.max(5_000, 2 * priorMs), wallMs);
    const state = foldState(deps.run)[feature.id]!;
    const result = await (options.check ?? runCheck)(feature.acceptance, {
      cwd: options.project.repo, checksDir: options.project.checksDir, timeoutMs,
      maxOutputBytes: deps.cfg.build.checkOutputBytes, needs: options.needs ?? [], record: deps.record,
      featureId: feature.id, attempt: state.attempts, phase: "regression",
    });
    run += 1;
    if (result.notRunReason) { skip(feature.id, result.notRunReason); continue; }
    if (result.ok) continue;
    const repairs = state.repairs + 1;
    appendRecordedState(deps.run, deps.record, {
      t: "feature.state", featureId: feature.id, from: "passed", to: "regressed",
      attempt: state.attempts, attempts: 0, repairs, regressedBy: options.triggerFeatureId,
    });
    appendProgress(deps.run, { featureId: feature.id, attempt: state.attempts, kind: "regression", entryId: `regressed-${result.checkId}`, check: { ...result, excerpt: result.output, notRunReason: `regressed_by:${options.triggerFeatureId}` } });
    regressed.push(feature.id);
    // Ruling L11: `maxRegressionRepairs` repairs are allowed; the regression that would need one more blocks the feature.
    if (repairs > deps.cfg.build.maxRegressionRepairs) {
      appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: "regressed", to: "blocked", attempt: state.attempts, attempts: 0, repairs, reason: "regression_unrepairable" });
      appendProgress(deps.run, { featureId: feature.id, attempt: state.attempts, kind: "regression", entryId: `blocked-${result.checkId}`, check: { ...result, excerpt: result.output, notRunReason: "regression_unrepairable" } });
      archive(deps, feature.id, result);
    }
  }
  const uniqueSkipped = [...new Set(skipped)];
  const seconds = Math.max(0, clock() - started) / 1_000;
  const scope = plan.scope;
  deps.record.append({
    t: "sweep", featureId: options.triggerFeatureId, planned: passed.length, run,
    skipped: uniqueSkipped, durationMs: Math.round(seconds * 1_000), complete: uniqueSkipped.length === 0, scope,
  });
  return { regressed, scope, skipped: uniqueSkipped, seconds };
}
