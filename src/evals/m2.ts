import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KilnConfig, Role } from "../core/config";
import { ensureDir, writeAtomic } from "../core/paths";
import { cloneRunAcrossHomes, findPublishedCloneAcrossHomes } from "./clone";
import { createRunExecutor, pairCensoredBy, type ExecutorDeps, type ResolvedEffort, type RunExecutor, type RunExecutorSpec, type RunSummary } from "./executor";
import { verifyEvalsManifest } from "./manifest";
import { loadSeeds } from "./seeds";
import { stageHome, type StagedHome } from "../evolution/stage";
import { runtimeFor } from "../evolution/stage";
import { effortsSwept, readEffortFile, resolveEffort } from "./effort";
import { judgeCalibration } from "./calibrate";
import type { JudgeCalibrationStamp } from "./report";
import { derivedCaps, PROJECTED_FORMATION_USD } from "../formation/features";
import { projectedRoundCost, type ModelResolver } from "../ideation/budget";

export interface M2Projection { expectedUsd: number; ceilingUsd: number }
export interface RunM2Options {
  projects: number;
  budgetUsd: number;
  evalId?: string;
  yes?: boolean;
  wallSeconds?: number;
  now?: () => Date;
  judgeCalibration?: JudgeCalibrationStamp;
}

export interface RunM2Deps {
  executor?: RunExecutor;
  cloneRunAcrossHomes?: typeof cloneRunAcrossHomes;
  stage?: typeof stageHome;
  projection?: (cfg: KilnConfig) => M2Projection;
  cli?: ExecutorDeps;
  now?: () => Date;
  effort?: (cfg: KilnConfig, arm: "fresh" | "single_session", staged: StagedHome) => Promise<{ values: Partial<Record<Role, ResolvedEffort>>; swept: boolean }>;
}

export interface M2ProjectReport {
  seedId: string;
  shape: "research" | "product" | "creative";
  source?: RunSummary;
  cloned?: true;
  fresh?: RunSummary;
  singleSession?: RunSummary;
  pairCensored: boolean;
  pairCensoredBy: string[];
}

export interface M2Report {
  version: 1;
  kind: "m2";
  evalId: string;
  status: "complete" | "incomplete";
  stoppedReason?: "budget" | "deadline";
  startedAt: string;
  updatedAt: string;
  projectsRequested: number;
  budgetUsd: number;
  costUsd: number;
  projection: { perSeedPair: M2Projection; expectedUsd: number; ceilingUsd: number };
  arms: { A: "fresh"; B: "single_session" };
  effortSwept: boolean;
  effortSweptByArm: Record<"fresh" | "single_session", boolean>;
  judgeCalibration: JudgeCalibrationStamp;
  frozen: ReturnType<typeof frozenConfig>;
  projects: M2ProjectReport[];
}

const SCORED_EFFORT_ROLES: readonly Role[] = ["builder", "auditor"];

function effort(cfg: KilnConfig): Partial<Record<Role, ResolvedEffort>> {
  return Object.fromEntries(Object.keys(cfg.roles).map((role) => [role, {
    level: cfg.effortByRole?.[role as Role] ?? cfg.effort,
    source: "config",
  }])) as Partial<Record<Role, ResolvedEffort>>;
}

function frozenConfig(cfg: KilnConfig, projects: number, efforts: Record<"fresh" | "single_session", Partial<Record<Role, ResolvedEffort>>>) {
  const { phaseBudgetUsd: _usd, phaseBudgetWallSeconds: _wall, ...budgets } = cfg.budgets;
  return { projects, rounds: cfg.evals.rounds ?? cfg.ideation.rounds, roles: cfg.roles, effort: efforts, budgets };
}

export function defaultM2Projection(cfg: KilnConfig, models?: ModelResolver): M2Projection {
  const runBudget = cfg.evals.runBudgetUsd ?? cfg.budgets.usd;
  const formShare = cfg.budgets.share.frame + cfg.budgets.share.discover + cfg.budgets.share.ideate + cfg.budgets.share.form;
  const rounds = cfg.evals.rounds ?? cfg.ideation.rounds; const caps = derivedCaps(cfg);
  const beforeIdeate = runBudget * (cfg.budgets.share.frame + cfg.budgets.share.discover);
  const ideate = models ? rounds * projectedRoundCost(cfg, models).costUsd : runBudget * cfg.budgets.share.ideate;
  const build = caps.maxFeatures * cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd;
  return { expectedUsd: beforeIdeate + ideate + PROJECTED_FORMATION_USD + 2 * build, ceilingUsd: runBudget * (formShare + 2 * cfg.budgets.share.build) };
}

function projectCost(project: M2ProjectReport): number {
  if (project.fresh && project.singleSession) return project.fresh.costUsd + project.singleSession.costUsd - (project.source?.costUsd ?? 0);
  if (project.fresh) return project.fresh.costUsd;
  return project.source?.costUsd ?? 0;
}

function reportCost(report: M2Report): number {
  return report.projects.reduce((sum, project) => sum + projectCost(project), 0);
}

function updatePair(project: M2ProjectReport): void {
  if (!project.fresh || !project.singleSession) return;
  const reasons = pairCensoredBy([project.fresh, project.singleSession]);
  if (reasons.length === 0 && (project.fresh.metrics.censored === true || project.singleSession.metrics.censored === true)) reasons.push("deadline");
  project.pairCensoredBy = reasons;
  project.pairCensored = reasons.length > 0;
}

function persist(path: string, report: M2Report, now: () => Date): void {
  report.costUsd = reportCost(report); report.updatedAt = now().toISOString();
  writeAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
}

function spec(staged: StagedHome, seed: ReturnType<typeof loadSeeds>[number], evalId: string, arm: "fresh" | "single_session", through: "form" | "build", cfg: KilnConfig, resolved: Partial<Record<Role, ResolvedEffort>>): RunExecutorSpec {
  return {
    home: staged.home, seedText: seed.text, seedIdentity: { id: seed.id, split: seed.split, sha256: seed.sha256 },
    arm, through, cloneAfter: through === "form" ? "none" : "freeze",
    ...(through === "build" ? { buildArm: arm } : {}),
    rounds: cfg.evals.rounds ?? cfg.ideation.rounds,
    runId: `${evalId}-${seed.id}-${arm}`,
    effort: resolved,
  };
}

async function resolvedEfforts(home: string, cfg: KilnConfig, stages: Record<"fresh" | "single_session", StagedHome>, deps: RunM2Deps) {
  const values = {} as Record<"fresh" | "single_session", Partial<Record<Role, ResolvedEffort>>>;
  const swept = {} as Record<"fresh" | "single_session", boolean>;
  let calibration: JudgeCalibrationStamp | undefined;
  let models: ModelResolver | undefined;
  for (const arm of ["fresh", "single_session"] as const) {
    if (deps.effort) { const found = await deps.effort(cfg, arm, stages[arm]); values[arm] = found.values; swept[arm] = found.swept; continue; }
    if (deps.executor && !deps.cli) { values[arm] = effort(cfg); swept[arm] = false; continue; }
    const runtime = await runtimeFor(home, stages[arm], deps.cli ?? {}); const file = readEffortFile(home);
    models ??= runtime.models;
    calibration ??= judgeCalibration(home, cfg, runtime.models("judge"));
    const seats: Partial<Record<Role, ReturnType<typeof runtime.models>>> = {};
    values[arm] = Object.fromEntries(Object.keys(cfg.roles).map((key) => {
      const role = key as Role; const seat = runtime.models(role); seats[role] = seat;
      const found = resolveEffort(stages[arm].config, role, seat, file, "default");
      return [role, { level: found.level ?? stages[arm].config.effort, source: found.source === "global" ? "fallback" : found.source }];
    })) as Partial<Record<Role, ResolvedEffort>>;
    swept[arm] = effortsSwept(SCORED_EFFORT_ROLES, seats, file, "default");
  }
  return { values, swept, calibration, models };
}

export async function runM2(home: string, cfg: KilnConfig, options: RunM2Options, deps: RunM2Deps = {}): Promise<M2Report> {
  if (!Number.isSafeInteger(options.projects) || options.projects < 1) throw new Error("M2 requires a positive --projects count");
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new Error("M2 requires a positive --budget");
  const manifest = verifyEvalsManifest(home); if (!manifest.ok) throw new Error(`eval manifest mismatch: ${[...manifest.changed, ...manifest.missing, ...manifest.extra].join(", ")}`);
  const seeds = loadSeeds(home, "dev").slice(0, options.projects);
  if (seeds.length !== options.projects) throw new Error(`M2 requested ${options.projects} projects but only ${seeds.length} dev seeds exist`);
  const floorProjection = (deps.projection ?? defaultM2Projection)(cfg);
  if (options.budgetUsd < floorProjection.ceilingUsd) throw new Error(`M2 budget is below the first seed-pair ceiling ${floorProjection.ceilingUsd.toFixed(2)}`);
  const evalId = options.evalId ?? `m2-p${options.projects}`; const now = options.now ?? deps.now ?? (() => new Date());
  const stage = deps.stage ?? stageHome;
  const stageOptions = { seating: {
    roles: cfg.seating.default,
    ...(cfg.evals.runBudgetUsd === undefined ? {} : { runBudgetUsd: cfg.evals.runBudgetUsd }),
    ...(cfg.evals.runWallSeconds === undefined ? {} : { runWallSeconds: cfg.evals.runWallSeconds }),
  } };
  const stages = { fresh: stage(home, evalId, "fresh", stageOptions), single_session: stage(home, evalId, "single_session", stageOptions) };
  const resolved = await resolvedEfforts(home, cfg, stages, deps); const frozen = frozenConfig(cfg, options.projects, resolved.values);
  const perSeedPair = deps.projection ? floorProjection : defaultM2Projection(cfg, resolved.models);
  const evalDir = join(home, "evolution", "reports", evalId); const path = join(evalDir, "eval.json");
  let report: M2Report;
  if (existsSync(path)) {
    report = JSON.parse(readFileSync(path, "utf8")) as M2Report;
    if (JSON.stringify(report.frozen) !== JSON.stringify(frozen)) throw new Error("M2 live config differs from frozen config");
    report.budgetUsd = Math.max(report.budgetUsd, options.budgetUsd);
  } else {
    ensureDir(evalDir);
    report = {
      version: 1, kind: "m2", evalId, status: "incomplete", startedAt: now().toISOString(), updatedAt: now().toISOString(),
      projectsRequested: options.projects, budgetUsd: options.budgetUsd, costUsd: 0,
      projection: { perSeedPair, expectedUsd: perSeedPair.expectedUsd * options.projects, ceilingUsd: perSeedPair.ceilingUsd * options.projects },
      arms: { A: "fresh", B: "single_session" }, effortSwept: resolved.swept.fresh && resolved.swept.single_session,
      effortSweptByArm: resolved.swept, judgeCalibration: options.judgeCalibration ?? resolved.calibration ?? { status: "absent" }, frozen, projects: [],
    };
    persist(path, report, now);
  }
  if (report.status === "complete") return report;
  const executor = deps.executor ?? createRunExecutor(home, deps.cli); const clone = deps.cloneRunAcrossHomes ?? cloneRunAcrossHomes;
  const deadline = now().getTime() + (options.wallSeconds ?? cfg.evals.wallSeconds) * 1_000;

  for (const seed of seeds) {
    let project = report.projects.find((item) => item.seedId === seed.id);
    if (!project && report.budgetUsd - reportCost(report) < perSeedPair.ceilingUsd) {
      report.status = "incomplete"; report.stoppedReason = "budget"; persist(path, report, now); return report;
    }
    if (now().getTime() >= deadline) { report.status = "incomplete"; report.stoppedReason = "deadline"; persist(path, report, now); return report; }
    if (!project) {
      project = { seedId: seed.id, shape: seed.shape, pairCensored: false, pairCensoredBy: [] };
      const formedSpec = spec(stages.fresh, seed, evalId, "fresh", "form", cfg, resolved.values.fresh);
      project.source = await executor(formedSpec); report.projects.push(project); persist(path, report, now);
    }
    if (project.source?.status.phase !== "build" || project.source.status.state !== "running") {
      const reasons = pairCensoredBy([project.source!]); project.pairCensoredBy = reasons; project.pairCensored = reasons.length > 0;
      persist(path, report, now); continue;
    }
    const freshId = `${evalId}-${seed.id}-fresh`; const singleId = `${evalId}-${seed.id}-single_session`;
    if (!project.cloned) {
      const cloneOptions = { fromHome: stages.fresh.home, fromId: freshId, toHome: stages.single_session.home, toId: singleId, boundary: "freeze" as const };
      if (!findPublishedCloneAcrossHomes(cloneOptions)) clone(cloneOptions);
      project.cloned = true; persist(path, report, now);
    }
    if (!project.fresh) { project.fresh = await executor(spec(stages.fresh, seed, evalId, "fresh", "build", cfg, resolved.values.fresh)); persist(path, report, now); }
    if (!project.singleSession) { project.singleSession = await executor(spec(stages.single_session, seed, evalId, "single_session", "build", cfg, resolved.values.single_session)); updatePair(project); persist(path, report, now); }
  }
  report.status = "complete"; delete report.stoppedReason; persist(path, report, now); return report;
}
