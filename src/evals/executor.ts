import { existsSync, readFileSync } from "node:fs";
import type { IdeaShape, Role } from "../core/config";
import { loadConfig } from "../core/config";
import type { StopKind, StoredEvent } from "../core/events";
import type { FailureClass } from "../core/failure";
import { Limiter } from "../core/limiter";
import { RunRecord } from "../core/record";
import { createRun, readStatus, runPaths, writeStatus, type RunOutcome, type RunStatus } from "../core/run";
import { runBuild, runBuildSingleSession, type BuildDeps } from "../phases/build";
import { runCheckpoint } from "../phases/checkpoint";
import { runDiscover } from "../phases/discover";
import { runForm } from "../phases/form";
import { runFrame, type PhaseDeps, type PhaseResult } from "../phases/frame";
import { runIdeate } from "../phases/ideate";
import { runBare } from "../ideation/bare";
import { readJsonIfPresent } from "../ideation/runtime";
import { createCliRuntime } from "../cli/runtime";
import type { CliDeps } from "../cli/main";
import type { Metrics } from "../build/metrics";
import { writeMetrics } from "../build/metrics";
import type { SeedIdentity } from "./identity";
import type { EvalCloneAfter, Effort } from "../core/config";

export interface ResolvedEffort { level: Effort; source: "profile" | "swept" | "config" | "fallback" }

export interface RunExecutorSpec {
  home: string;
  seedText: string;
  seedIdentity: SeedIdentity;
  arm: string;
  mode?: "loop" | "bare";
  buildArm?: "fresh" | "single_session";
  through: "ideate" | "form" | "build";
  cloneAfter: EvalCloneAfter;
  rounds: number;
  runId: string;
  effort: Partial<Record<Role, ResolvedEffort>>;
}

export interface RunSummary {
  runId: string;
  seedId: string;
  split: "dev" | "heldout";
  shape: IdeaShape | "unknown";
  arm: string;
  status: RunStatus;
  outcome?: RunOutcome;
  /** Censoring stops survive later phase transitions that clear `status.outcome`. */
  censorStops?: StopKind[];
  costUsd: number;
  metrics: Partial<Metrics>;
  frontier?: unknown;
}

export type RunExecutor = (spec: RunExecutorSpec) => Promise<RunSummary>;

export interface ExecutorDeps extends CliDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CENSORING = new Set<StopKind>(["budget", "deadline", "transient", "stalled"]);

/** The stop reasons that remove an entire cross-arm pair from statistical evidence. */
export function pairCensoredBy(runs: readonly RunSummary[]): StopKind[] {
  return [...new Set(runs.flatMap((run) => {
    const status = run.status;
    const durable = (run.censorStops ?? []).filter((stop) => CENSORING.has(stop));
    if (status.state === "paused") return [...durable, "deadline" as const];
    const stop = status.outcome?.kind === "stopped" ? status.outcome.stopKind : undefined;
    return stop && CENSORING.has(stop) ? [...durable, stop] : durable;
  }))];
}

function censorStops(events: readonly StoredEvent[]): StopKind[] {
  return [...new Set(events.flatMap((event) => event.t === "stop" && CENSORING.has(event.stopKind) ? [event.stopKind] : []))];
}

function phaseResult(status: RunStatus): PhaseResult {
  const outcome = status.outcome;
  if (outcome?.kind === "honest_exit") return { outcome: "honest_exit", kind: outcome.exitKind as never, reasons: outcome.reasons ?? [] };
  if (outcome?.kind === "failure") return { outcome: "failed", failureClass: outcome.failureClass ?? "verify", message: outcome.message ?? "run failed" };
  if (outcome?.kind === "stopped" && outcome.stopKind) return { outcome: "stopped", stopKind: outcome.stopKind };
  return { outcome: "ok" };
}

function terminal(status: RunStatus): boolean {
  return status.state === "done" || status.state === "failed" || status.state === "stopped";
}

async function wake(run: ReturnType<typeof runPaths>, deadline: number, deps: ExecutorDeps): Promise<boolean> {
  const status = readStatus(run);
  if (status.state !== "paused") return true;
  const wakeAt = Date.parse(status.wakeAt ?? "");
  const now = (deps.now ?? Date.now)();
  const wait = Number.isFinite(wakeAt) ? Math.max(0, wakeAt - now) : 0;
  if (now + wait > deadline) return false;
  if (wait > 0) await (deps.sleep ?? ((ms) => Bun.sleep(ms)))(wait);
  writeStatus(run, { state: "running", outcome: undefined, pausedReason: undefined, wakeAt: undefined });
  return true;
}

function readMetrics(run: ReturnType<typeof runPaths>): Partial<Metrics> {
  try { return writeMetrics(run); }
  catch {
    try { return JSON.parse(readFileSync(run.metrics, "utf8")) as Partial<Metrics>; }
    catch { return {}; }
  }
}

/** Production executor factory. Credentials come from `realHome`; all artifacts stay in spec.home. */
export function createRunExecutor(realHome: string, deps: ExecutorDeps = {}): RunExecutor {
  const execute = async (spec: RunExecutorSpec, heldDeadline?: number, resumes = 0): Promise<RunSummary> => {
    const cfg = loadConfig(spec.home);
    cfg.autonomous = true;
    cfg.ideation.rounds = spec.rounds;
    if (cfg.evals.runBudgetUsd !== undefined) cfg.budgets.usd = cfg.evals.runBudgetUsd;
    if (cfg.evals.runWallSeconds !== undefined) cfg.budgets.wallSeconds = cfg.evals.runWallSeconds;
    cfg.effortByRole = { ...cfg.effortByRole, ...Object.fromEntries(Object.entries(spec.effort).map(([role, value]) => [role, value?.level])) };
    const runtime = await createCliRuntime(realHome, cfg, { ...deps, runtimeEffort: { enabled: false } });
    const prior = runPaths(spec.home, spec.runId);
    if (spec.cloneAfter !== "none" && !existsSync(prior.status)) throw new Error(`cloned eval run ${spec.runId} does not exist`);
    const run = existsSync(prior.status) ? prior : createRun(spec.home, spec.seedText, { id: spec.runId });
    let status = readStatus(run);
    if (status.seed && (status.seed.id !== spec.seedIdentity.id || status.seed.sha256 !== spec.seedIdentity.sha256)) throw new Error(`seed identity drift for ${spec.runId}`);
    if (!status.seed) writeStatus(run, { seed: spec.seedIdentity, ideationRounds: spec.rounds });
    const record = new RunRecord(run.record);
    if (!record.read().some((event) => event.t === "run.created")) record.append({ t: "run.created", seed: spec.seedText });
    const base: PhaseDeps = {
      home: spec.home, run, record, cfg, models: runtime.models, modelsOn: runtime.modelsOn,
      availableProviders: runtime.available, apiKeyFor: runtime.apiKeyFor, streamFn: deps.streamFn,
      effort: cfg.effort, fetchImpl: deps.fetchImpl, fetchUsage: runtime.fetchUsage,
      limiter: new Limiter(cfg.ideation.concurrency),
    };
    const deadline = heldDeadline ?? (deps.now ?? Date.now)() + cfg.budgets.wallSeconds * 1_000;
    if (status.state === "paused") {
      if (!await wake(run, deadline, deps)) {
        return {
          runId: run.id, seedId: spec.seedIdentity.id, split: spec.seedIdentity.split,
          shape: status.shape ?? "unknown", arm: spec.arm, status, outcome: status.outcome,
          censorStops: censorStops(record.read()), costUsd: record.costUsd(), metrics: readMetrics(run), frontier: readJsonIfPresent(run.frontier),
        };
      }
      status = readStatus(run);
    }
    let result: PhaseResult = phaseResult(status);
    if (!terminal(status) && status.phase === "frame") result = await (deps.runFrame ?? runFrame)(base);
    status = readStatus(run);
    if (result.outcome === "ok" && status.phase === "discover" && status.state === "running") result = await (deps.runDiscover ?? runDiscover)(base);
    status = readStatus(run);
    if (result.outcome === "ok" && status.phase === "ideate" && status.cursor?.step !== "checkpoint") {
      const bare = spec.mode === "bare" || spec.arm === "bare" || spec.arm === "B0";
      if (!bare && cfg.evals.judgeGate === "removed") throw new Error("judge_removed: eval execution cannot enter judge-dependent ideation");
      result = bare ? await (deps.runBare ?? runBare)(base) : await (deps.runIdeate ?? runIdeate)(base);
    }
    status = readStatus(run);
    if (status.state === "paused" && await wake(run, deadline, deps)) {
      if (resumes >= 100) throw new Error(`eval run ${spec.runId} exceeded 100 pause resumptions`);
      return execute(spec, deadline, resumes + 1);
    }
    const checkpointReady = status.phase === "ideate" && (status.cursor?.step === "checkpoint" || (
      existsSync(run.frontier) && status.outcome?.kind === "stopped" && ["rounds", "stagnant", "budget"].includes(status.outcome.stopKind ?? "")
    ));
    if (spec.through !== "ideate" && checkpointReady) {
      result = await (deps.runCheckpoint ?? runCheckpoint)(base, { write: () => {}, ask: async () => "" }, { autonomous: true });
      status = readStatus(run);
    }
    if (spec.through !== "ideate" && result.outcome === "ok" && status.phase === "form" && status.state === "running") {
      result = await (deps.runForm ?? runForm)(base, status.chosenIdeaId, { io: { write: () => {}, ask: async () => "no" } });
      status = readStatus(run);
    }
    if (spec.through === "build" && result.outcome === "ok" && status.phase === "build" && status.state !== "paused") {
      const buildDeps: BuildDeps = { ...base, ...(deps.buildDeps ?? {}) };
      const single = spec.buildArm === "single_session" || spec.arm === "single_session";
      const runner = single ? (deps.runBuildSingleSession ?? runBuildSingleSession) : (deps.runBuild ?? runBuild);
      result = await runner(buildDeps, { ask: async () => "no" });
      status = readStatus(run);
    }
    if (status.state === "paused" && await wake(run, deadline, deps)) {
      if (resumes >= 100) throw new Error(`eval run ${spec.runId} exceeded 100 pause resumptions`);
      return execute(spec, deadline, resumes + 1);
    }
    status = readStatus(run);
    writeStatus(run, { usdSpent: record.costUsd() });
    return {
      runId: run.id, seedId: spec.seedIdentity.id, split: spec.seedIdentity.split,
      shape: status.shape ?? "unknown", arm: spec.arm, status, outcome: status.outcome,
      censorStops: censorStops(record.read()), costUsd: record.costUsd(), metrics: readMetrics(run), frontier: readJsonIfPresent(run.frontier),
    };
  };
  return (spec) => execute(spec);
}
