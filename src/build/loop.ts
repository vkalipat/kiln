import { attemptCeiling, phaseAvailableUsd, phaseAvailableWallSeconds } from "../core/budget";
import { classifyFailure } from "../core/failure";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { checkNeeds } from "../ideation/probe";
import { derivedCaps, type Feature, type FeaturesFile } from "../formation/features";
import type { PhaseDeps, PhaseResult } from "../phases/frame";
import { checkEnv } from "./env";
import { appendRecordedState, foldState } from "./state";
import { runCheck, type CheckResult } from "./verify";
import { createBuilderDriver, runBuilderSession, type BuilderDriver, type BuilderSessionResult } from "./builder";
import { AuditorRunError, runAuditorSession, type AuditorSessionResult } from "./auditor";
import { appendProgress, type ProgressIteration } from "./progress";
import { regressionSweep } from "./sweep";
import { buildHonest, buildStop, buildSuccess, buildFail } from "./loop-outcomes";
import { isUsageLimit, pauseInfo } from "./usage";
import { enterBuild } from "./loop-entry";
import { handleBuilderTransient, pauseBeforePick, retryWindowExit } from "./loop-transient";
import { existingFeatureCommit } from "./loop-recovery";
import {
  BuildStepCrash, activeCheck, appendAttempt, appendBuilderSession, auditorSession, block, boundary, builderSession, elapsedByPhase,
  enforceFailureCap, featureSpend, outstanding, recordBuilderRefusal, recordCheckTimeout, restoreFailed, spentByPhase, stateProgress, verifyBuildLock, type BuildDeps, type BuildIo, type Decision,
} from "./loop-support";

export { BuildStepCrash, type AskFn, type BuildDeps, type BuildIo } from "./loop-support";

function nextAttempt(deps: PhaseDeps, featureId: string): number {
  return deps.record.read().reduce((max, event) => event.t === "feature.pick" && event.featureId === featureId ? Math.max(max, event.attempt) : max, 0) + 1;
}

function pick(deps: PhaseDeps, features: FeaturesFile, remainingUsd: number): { feature: Feature; attempt: number; ceiling: number } | undefined {
  const state = foldState(deps.run); const remaining = features.features.filter((feature) => !state[feature.id]!.passes && !state[feature.id]!.blocked);
  for (const feature of remaining) {
    const held = state[feature.id]!;
    if (held.attempts >= deps.cfg.build.maxAttempts) { block(deps, feature.id, held, "attempts_exhausted"); stateProgress(deps, feature, held.attempts, false, "attempts_exhausted"); continue; }
    const needs = [...features.init.needs, ...(feature.acceptance.type === "manual" ? [] : feature.acceptance.needs ?? [])];
    const missing = checkNeeds(needs, { env: checkEnv(needs) });
    if (missing.length > 0) {
      const reason = `missing_dependency:${missing[0]}`;
      block(deps, feature.id, held, reason); stateProgress(deps, feature, 0, false, reason); continue;
    }
    const live = foldState(deps.run);
    const remainingCount = features.features.filter((candidate) => !live[candidate.id]!.passes && !live[candidate.id]!.blocked).length;
    const ceiling = Math.max(deps.cfg.build.maxAttempts * deps.cfg.build.expectedAttemptUsd, attemptCeiling(deps.cfg), remainingUsd / Math.max(1, remainingCount));
    if (featureSpend(deps.record.read(), feature.id) >= ceiling) { block(deps, feature.id, held, "feature_budget"); stateProgress(deps, feature, held.attempts, false, "feature_budget"); continue; }
    return { feature, attempt: nextAttempt(deps, feature.id), ceiling };
  }
  return undefined;
}

function decision(builder: BuilderSessionResult, check: CheckResult, audit: AuditorSessionResult): Decision {
  if (builder.stopped === "refused") return { disposition: "refused", counted: false, declarationOverruled: false };
  if (audit.finalCheckVoided) return { disposition: "verify_failed", counted: true, declarationOverruled: false };
  if (check.ok && audit.effectiveVerdict === "agree") return { disposition: "passed", counted: true, declarationOverruled: (builder.exitReasons?.length ?? 0) > 0 };
  if (check.ok) return { disposition: "audit_disagreed", counted: true, declarationOverruled: false };
  if ((builder.exitReasons?.length ?? 0) > 0) return { disposition: "declared_failed", counted: true, declarationOverruled: false };
  if (builder.stalled) return { disposition: "stalled", counted: true, declarationOverruled: false };
  if (builder.stopped === "turn_cap" || builder.stopped === "usd_cap") return { disposition: "budget", counted: true, declarationOverruled: false };
  if (builder.stopped === "error" && classifyFailure({ message: builder.error, status: builder.errorStatus }) === "transient") return { disposition: "transient", counted: false, declarationOverruled: false };
  return { disposition: "verify_failed", counted: true, declarationOverruled: false };
}

function acceptanceText(feature: Feature): string {
  return feature.acceptance.type === "shell" ? feature.acceptance.command : feature.acceptance.type === "file" ? feature.acceptance.path : feature.acceptance.instructions;
}

function failAttemptState(deps: BuildDeps, feature: Feature, attempt: number, value: Decision, reason: string, refusalCategory?: string): boolean {
  const held = foldState(deps.run)[feature.id]!;
  const attempts = held.attempts + (value.counted ? 1 : 0);
  appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: held.state, to: "failed", attempt, attempts, repairs: held.repairs, reason });
  const events = deps.record.read();
  const current = foldState(deps.run)[feature.id]!;
  if (value.disposition === "refused" && events.filter((event) => event.t === "attempt" && event.featureId === feature.id && event.disposition === "refused").length >= 2) {
    block(deps, feature.id, current, `refused:${refusalCategory ?? "unknown"}`, attempt);
    return true;
  }
  if (value.disposition === "declared_failed" && events.filter((event) => event.t === "attempt" && event.featureId === feature.id && event.declaredUnsatisfiable).length >= 2) {
    block(deps, feature.id, current, "declared_unsatisfiable", attempt);
    return true;
  }
  return enforceFailureCap(deps, feature.id, attempt, attempts);
}

async function runInternal(deps: BuildDeps, io: BuildIo, arm: "fresh" | "single_session"): Promise<PhaseResult> {
  const entered = await enterBuild(deps, io);
  if ("exit" in entered) return entered.exit;
  const { features, project, git } = entered.entry; let discardStat = entered.entry.discardStat;
  /** A discarded `--stat` is recorded exactly once, in the next progress entry (record §8). */
  const progress = (iteration: Omit<ProgressIteration, "discardStat">) => { appendProgress(deps.run, { ...iteration, discardStat }); discardStat = undefined; };

  const aggregateAttempts = derivedCaps(deps.cfg).maxFeatures * deps.cfg.build.expectedAttempts;
  let driver: BuilderDriver | undefined;

  for (;;) {
    const now = deps.now?.() ?? Date.now(); const events = deps.record.read(); const state = foldState(deps.run);
    const loopLock = verifyBuildLock(deps, features, project); if (loopLock) return loopLock;
    if (!outstanding(deps) && (await git.statusPorcelain(project.repo)).trim()) {
      discardStat = await git.diff(project.repo, { stat: true });
      await git.checkoutAndClean(project.repo);
    }
    if (features.features.every((feature) => state[feature.id]!.passes)) return buildSuccess(deps);
    const usd = phaseAvailableUsd(deps.cfg.budgets, "build", spentByPhase(events));
    const wall = phaseAvailableWallSeconds(deps.cfg.budgets, "build", elapsedByPhase(events, now));
    const pending = outstanding(deps);
    const selected = pending ? { feature: features.features.find((value) => value.id === pending.featureId)!, attempt: pending.attempt, ceiling: 0 } : pick(deps, features, usd);
    if (!selected) {
      const fresh = foldState(deps.run); const executed = Object.values(fresh).filter((value) => value.passes && value.passSource === "executed").length;
      const declared = Object.entries(fresh).filter(([, value]) => value.blockedReason === "declared_unsatisfiable");
      if (executed === 0 && declared.length > 0) {
        const ids = new Set(declared.map(([id]) => id));
        const reasons = [...new Set(deps.record.read().flatMap((event) => event.t === "attempt" && ids.has(event.featureId) && event.declaredUnsatisfiable ? event.declarationReasons : []))];
        return buildHonest(deps, reasons.length > 0 ? reasons : declared.map(([id]) => `${id} was declared unsatisfiable twice`));
      }
      return buildStop(deps, "blocked");
    }
    const { feature, attempt } = selected;
    if (!pending) {
      // Stop precedence (record §12): deadline, then the pause window's transient stop, then budget.
      if (wall <= 0) return buildStop(deps, "deadline");
      const paused = await pauseBeforePick(deps, now); if (paused) return paused;
      if (usd < attemptCeiling(deps.cfg)) return buildStop(deps, "budget");
      deps.record.append({ t: "feature.pick", featureId: feature.id, attempt, phaseBudgetUsd: usd, featureBudgetUsd: selected.ceiling });
    }
    await boundary(deps, 2, feature.id, attempt);

    if (feature.acceptance.type === "manual") {
      const answer = !deps.cfg.autonomous && io.ask ? await io.ask(`Does ${feature.id} pass manual verification?`) : "";
      throwIfRunCancelled();
      const yes = /^(y|yes)$/i.test(answer.trim());
      const held = foldState(deps.run)[feature.id]!;
      if (yes) {
        appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: held.state, to: "passed", attempt, source: "human", attempts: held.attempts, repairs: held.repairs });
        stateProgress(deps, feature, attempt, true, "human verified: yes");
      } else {
        block(deps, feature.id, held, "not_verifiable", attempt); stateProgress(deps, feature, attempt, false, "not_verifiable");
      }
      await boundary(deps, 11, feature.id, attempt); continue;
    }

    let builder = builderSession(deps.record.read(), feature.id, attempt);
    if (!builder) {
      if (arm === "single_session" && !driver) {
        const historical = deps.record.read();
        // Model calls are the spend authority: a cancellation can land after a paid response is
        // journalled but before the enclosing builder.session is durable. Session sums would then
        // undercount on every resume (and summing both would double-charge completed sessions).
        const priorCost = historical.reduce((sum, event) => event.t === "model.call" && event.role === "builder" ? sum + event.costUsd : sum, 0);
        const priorTurns = historical.filter((event) => event.t === "turn" && event.role === "builder" && event.phase === "build").length;
        driver = (deps.createDriver ?? createBuilderDriver)(deps, { project, git, turnCap: deps.cfg.build.sessionTurnCap * aggregateAttempts, usdCap: deps.cfg.build.builderUsdCap * aggregateAttempts, priorSpentUsd: () => priorCost, priorTurns: () => priorTurns });
      }
      builder = driver ? await driver.runFeature(feature, { attempt }) : await (deps.runBuilder ?? runBuilderSession)(deps, feature, { project, git, attempt });
      appendBuilderSession(deps, feature.id, attempt, arm, builder);
      if (builder.headMoved) deps.record.append({ t: "failure", class: "policy", message: `builder moved HEAD for ${feature.id} attempt ${attempt}` });
    }
    const refusalCategory = recordBuilderRefusal(deps, feature.id, attempt, builder);
    await boundary(deps, 3, feature.id, attempt);
    const postBuilderLock = verifyBuildLock(deps, features, project); if (postBuilderLock) return postBuilderLock;
    await boundary(deps, 4, feature.id, attempt);

    const transient = await handleBuilderTransient(deps, arm, project, git, feature, attempt, builder);
    if (transient) { if (transient.exit) return transient.exit; continue; }

    let captured = activeCheck(deps.record.read(), feature.id, attempt);
    if (!captured.check) {
      const precheckLock = verifyBuildLock(deps, features, project); if (precheckLock) return precheckLock;
      const wallMs = Math.max(1, Math.floor(phaseAvailableWallSeconds(deps.cfg.budgets, "build", elapsedByPhase(deps.record.read(), deps.now?.() ?? Date.now())) * 1_000));
      captured = { check: await (deps.runCheck ?? runCheck)(feature.acceptance, {
        cwd: project.repo, checksDir: project.checksDir, timeoutMs: Math.min(deps.cfg.build.checkTimeoutSeconds * 1_000, wallMs),
        maxOutputBytes: deps.cfg.build.checkOutputBytes, needs: features.init.needs, record: deps.record, featureId: feature.id, attempt, phase: "acceptance",
      }), finalVoided: false, recovered: false };
    }
    await boundary(deps, 5, feature.id, attempt);
    const checked = captured.check;
    if (!checked) throw new Error(`integrity: acceptance check missing for ${feature.id} attempt ${attempt}`);

    let audit = captured.finalVoided ? undefined : auditorSession(deps, feature.id, attempt, checked);
    let auditError: AuditorRunError | undefined;
    if (!audit) {
      try { audit = await (deps.runAuditor ?? runAuditorSession)(deps, feature, checked, { project, git, attempt, builderRef: builder.builderModelRef, needs: features.init.needs, recoverVoided: captured.finalVoided }); }
      catch (error) { if (error instanceof AuditorRunError) auditError = error; else throw error; }
    }
    await boundary(deps, 6, feature.id, attempt);

    if (auditError) {
      const kind = auditError.result.stopped === "usd_cap" ? "budget" : classifyFailure({ message: auditError.message, status: auditError.result.errorStatus });
      const builderRefused = builder.stopped === "refused";
      const usage = !builderRefused && isUsageLimit(auditError.result.errorStatus, auditError.message) ? await pauseInfo(deps, String(deps.models("auditor").model.provider), true, deps.now?.() ?? Date.now()) : undefined;
      const value: Decision = builderRefused
        ? { disposition: "refused", counted: false, declarationOverruled: false }
        : { disposition: usage ? "paused" : kind === "transient" ? "transient" : kind === "budget" ? "budget" : "verify_failed", counted: kind !== "transient" && !usage, declarationOverruled: false };
      appendAttempt(deps, arm, feature, attempt, builder, auditError.costUsd, value);
      const capped = failAttemptState(deps, feature, attempt, value, builderRefused ? "refused" : `auditor_${kind}`, refusalCategory);
      await boundary(deps, 7, feature.id, attempt);
      discardStat = await restoreFailed(git, project, builder);
      progress({ featureId: feature.id, attempt, kind: "attempt", entryId: `attempt-${attempt}`, check: { ...checked, excerpt: checked.output } });
      await boundary(deps, 10, feature.id, attempt); await boundary(deps, 11, feature.id, attempt);
      const exit = capped ? undefined : retryWindowExit(deps, feature.id, value, usage); if (exit) return exit;
      continue;
    }
    audit = audit!;
    const active = audit.check;
    if (active.notRunReason?.startsWith("missing_dependency:")) {
      appendAttempt(deps, arm, feature, attempt, builder, audit.costUsd, { disposition: "verify_failed", counted: false, declarationOverruled: false });
      block(deps, feature.id, foldState(deps.run)[feature.id]!, active.notRunReason, attempt);
      await boundary(deps, 7, feature.id, attempt);
      discardStat = await restoreFailed(git, project, builder);
      progress({ featureId: feature.id, attempt, kind: "attempt", entryId: `attempt-${attempt}`, check: { ...active, excerpt: active.output }, audit });
      await boundary(deps, 10, feature.id, attempt); await boundary(deps, 11, feature.id, attempt); continue;
    }
    let value = decision(builder, active, audit);
    if (value.disposition !== "passed") {
      recordCheckTimeout(deps, feature.id, attempt, active);
      appendAttempt(deps, arm, feature, attempt, builder, audit.costUsd, value);
      failAttemptState(deps, feature, attempt, value, value.disposition, refusalCategory);
      await boundary(deps, 7, feature.id, attempt);
      discardStat = await restoreFailed(git, project, builder);
      progress({ featureId: feature.id, attempt, kind: "attempt", entryId: `attempt-${attempt}`, check: { ...active, excerpt: active.output }, audit });
      await boundary(deps, 10, feature.id, attempt); await boundary(deps, 11, feature.id, attempt);
      if (foldState(deps.run)[feature.id]!.blocked) continue;
      const exit = retryWindowExit(deps, feature.id, value); if (exit) return exit;
      continue;
    }
    await boundary(deps, 7, feature.id, attempt);

    let sha: string; let empty = false;
    try {
      // A commit this exact attempt already made before a crash is adopted, never repeated (record §8).
      const adopted = await existingFeatureCommit(git, project.repo, { runId: deps.run.id, featureId: feature.id, attempt, checkId: active.checkId });
      if (adopted === undefined) {
        empty = (await git.statusPorcelain(project.repo)).trim() === "";
        sha = await git.commit(project.repo, {
          message: `feat(${feature.id}): ${feature.title}\n\nAcceptance: ${acceptanceText(feature)}\nExit: ${active.exitCode ?? (active.ok ? 0 : "n/a")}\nDuration: ${active.durationMs}ms`,
          trailers: { "Kiln-Feature": feature.id, "Kiln-Run": deps.run.id, "Kiln-Attempt": attempt, "Kiln-Check": active.checkId }, allowEmpty: true,
        });
      } else sha = adopted;
      if (!deps.record.read().some((event) => event.t === "commit" && event.sha === sha)) {
        if (adopted !== undefined) deps.record.append({ t: "note", text: `adopted feature commit ${sha} already made for ${feature.id} attempt ${attempt} check ${active.checkId}` });
        deps.record.append({ t: "commit", featureId: feature.id, attempt, sha, empty });
      }
    } catch (error) {
      rethrowIfRunCancelled(error);
      if (error instanceof BuildStepCrash) throw error;
      value = { disposition: "commit_failed", counted: true, declarationOverruled: value.declarationOverruled };
      appendAttempt(deps, arm, feature, attempt, builder, audit.costUsd, value);
      deps.record.append({ t: "failure", class: "verify", message: `feature commit failed: ${(error as Error).message}` });
      const held = foldState(deps.run)[feature.id]!; const attempts = held.attempts + 1;
      appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: held.state, to: "failed", attempt, attempts, repairs: held.repairs, reason: "commit_failed" });
      enforceFailureCap(deps, feature.id, attempt, attempts);
      await boundary(deps, 8, feature.id, attempt);
      discardStat = await restoreFailed(git, project, builder);
      progress({ featureId: feature.id, attempt, kind: "attempt", entryId: `attempt-${attempt}`, check: { ...active, excerpt: active.output }, audit, commit: { error: (error as Error).message } });
      await boundary(deps, 10, feature.id, attempt); await boundary(deps, 11, feature.id, attempt); continue;
    }
    appendAttempt(deps, arm, feature, attempt, builder, audit.costUsd, value);
    await boundary(deps, 8, feature.id, attempt);
    const held = foldState(deps.run)[feature.id]!;
    appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: held.state, to: "passed", attempt, source: "executed", attempts: held.attempts + 1, repairs: held.repairs, commitSha: sha });
    const before = features.features.filter((candidate) => candidate.id !== feature.id && foldState(deps.run)[candidate.id]?.passes && foldState(deps.run)[candidate.id]?.passSource === "executed");
    const remainingWall = phaseAvailableWallSeconds(deps.cfg.budgets, "build", elapsedByPhase(deps.record.read(), deps.now?.() ?? Date.now()));
    // A partial sweep is a recorded degradation, not a stop (ruling L10): the next iteration's precheck weighs the wall.
    await (deps.runSweep ?? regressionSweep)(deps, before, { project, triggerFeatureId: feature.id, remainingWallSeconds: remainingWall, needs: features.init.needs, check: deps.runCheck });
    await boundary(deps, 9, feature.id, attempt);
    progress({ featureId: feature.id, attempt, kind: "attempt", entryId: `attempt-${attempt}`, check: { ...active, excerpt: active.output }, audit, commit: { sha, empty } });
    await boundary(deps, 10, feature.id, attempt); await boundary(deps, 11, feature.id, attempt);
  }
}

async function guarded(deps: BuildDeps, io: BuildIo, arm: "fresh" | "single_session"): Promise<PhaseResult> {
  throwIfRunCancelled();
  try { const result = await runInternal(deps, io, arm); throwIfRunCancelled(); return result; }
  catch (error) {
    rethrowIfRunCancelled(error);
    if (error instanceof BuildStepCrash) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const failureClass = /^(integrity:|cannot read|acceptance lock)/i.test(message) ? "integrity" : "verify";
    return buildFail(deps, failureClass, message);
  }
}

export function runBuild(deps: BuildDeps, io: BuildIo = {}): Promise<PhaseResult> { return guarded(deps, io, "fresh"); }
export function runBuildSingleSession(deps: BuildDeps, io: BuildIo = {}): Promise<PhaseResult> { return guarded(deps, io, "single_session"); }
