import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KilnConfig, Role } from "../core/config";
import { Limiter } from "../core/limiter";
import { ensureDir, writeAtomic } from "../core/paths";
import { RunRecord } from "../core/record";
import { runPaths } from "../core/run";
import type { CliDeps } from "../cli/main";
import { createCliRuntime } from "../cli/runtime";
import { judgeArms } from "./judging";
import { pairCensoredBy, createRunExecutor, type ExecutorDeps, type ResolvedEffort, type RunExecutor, type RunExecutorSpec, type RunSummary } from "./executor";
import { verifyEvalsManifest } from "./manifest";
import { passReport, type EvalPassReport } from "./report";
import type { JudgeCalibrationStamp } from "./report";
import { judgeCalibration } from "./calibrate";
import { readCost } from "./cost";
import { loadSeeds, type LoadedSeed } from "./seeds";
import type { CollapsedJudgedPair } from "./wilson";
import { stageHome, type StagedHome } from "../evolution/stage";
import { runtimeFor } from "../evolution/stage";
import { effortsSwept, readEffortFile, resolveEffort } from "./effort";
import { projectedRoundCost, type ModelResolver } from "../ideation/budget";

export type M1Arm = "A0" | "B0" | "A1" | "A2";

export interface RunM1Options {
  budgetUsd: number;
  rounds?: number;
  evalId?: string;
  fableLow?: boolean;
  frontier?: boolean;
  wallSeconds?: number;
  yes?: boolean;
  now?: () => Date;
  judgeCalibration?: JudgeCalibrationStamp;
}

export interface M1JudgeRequest {
  evalDir: string;
  seed: Pick<LoadedSeed, "id" | "text" | "shape">;
  a: { name: M1Arm; summary: RunSummary; home: string };
  b: { name: M1Arm; summary: RunSummary; home: string };
  pairsPerSeed: number;
}

export interface M1JudgeResult { pairs: CollapsedJudgedPair[]; costUsd: number }
export type M1Judge = (request: M1JudgeRequest) => Promise<M1JudgeResult>;
export interface M1ProjectionCell { expectedUsd: number; ceilingUsd: number }

export interface RunM1Deps {
  executor?: RunExecutor;
  judge?: M1Judge;
  stage?: typeof stageHome;
  projection?: (cfg: KilnConfig, arm: M1Arm, rounds: number) => M1ProjectionCell;
  cli?: ExecutorDeps;
  now?: () => Date;
  effort?: (cfg: KilnConfig, arm: M1Arm, staged: StagedHome) => Promise<{ values: Partial<Record<Role, ResolvedEffort>>; swept: boolean }>;
}

export interface M1Row {
  seed: string;
  shape: LoadedSeed["shape"];
  pairCensored: boolean;
  pairCensoredBy: string[];
  note?: string;
  pairs: CollapsedJudgedPair[];
  judgeCostUsd: number;
  aMetrics: M1ArmMetrics;
  bMetrics: M1ArmMetrics;
}

export interface M1ArmMetrics {
  frontier: { raw: number; shown: number; backfilled: number };
  collisionRate: number | null;
  probePassRate: number | null;
  honestExit?: string;
  usdPerSuccess: number | null;
  costUsd: number;
  tokensPerSuccess: number | null;
  turnsPerSuccess: number | null;
  cacheReadRatio: number | null;
}

export interface M1ComparisonSummary extends EvalPassReport {
  n: number;
  pairCensored: number;
  honestExits: Partial<Record<M1Arm, number>>;
  failed: Record<string, number>;
  seedRate: number;
  perShape: Record<"research" | "product" | "creative", number | null>;
  prediction: "met" | "not met" | "not evidence";
  kill: "met" | "not met" | "not evidence";
}

export interface M1Comparison {
  id: string;
  a: M1Arm;
  b: M1Arm;
  rows: M1Row[];
  summary: M1ComparisonSummary;
}

export interface M1Report {
  version: 1;
  kind: "m1";
  evalId: string;
  status: "complete" | "incomplete";
  stoppedReason?: "budget" | "deadline";
  startedAt: string;
  updatedAt: string;
  budgetUsd: number;
  costUsd: number;
  effortSwept: boolean;
  effortSweptByArm: Partial<Record<M1Arm, boolean>>;
  judgeCalibration: JudgeCalibrationStamp;
  arms: M1Arm[];
  frozen: ReturnType<typeof frozenConfig>;
  projection: {
    perArm: Partial<Record<M1Arm, M1ProjectionCell>>;
    perSeedCell: M1ProjectionCell;
    total: M1ProjectionCell;
  };
  runs: RunSummary[];
  comparisons: M1Comparison[];
}

const STRONG: readonly Role[] = ["brain", "builder", "reflector", "generator"];
const SCORED_EFFORT_ROLES: readonly Role[] = ["brain", "generator", "judge"];
const COMPARISONS: ReadonlyArray<readonly [M1Arm, M1Arm]> = [["A0", "B0"], ["A1", "A0"], ["A2", "A0"]];

function enabled(options: RunM1Options): M1Arm[] {
  return ["A0", "B0", ...(options.fableLow === false ? [] : ["A1" as const]), ...(options.frontier === false ? [] : ["A2" as const])];
}

function effort(cfg: KilnConfig, arm: M1Arm): Partial<Record<Role, ResolvedEffort>> {
  return Object.fromEntries(Object.keys(cfg.roles).map((role) => {
    const name = role as Role;
    return [name, arm === "A1" && STRONG.includes(name)
      ? { level: "low", source: "profile" }
      : { level: cfg.effortByRole?.[name] ?? cfg.effort, source: "config" }];
  })) as Partial<Record<Role, ResolvedEffort>>;
}

function frozenConfig(cfg: KilnConfig, arms: readonly M1Arm[], rounds: number, values: Record<M1Arm, Partial<Record<Role, ResolvedEffort>>>) {
  const { phaseBudgetUsd: _usd, phaseBudgetWallSeconds: _wall, ...budgets } = cfg.budgets;
  const seating = Object.fromEntries(arms.map((arm) => [arm, arm === "A1" ? "fable-low" : arm === "A2" ? "frontier" : "default"])) as Record<M1Arm, string>;
  return {
    k: cfg.evals.pairsPerSeed, sweepPairsPerSeed: cfg.evals.sweepPairsPerSeed, level: cfg.evals.level,
    rounds, minPairs: cfg.evals.minPairs, minUncensoredSeeds: cfg.evals.minUncensoredSeeds,
    noninferiorityMargin: cfg.evals.noninferiorityMargin, seating,
    effort: Object.fromEntries(arms.map((arm) => [arm, values[arm]])), roles: cfg.roles, budgets,
  };
}

function defaultArmProjection(cfg: KilnConfig, arm: M1Arm, rounds: number, models?: ModelResolver): M1ProjectionCell {
  const budget = cfg.evals.runBudgetUsd ?? cfg.budgets.usd;
  const ceilingUsd = budget * (cfg.budgets.share.frame + cfg.budgets.share.discover + cfg.budgets.share.ideate);
  if (!models) return { expectedUsd: ceilingUsd, ceilingUsd };
  const beforeIdeate = budget * (cfg.budgets.share.frame + cfg.budgets.share.discover);
  if (arm !== "B0") return { expectedUsd: beforeIdeate + rounds * projectedRoundCost(cfg, models).costUsd, ceilingUsd };
  const bare = projectedRoundCost({ ...cfg, ideation: { ...cfg.ideation, islands: 1, ideasPerBatch: 5, cheapIsland: false } }, models);
  const included = new Set(["island first batches", "prior-art scouts", "collision verdicts", "probe decision", "probe writers"]);
  const bareIdeate = bare.rows.filter((row) => included.has(row.name)).reduce((sum, row) => sum + row.costUsd, 0);
  const expectedUsd = beforeIdeate + bareIdeate;
  return { expectedUsd, ceilingUsd };
}

function projectedJudgeTable(cfg: KilnConfig, models: ModelResolver): number {
  const round = projectedRoundCost(cfg, models); const criteria = round.rows.find((row) => row.name === "criteria")?.costUsd ?? 0;
  const orderings = round.rows.find((row) => row.name === "tournament orderings");
  const perOrdering = orderings && orderings.calls > 0 ? orderings.costUsd / orderings.calls : 0;
  return criteria + cfg.evals.pairsPerSeed * 2 * perOrdering;
}

function projections(cfg: KilnConfig, arms: readonly M1Arm[], rounds: number, project: NonNullable<RunM1Deps["projection"]>, seeds: number, liveJudgeExpected?: number) {
  const perArm = Object.fromEntries(arms.map((arm) => [arm, project(cfg, arm, rounds)])) as Partial<Record<M1Arm, M1ProjectionCell>>;
  const tables = COMPARISONS.filter(([a, b]) => arms.includes(a) && arms.includes(b)).length;
  const judgeCeiling = 0.25; const judgeExpected = liveJudgeExpected ?? judgeCeiling;
  const perSeedCell = {
    expectedUsd: arms.reduce((sum, arm) => sum + perArm[arm]!.expectedUsd, 0) + tables * judgeExpected,
    ceilingUsd: arms.reduce((sum, arm) => sum + perArm[arm]!.ceilingUsd, 0) + tables * 0.25,
  };
  return { perArm, perSeedCell, total: { expectedUsd: perSeedCell.expectedUsd * seeds, ceilingUsd: perSeedCell.ceilingUsd * seeds }, judgeExpected, judgeCeiling: 0.25 };
}

/** Default cost-model projection used by the CLI before any eval work starts. */
export function projectM1(
  cfg: KilnConfig,
  options: Pick<RunM1Options, "rounds" | "fableLow" | "frontier"> = {},
  seeds = 12,
  models: Partial<Record<M1Arm, ModelResolver>> = {},
) {
  const rounds = options.rounds ?? cfg.evals.rounds ?? cfg.ideation.rounds;
  const arms = enabled({ budgetUsd: 1, ...options });
  const value = projections(cfg, arms, rounds, (liveCfg, arm, liveRounds) => defaultArmProjection(liveCfg, arm, liveRounds, models[arm]), seeds,
    models.A0 ? projectedJudgeTable(cfg, models.A0) : undefined);
  return { perArm: value.perArm, perSeedCell: value.perSeedCell, total: value.total };
}

function stageArms(home: string, evalId: string, cfg: KilnConfig, arms: readonly M1Arm[], stage: typeof stageHome): Record<M1Arm, StagedHome> {
  const out = {} as Record<M1Arm, StagedHome>;
  for (const arm of arms) {
    const roles = arm === "A1" ? Object.fromEntries(STRONG.map((role) => [role, ["anthropic/claude-fable-5-1"]]))
      : arm === "A2" ? cfg.seating.frontier.roles : cfg.seating.default;
    out[arm] = stage(home, evalId, arm, { seating: { roles, ...(arm === "A2" ? { caps: cfg.seating.frontier.caps } : {}) } });
  }
  return out;
}

async function resolvedEfforts(home: string, cfg: KilnConfig, arms: readonly M1Arm[], stages: Record<M1Arm, StagedHome>, rounds: number, deps: RunM1Deps) {
  const values = {} as Record<M1Arm, Partial<Record<Role, ResolvedEffort>>>; const swept: Partial<Record<M1Arm, boolean>> = {};
  const projected: Partial<Record<M1Arm, M1ProjectionCell>> = {}; let judgeExpected: number | undefined;
  for (const arm of arms) {
    if (deps.effort) { const found = await deps.effort(cfg, arm, stages[arm]); values[arm] = found.values; swept[arm] = found.swept; continue; }
    if (deps.executor && !deps.cli) { values[arm] = effort(cfg, arm); swept[arm] = false; continue; }
    const runtime = await runtimeFor(home, stages[arm], deps.cli ?? {}); const file = readEffortFile(home);
    const profile = arm === "A1" ? "fable-low" : arm === "A2" ? "frontier" : "default";
    const seats: Partial<Record<Role, ReturnType<typeof runtime.models>>> = {};
    values[arm] = Object.fromEntries(Object.keys(cfg.roles).map((key) => {
      const role = key as Role; const seat = runtime.models(role); seats[role] = seat;
      const override = arm === "A1" && STRONG.includes(role) ? { name: profile, effort: { [role]: "low" as const } } : profile;
      const found = resolveEffort(stages[arm].config, role, seat, file, override);
      return [role, { level: found.level ?? stages[arm].config.effort, source: found.source === "global" ? "fallback" : found.source }];
    })) as Partial<Record<Role, ResolvedEffort>>;
    swept[arm] = effortsSwept(SCORED_EFFORT_ROLES, seats, file, profile);
    projected[arm] = defaultArmProjection(stages[arm].config, arm, rounds, runtime.models);
    if (arm === "A0") judgeExpected = projectedJudgeTable(stages[arm].config, runtime.models);
  }
  return { values, swept, projected, judgeExpected };
}

function emptySummary(): M1ComparisonSummary {
  return { seeds: 0, uncensoredSeeds: 0, pairs: 0, n: 0, wins: 0, ties: 0, rate: 0, wilson: { lower: 0, upper: 1 }, requiredWins: 0, evidence: false, seedWins: 0, pairCensored: 0, honestExits: {}, failed: {}, seedRate: 0, perShape: { research: null, product: null, creative: null }, prediction: "not evidence", kill: "not evidence" };
}

function updateSummary(comparison: M1Comparison, cfg: KilnConfig, runs: readonly RunSummary[]): void {
  const pairs = comparison.rows.flatMap((row) => row.pairs);
  const uncensored = comparison.rows.filter((row) => !row.pairCensored && !row.note?.startsWith("failed:")).length;
  let seedWins = 0; const honestExits: Partial<Record<M1Arm, number>> = {}; const failed: Record<string, number> = {};
  for (const row of comparison.rows) {
    const a = runs.find((run) => run.seedId === row.seed && run.arm === comparison.a);
    const b = runs.find((run) => run.seedId === row.seed && run.arm === comparison.b);
    for (const run of [a, b]) {
      if (run?.outcome?.kind === "honest_exit") honestExits[run.arm as M1Arm] = (honestExits[run.arm as M1Arm] ?? 0) + 1;
      if (run?.status.state === "failed") { const key = run.outcome?.failureClass ?? "verify"; failed[key] = (failed[key] ?? 0) + 1; }
    }
    if (row.pairs.length > 0) {
      const score = row.pairs.reduce((sum, pair) => sum + pair.score, 0) / row.pairs.length;
      seedWins += score > 0.5 ? 1 : score === 0.5 ? 0.5 : 0;
    } else if (!row.pairCensored && a?.outcome?.kind === "honest_exit" && b?.outcome?.kind !== "honest_exit") seedWins += 0;
    else if (!row.pairCensored && b?.outcome?.kind === "honest_exit" && a?.outcome?.kind !== "honest_exit") seedWins += 1;
  }
  const pass = passReport(pairs, { seeds: comparison.rows.length, uncensoredSeeds: uncensored, seedWins, level: cfg.evals.level, minPairs: cfg.evals.minPairs, minUncensoredSeeds: cfg.evals.minUncensoredSeeds });
  const perShape = Object.fromEntries((["research", "product", "creative"] as const).map((shape) => {
    const rows = comparison.rows.filter((row) => row.shape === shape && !row.pairCensored && !row.note?.startsWith("failed:"));
    const scores = rows.flatMap((row) => row.pairs.map((pair) => pair.score));
    return [shape, scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length];
  })) as M1ComparisonSummary["perShape"];
  const evidence = pass.evidence;
  const aCollision = comparison.rows.flatMap((row) => row.aMetrics.collisionRate === null ? [] : [row.aMetrics.collisionRate]);
  const bCollision = comparison.rows.flatMap((row) => row.bMetrics.collisionRate === null ? [] : [row.bMetrics.collisionRate]);
  const collisionBetter = aCollision.length > 0 && bCollision.length > 0 && aCollision.reduce((a, b) => a + b, 0) / aCollision.length < bCollision.reduce((a, b) => a + b, 0) / bCollision.length;
  comparison.summary = { ...pass, n: pass.pairs, pairCensored: comparison.rows.filter((row) => row.pairCensored).length, honestExits, failed,
    seedRate: uncensored === 0 ? 0 : seedWins / uncensored, perShape,
    prediction: comparison.a !== "A0" || comparison.b !== "B0" || !evidence ? "not evidence" : pass.rate >= 0.65 && collisionBetter ? "met" : "not met",
    kill: comparison.a !== "A0" || comparison.b !== "B0" || !evidence ? "not evidence" : pass.rate <= 0.5 ? "met" : "not met" };
}

function armMetrics(run: RunSummary): M1ArmMetrics {
  const metrics = run.metrics as Record<string, any>; const cost = readCost(metrics).ideate;
  const frontier = run.frontier && typeof run.frontier === "object" ? run.frontier as { ideas?: Array<{ backfill?: boolean }> } : {};
  return {
    frontier: { raw: Number(metrics.frontier?.raw ?? 0), shown: Number(metrics.frontier?.shown ?? 0), backfilled: frontier.ideas?.filter((idea) => idea.backfill === true).length ?? 0 },
    collisionRate: typeof metrics.collisionRate === "number" ? metrics.collisionRate : null,
    probePassRate: typeof metrics.probes?.passRate === "number" ? metrics.probes.passRate : null,
    ...(run.outcome?.kind === "honest_exit" ? { honestExit: run.outcome.exitKind ?? "unknown" } : {}),
    usdPerSuccess: cost?.usdPerSuccess ?? null, costUsd: cost?.usd ?? run.costUsd,
    tokensPerSuccess: cost?.tokensPerSuccess ?? null, turnsPerSuccess: cost?.turnsPerSuccess ?? null,
    cacheReadRatio: cost?.cacheReadRatio ?? null,
  };
}

function reportCost(report: M1Report): number {
  return report.runs.reduce((sum, run) => sum + run.costUsd, 0) + report.comparisons.flatMap((comparison) => comparison.rows).reduce((sum, row) => sum + row.judgeCostUsd, 0);
}

function writeReport(path: string, report: M1Report, now: () => Date): void {
  report.costUsd = reportCost(report); report.updatedAt = now().toISOString();
  writeAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
}

function note(a: RunSummary, b: RunSummary, censored: readonly string[]): string | undefined {
  if (censored.length > 0) return `pairCensored:${censored.join(",")}`;
  const failed = [a, b].find((run) => run.status.state === "failed");
  if (failed) return `failed:${failed.outcome?.failureClass ?? "verify"}`;
  const honest = [a, b].find((run) => run.outcome?.kind === "honest_exit");
  return honest ? `honest_exit:${honest.arm}:${honest.outcome?.exitKind ?? "unknown"}` : undefined;
}

async function defaultJudge(home: string, cfg: KilnConfig, evalId: string, stages: Record<M1Arm, StagedHome>, cli: ExecutorDeps = {}): Promise<{ judge: M1Judge; calibration: JudgeCalibrationStamp }> {
  const runtime = await createCliRuntime(home, cfg, cli as CliDeps); const evalDir = join(home, "evolution", "reports", evalId);
  const run = { ...runPaths(home, `${evalId}-judge`), record: join(evalDir, "record.jsonl") };
  const record = new RunRecord(run.record);
  const deps = { home, run, record, cfg, models: runtime.models, modelsOn: runtime.modelsOn, availableProviders: runtime.available, apiKeyFor: runtime.apiKeyFor, streamFn: cli.streamFn, effort: cfg.effort, limiter: new Limiter(cfg.ideation.concurrency) };
  const judge: M1Judge = async (request) => {
    const result = await judgeArms(evalDir, request.seed, { name: request.a.name, run: runPaths(stages[request.a.name].home, request.a.summary.runId) }, { name: request.b.name, run: runPaths(stages[request.b.name].home, request.b.summary.runId) }, deps, { pairsPerSeed: request.pairsPerSeed });
    return { pairs: result.collapsed.value.map((pair) => ({ seedId: request.seed.id, score: pair.score })), costUsd: result.lines.reduce((sum, line) => sum + line.costUsd, 0) };
  };
  return { judge, calibration: judgeCalibration(home, cfg, runtime.models("judge")) };
}

export async function runM1(home: string, cfg: KilnConfig, options: RunM1Options, deps: RunM1Deps = {}): Promise<M1Report> {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new Error("M1 requires a positive --budget");
  const manifest = verifyEvalsManifest(home); if (!manifest.ok) throw new Error(`eval manifest mismatch: ${[...manifest.changed, ...manifest.missing, ...manifest.extra].join(", ")}`);
  const rounds = options.rounds ?? cfg.evals.rounds ?? cfg.ideation.rounds;
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive safe integer");
  const evalId = options.evalId ?? `m1-r${rounds}`; const arms = enabled(options); const now = options.now ?? deps.now ?? (() => new Date());
  const seeds = loadSeeds(home, "heldout");
  const stages = stageArms(home, evalId, cfg, arms, deps.stage ?? stageHome);
  const resolved = await resolvedEfforts(home, cfg, arms, stages, rounds, deps); const frozen = frozenConfig(cfg, arms, rounds, resolved.values);
  const project = deps.projection ?? ((liveCfg: KilnConfig, arm: M1Arm, liveRounds: number) => resolved.projected[arm] ?? defaultArmProjection(liveCfg, arm, liveRounds));
  const projection = projections(cfg, arms, rounds, project, seeds.length, deps.projection ? undefined : resolved.judgeExpected);
  const evalDir = join(home, "evolution", "reports", evalId); ensureDir(evalDir); const path = join(evalDir, "eval.json");
  let report: M1Report;
  if (existsSync(path)) {
    report = JSON.parse(readFileSync(path, "utf8")) as M1Report;
    if (JSON.stringify(report.frozen) !== JSON.stringify(frozen)) throw new Error("M1 live config differs from frozen config");
    report.budgetUsd = Math.max(report.budgetUsd, options.budgetUsd);
  } else {
    report = { version: 1, kind: "m1", evalId, status: "incomplete", startedAt: now().toISOString(), updatedAt: now().toISOString(), budgetUsd: options.budgetUsd, costUsd: 0, effortSwept: arms.every((arm) => resolved.swept[arm] === true), effortSweptByArm: resolved.swept, judgeCalibration: options.judgeCalibration ?? { status: "absent" }, arms, frozen, projection: { perArm: projection.perArm, perSeedCell: projection.perSeedCell, total: projection.total }, runs: [], comparisons: COMPARISONS.filter(([a, b]) => arms.includes(a) && arms.includes(b)).map(([a, b]) => ({ id: `${a}-vs-${b}`, a, b, rows: [], summary: emptySummary() })) };
    writeReport(path, report, now);
  }
  if (report.status === "complete") return report;
  const executor = deps.executor ?? createRunExecutor(home, deps.cli);
  let judge = deps.judge;
  if (!judge) { const value = await defaultJudge(home, cfg, evalId, stages, deps.cli); judge = value.judge; report.judgeCalibration = value.calibration; writeReport(path, report, now); }
  const deadline = now().getTime() + (options.wallSeconds ?? cfg.evals.wallSeconds) * 1_000;

  for (const seed of seeds) {
    const missingArms = arms.filter((arm) => !report.runs.some((run) => run.seedId === seed.id && run.arm === arm));
    const missingTables = report.comparisons.filter((comparison) => !comparison.rows.some((row) => row.seed === seed.id)).length;
    const ceiling = missingArms.reduce((sum, arm) => sum + report.projection.perArm[arm]!.ceilingUsd, 0) + missingTables * projection.judgeCeiling;
    if (report.budgetUsd - reportCost(report) < ceiling) {
      if (report.runs.length === 0) throw new Error(`M1 budget is below the first seed-cell ceiling ${ceiling.toFixed(2)}`);
      report.status = "incomplete"; report.stoppedReason = "budget"; writeReport(path, report, now); return report;
    }
    if (now().getTime() >= deadline) { report.status = "incomplete"; report.stoppedReason = "deadline"; writeReport(path, report, now); return report; }
    for (const arm of arms) {
      if (report.runs.some((run) => run.seedId === seed.id && run.arm === arm)) continue;
      const spec: RunExecutorSpec = { home: stages[arm].home, seedText: seed.text, seedIdentity: { id: seed.id, split: seed.split, sha256: seed.sha256 }, arm, ...(arm === "B0" ? { mode: "bare" as const } : {}), through: "ideate", cloneAfter: "none", rounds, runId: `${evalId}-${seed.id}-${arm}`, effort: report.frozen.effort[arm] };
      report.runs.push(await executor(spec)); writeReport(path, report, now);
    }
    for (const comparison of report.comparisons) {
      if (comparison.rows.some((row) => row.seed === seed.id)) continue;
      const a = report.runs.find((run) => run.seedId === seed.id && run.arm === comparison.a)!;
      const b = report.runs.find((run) => run.seedId === seed.id && run.arm === comparison.b)!;
      const censored = pairCensoredBy([a, b]); const why = note(a, b, censored);
      let judged: M1JudgeResult = { pairs: [], costUsd: 0 };
      if (censored.length === 0 && !why) judged = await judge({ evalDir, seed, a: { name: comparison.a, summary: a, home: stages[comparison.a].home }, b: { name: comparison.b, summary: b, home: stages[comparison.b].home }, pairsPerSeed: cfg.evals.pairsPerSeed });
      comparison.rows.push({ seed: seed.id, shape: seed.shape, pairCensored: censored.length > 0, pairCensoredBy: censored, ...(why ? { note: why } : {}), pairs: judged.pairs, judgeCostUsd: judged.costUsd, aMetrics: armMetrics(a), bMetrics: armMetrics(b) });
      updateSummary(comparison, cfg, report.runs); writeReport(path, report, now);
    }
  }
  report.status = "complete"; delete report.stoppedReason; writeReport(path, report, now); return report;
}
