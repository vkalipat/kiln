import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { phaseAvailableWallSeconds } from "../core/budget";
import type { StoredEvent } from "../core/events";
import { writeAtomic } from "../core/paths";
import { checkNeeds } from "../ideation/probe";
import type { FeaturesFile } from "../formation/features";
import { projectPaths, type ProjectPaths } from "../formation/paths";
import { assertShapeFrozen } from "../phases/guards";
import { readStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import type { PhaseResult } from "../phases/frame";
import { checkEnv } from "./env";
import { RealGitRunner, parseTrailers, type GitRunner } from "./git";
import { foldState, reconcileState, syncStateRecord, appendRecordedState } from "./state";
import { runCheck } from "./verify";
import { writeMetrics } from "./metrics";
import { regressionSweep } from "./sweep";
import { buildFail } from "./loop-outcomes";
import { repairAttemptProgress, repairAttemptStates, repairPassedAttempts } from "./loop-recovery";
import {
  BuildStepCrash, block, boundary, buildPhaseOpen, builderSession, elapsedByPhase, loadBuildFeatures, outstanding,
  restoreFailed, stateProgress, verifyBuildLock, type BuildDeps, type BuildIo,
} from "./loop-support";

export interface BuildEntry { features: FeaturesFile; project: ProjectPaths; git: GitRunner; discardStat?: string }
export type EntryOutcome = { exit: PhaseResult } | { entry: BuildEntry };

/** Record §12's resume routing: terminal outcomes and unchanged budget or deadline targets end before any paid call. */
function routeResume(deps: BuildDeps): PhaseResult | undefined {
  const previous = readStatus(deps.run);
  if (previous.state === "done" && previous.outcome?.kind === "honest_exit") return { outcome: "honest_exit", kind: "cannot_be_satisfied", reasons: previous.outcome.reasons ?? [] };
  if (previous.state === "failed" && previous.outcome?.failureClass) return { outcome: "failed", failureClass: previous.outcome.failureClass, message: previous.outcome.message ?? "build failed" };
  if (previous.state !== "stopped") return undefined;
  const targets = { budgetTargetUsd: previous.outcome?.budgetTargetUsd, wallTargetSeconds: previous.outcome?.wallTargetSeconds };
  if (previous.outcome?.stopKind === "budget" && deps.cfg.budgets.usd <= (targets.budgetTargetUsd ?? deps.cfg.budgets.usd)) return { outcome: "stopped", stopKind: "budget", ...targets };
  if (previous.outcome?.stopKind === "deadline" && deps.cfg.budgets.wallSeconds <= (targets.wallTargetSeconds ?? deps.cfg.budgets.wallSeconds)) return { outcome: "stopped", stopKind: "deadline", ...targets };
  return undefined;
}

/** Reversible blocks (record §12): a satisfied dependency or a newly interactive manual check re-enters `pending`. */
function reversible(deps: BuildDeps, features: FeaturesFile, io: BuildIo): void {
  const states = foldState(deps.run);
  for (const feature of features.features) {
    const state = states[feature.id]!; if (!state.blocked) continue;
    const reason = state.blockedReason ?? "";
    const needs = [...features.init.needs, ...(feature.acceptance.type === "manual" ? [] : feature.acceptance.needs ?? [])];
    const dependencyReady = reason.startsWith("missing_dependency:") && checkNeeds(needs, { env: checkEnv(needs) }).length === 0;
    const manualReady = reason === "not_verifiable" && feature.acceptance.type === "manual" && !deps.cfg.autonomous && io.ask !== undefined;
    if (dependencyReady || manualReady) {
      appendRecordedState(deps.run, deps.record, { t: "feature.state", featureId: feature.id, from: "blocked", to: "pending", attempts: state.attempts, repairs: state.repairs, reason: `unblocked:${reason}` });
      stateProgress(deps, feature, state.attempts, false, `unblocked:${reason}`);
    }
  }
}

/** A second declaration recorded before the crash still blocks the feature at entry. */
function blockDeclared(deps: BuildDeps, features: FeaturesFile): void {
  for (const feature of features.features) {
    const declarations = deps.record.read().filter((event) => event.t === "attempt" && event.featureId === feature.id && event.declaredUnsatisfiable).length;
    const state = foldState(deps.run)[feature.id]!;
    if (!state.blocked && !state.passes && declarations >= 2) { block(deps, feature.id, state, "declared_unsatisfiable"); stateProgress(deps, feature, state.attempts, false, "declared_unsatisfiable"); }
  }
}

async function initStage(deps: BuildDeps, stage: "check" | "commit"): Promise<void> {
  try { await deps.initHook?.(stage); throwIfRunCancelled(); }
  catch (error) { rethrowIfRunCancelled(error); throw new BuildStepCrash(0, "entry", error); }
}

interface InitStart {
  version: 1;
  runId: string;
  beforeHead: string;
  priorCheckSeq: number;
  reinit: boolean;
}

function initStartPath(deps: BuildDeps): string { return join(deps.run.dir, "init-start.json"); }

function readInitStart(deps: BuildDeps): InitStart | undefined {
  const path = initStartPath(deps); if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<InitStart>;
    if (value.version !== 1 || value.runId !== deps.run.id || typeof value.beforeHead !== "string" || !/^[0-9a-f]{40,64}$/i.test(value.beforeHead)
      || !Number.isInteger(value.priorCheckSeq) || (value.priorCheckSeq ?? -1) < 0 || typeof value.reinit !== "boolean") return undefined;
    return value as InitStart;
  } catch { return undefined; }
}

function writeInitStart(deps: BuildDeps, marker: InitStart): void {
  writeAtomic(initStartPath(deps), `${JSON.stringify(marker, null, 2)}\n`);
}

function clearInitStart(deps: BuildDeps): void { rmSync(initStartPath(deps), { force: true }); }

/**
 * Record §8 step 0: `init.sh` once per run under a 600 s deadline, committed as `chore(init)` with a `Kiln-Init` trailer.
 * `init-start.json` is written only after the clean-tree check and before dispatch. Its starting HEAD and prior check seq
 * prove which dirt an interrupted initial init or explicit reinit may discard; it stays until the check and commit finish.
 */
async function runInit(deps: BuildDeps, features: FeaturesFile, project: ProjectPaths, git: GitRunner): Promise<PhaseResult | undefined> {
  const events = deps.record.read();
  const init = events.findLast((event) => event.t === "check" && event.phase === "init");
  const featureStarted = events.some((event) => event.t === "feature.pick");
  const marker = readInitStart(deps);
  const markerComplete = marker !== undefined && (init?.seq ?? 0) > marker.priorCheckSeq;
  const commitInit = async () => {
    await git.commit(project.repo, { message: "chore(init)", trailers: { "Kiln-Init": deps.run.id, "Kiln-Run": deps.run.id } });
    await initStage(deps, "commit");
  };

  if (markerComplete) {
    if ((await git.statusPorcelain(project.repo)).trim()) await commitInit();
    clearInitStart(deps);
    return undefined;
  }

  if (marker) {
    await git.checkoutAndClean(project.repo, marker.beforeHead);
    const text = `restored interrupted ${marker.reinit ? "reinit" : "init"} to ${marker.beforeHead} before rerunning init.sh`;
    if (!events.some((event) => event.t === "note" && event.text === text)) deps.record.append({ t: "note", text });
  } else {
    const initCommitted = await git.hasTrailer(project.repo, "Kiln-Init", deps.run.id);
    const initDirty = (await git.statusPorcelain(project.repo)).trim() !== "";
    if (init && !initCommitted && initDirty && !featureStarted && !deps.reinit) { await commitInit(); return undefined; }
    if (init && !deps.reinit) return undefined;
    if (initDirty) return buildFail(deps, "integrity", "producer tree must be clean before init.sh");
    const dispatch: InitStart = { version: 1, runId: deps.run.id, beforeHead: await git.revParseHead(project.repo), priorCheckSeq: init?.seq ?? 0, reinit: deps.reinit === true };
    writeInitStart(deps, dispatch);
  }

  await (deps.runCheck ?? runCheck)({ type: "shell", command: "sh ../init.sh", timeoutSeconds: 600 }, {
    cwd: project.repo, checksDir: project.checksDir, timeoutMs: 600_000, maxOutputBytes: deps.cfg.build.checkOutputBytes,
    needs: features.init.needs, record: deps.record, attempt: 0, phase: "init",
  });
  await initStage(deps, "check");
  if ((await git.statusPorcelain(project.repo)).trim()) await commitInit();
  clearInitStart(deps);
  return undefined;
}

/**
 * Ruling L9: the harness holds `run.lock` and is the repo's single writer, so an `index.lock` left behind by a kill inside
 * `git add`, `commit` or `reset` is stale at entry. Removing it is noted once; a clean entry is silent.
 */
function clearStaleIndexLock(deps: BuildDeps, project: ProjectPaths): void {
  const path = join(project.repo, ".git", "index.lock");
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
  deps.record.append({ t: "note", text: `removed stale git index lock ${path} left by an interrupted git command` });
}

/** Repair a crash after the authoritative blocked transition but before its atomic evidence manifest. */
function repairBlockedArchives(deps: BuildDeps, features: FeaturesFile, project: ProjectPaths): void {
  const state = foldState(deps.run);
  for (const feature of features.features) {
    const held = state[feature.id]!;
    if (held.blocked && !existsSync(join(project.blockedDir, feature.id, "manifest.json"))) block(deps, feature.id, held, held.blockedReason ?? "blocked");
  }
}

/**
 * The crash window between a failed disposition and its restore (record §8): the latest failed session is restored to its
 * starting head only while nothing has been picked and no init has run since, so neither a later in-flight session's
 * uncommitted work nor a later `chore(init)` commit is ever wiped.
 */
async function restoreLatestFailure(deps: BuildDeps, project: ProjectPaths, git: GitRunner): Promise<string | undefined> {
  const events = deps.record.read();
  const latest = events.findLast((event) => event.t === "attempt");
  if (latest?.t !== "attempt" || latest.disposition === "passed") return undefined;
  const closesWindow = (event: StoredEvent) => event.t === "feature.pick" || event.t === "builder.session" || (event.t === "check" && event.phase === "init");
  if (events.some((event) => event.seq > latest.seq && closesWindow(event))) return undefined;
  const session = builderSession(events, latest.featureId, latest.attempt);
  return session ? restoreFailed(git, project, session) : undefined;
}

/** The resume-point discard (record §8): dirt with no in-flight session behind it is abandoned work; a session's work waits for its check. */
async function discardOrphanedWork(deps: BuildDeps, project: ProjectPaths, git: GitRunner): Promise<string | undefined> {
  if (!(await git.statusPorcelain(project.repo)).trim()) return undefined;
  const inFlight = outstanding(deps);
  if (inFlight && builderSession(deps.record.read(), inFlight.featureId, inFlight.attempt)) return undefined;
  const stat = await git.diff(project.repo, { stat: true });
  await git.checkoutAndClean(project.repo);
  return stat;
}

/** The sweep a resume owes (record §4): the latest sweep was incomplete, or the latest executed pass crashed before its sweep event. */
function owedSweep(events: readonly StoredEvent[]): string | undefined {
  const pass = events.findLast((event) => event.t === "feature.state" && event.to === "passed" && event.source === "executed");
  if (pass?.t === "feature.state" && !events.some((event) => event.t === "sweep" && event.seq > pass.seq && event.featureId === pass.featureId)) return pass.featureId;
  const sweep = events.findLast((event) => event.t === "sweep");
  return sweep?.t === "sweep" && !sweep.complete ? sweep.featureId : undefined;
}

/** An owed sweep is re-run at entry; a still-partial rerun is a recorded degradation the loop's precheck weighs, never a stop (ruling L10). */
async function replaySweep(deps: BuildDeps, features: FeaturesFile, project: ProjectPaths): Promise<void> {
  const trigger = owedSweep(deps.record.read());
  if (trigger === undefined) return;
  const state = foldState(deps.run);
  const passed = features.features.filter((feature) => feature.id !== trigger && state[feature.id]?.passes && state[feature.id]?.passSource === "executed");
  const wall = phaseAvailableWallSeconds(deps.cfg.budgets, "build", elapsedByPhase(deps.record.read(), deps.now?.() ?? Date.now()));
  await (deps.runSweep ?? regressionSweep)(deps, passed, { project, triggerFeatureId: trigger, remainingWallSeconds: wall, needs: features.init.needs, check: deps.runCheck });
}

/**
 * Build entry: shape guard, resume routing, authoritative record repair, the stale index-lock removal, the failed-attempt
 * restore, init, the resume-point discard and the sweep replay, through boundaries 0 and 1. The restore precedes init so a
 * `reinit` after a failed attempt starts clean and its `chore(init)` commit is never unwound. Returns either the phase result
 * that ends the run here or the context the loop iterates with.
 */
export async function enterBuild(deps: BuildDeps, io: BuildIo): Promise<EntryOutcome> {
  const shape = assertShapeFrozen(deps);
  if (shape) { try { writeMetrics(deps.run); } catch { /* status from the guard remains authoritative */ } return { exit: shape }; }
  const features = loadBuildFeatures(deps); const project = projectPaths(deps.run.project); const git = deps.git ?? new RealGitRunner();
  const routed = routeResume(deps); if (routed) return { exit: routed };
  if (!buildPhaseOpen(deps)) deps.record.append({ t: "phase.start", phase: "build" });
  syncStateRecord(deps.run, deps.record);
  repairBlockedArchives(deps, features, project);
  const lockAtEntry = verifyBuildLock(deps, features, project); if (lockAtEntry) return { exit: lockAtEntry };
  reversible(deps, features, io);
  const trailers = parseTrailers(await git.log(project.repo));
  reconcileState(deps.run, trailers, { requireAuthenticated: true, runId: deps.run.id, record: deps.record });
  repairAttemptStates(deps); repairPassedAttempts(deps, features, trailers); repairAttemptProgress(deps, features, trailers);
  blockDeclared(deps, features);
  clearStaleIndexLock(deps, project);
  const restored = await restoreLatestFailure(deps, project, git);
  const init = await runInit(deps, features, project, git); if (init) return { exit: init };
  await boundary(deps, 0);
  const discardStat = (await discardOrphanedWork(deps, project, git)) ?? restored;
  const lock = verifyBuildLock(deps, features, project); if (lock) return { exit: lock };
  const inFlight = outstanding(deps);
  await boundary(deps, 1, inFlight?.featureId, inFlight?.attempt);
  await replaySweep(deps, features, project);
  return { entry: { features, project, git, discardStat } };
}
