import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { CliDeps } from "../cli/main";
import { createCliRuntime, type CliRuntime } from "../cli/runtime";
import type { Effort, KilnConfig, Role } from "../core/config";
import { appendLine, ensureDir } from "../core/paths";
import { RunRecord } from "../core/record";
import { runPaths, type RunPaths } from "../core/run";
import { RealGitRunner, type GitRunner } from "../build/git";
import { foldState } from "../build/state";
import { stageHome, type StagedHome } from "../evolution/stage";
import { cloneRunAcrossHomes } from "./clone";
import { discoverCalibrationGroups, type CalibrationFile, type CalibrationGroup } from "./calibrate";
import { pairCensoredBy, createRunExecutor, type ResolvedEffort, type RunExecutor, type RunExecutorSpec, type RunSummary } from "./executor";
import { effortEntryStatus, effortSweepReportPath, readEffortFile, resolveEffort, type EffortCellMeasurement, type EffortCellRequest, type EffortSweepHandler, type EffortSweepProjector, type RunEffortSweepDeps } from "./effort";
import { judgeArms } from "./judging";
import { loadSeeds, type LoadedSeed } from "./seeds";
import { judgePair, type JudgeDeps } from "../ideation/judge";
import { collapsePairs, type Winner } from "../ideation/bt";

interface CalibrationLine {
  calibrationGroupId: string; a: string; b: string; order: "ab" | "ba"; round: number;
  valueWinner: Winner; labelWinner: string; labelBest: string; labelWorst: string; judgeModel: string;
}
interface ReplayLine { groupId: string; a: string; b: string; order: "ab" | "ba"; valueWinner: Winner; costUsd: number }

export interface ProductionEffortVehicleContext {
  home: string; cfg: KilnConfig; cli: CliDeps; runtime: CliRuntime; executor: RunExecutor;
  clone: typeof cloneRunAcrossHomes;
}
export type ProductionEffortVehicle = (request: EffortCellRequest, context: ProductionEffortVehicleContext) => Promise<EffortCellMeasurement>;
export interface ProductionEffortVehicleOverrides {
  judge?: ProductionEffortVehicle;
  ideate?: ProductionEffortVehicle;
  build?: ProductionEffortVehicle;
  executor?: RunExecutor;
  runtime?: CliRuntime;
  git?: GitRunner;
  clone?: typeof cloneRunAcrossHomes;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function lines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as T] : []; } catch { return []; } });
}
function completeGroups(held: CalibrationLine[]): Set<string> {
  const byGroup = new Map<string, Set<string>>();
  for (const line of held) { const set = byGroup.get(line.calibrationGroupId) ?? new Set<string>(); set.add(`${line.a}\0${line.b}\0${line.order}`); byGroup.set(line.calibrationGroupId, set); }
  return new Set([...byGroup].filter(([, set]) => set.size === 10).map(([id]) => id));
}

function calibrationReplay(home: string): { groups: Map<string, CalibrationGroup>; lines: CalibrationLine[] } {
  const calibration = readJson<CalibrationFile>(join(home, "evals", "calibration.json"));
  const groups = new Map(discoverCalibrationGroups(home).map((group) => [group.id, group]));
  const dir = join(home, "evals", "calibration");
  const candidates = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => {
    const held = lines<CalibrationLine>(join(dir, name)); const complete = completeGroups(held);
    const usable = held.filter((line) => complete.has(line.calibrationGroupId) && groups.has(line.calibrationGroupId));
    return { held: usable, count: new Set(usable.map((line) => line.calibrationGroupId)).size };
  }).filter((candidate) => candidate.count === calibration.groups && candidate.held.some((line) => line.judgeModel === calibration.hash.judgeModel));
  const selected = candidates.at(-1);
  if (!selected) throw new Error("no complete durable calibration replay matches calibration.json");
  return { groups, lines: selected.held };
}

function ideaId(value: string): string { return value.slice(value.lastIndexOf("/") + 1); }
function replayPairs(held: ReplayLine[], base: CalibrationLine[]): { wins: number; n: number } {
  const label = new Map(base.map((line) => [`${line.a}\0${line.b}`, line.labelWinner]));
  const collapsed = collapsePairs(held.map((line) => ({ ...line, round: 1, feasibilityWinner: "tie" as const, source: "judge" as const })));
  const scores = collapsed.value.map((pair) => label.get(`${pair.a}\0${pair.b}`) === pair.a ? pair.score : 1 - pair.score);
  return { wins: scores.reduce((sum, score) => sum + score, 0), n: scores.length };
}

async function judgeVehicle(request: EffortCellRequest, context: ProductionEffortVehicleContext): Promise<EffortCellMeasurement> {
  const replay = calibrationReplay(context.home); const evalDir = join(context.home, "evolution", "reports", request.evalId, "vehicles", request.id); ensureDir(join(evalDir, "criteria"));
  const path = join(evalDir, "judged.jsonl"); const record = new RunRecord(join(evalDir, "record.jsonl"));
  const cfg = { ...context.cfg, effortByRole: { ...context.cfg.effortByRole, judge: request.level as Effort } };
  const virtual = { ...runPaths(context.home, `${request.evalId}-${request.id}`), record: record.path, criteriaDir: join(evalDir, "criteria"), tournament: path };
  const deps: JudgeDeps = { home: context.home, run: virtual, record, cfg, models: context.runtime.models, apiKeyFor: context.runtime.apiKeyFor, streamFn: context.cli.streamFn, effort: request.level };
  const existing = lines<ReplayLine>(path); const done = new Set(existing.map((line) => `${line.groupId}\0${line.a}\0${line.b}\0${line.order}`));
  const basePairs = replay.lines.filter((line) => line.order === "ab");
  for (const base of basePairs) {
    const group = replay.groups.get(base.calibrationGroupId)!; const aId = ideaId(base.a); const bId = ideaId(base.b);
    const a = group.items.find((item) => item.id === aId)!; const b = group.items.find((item) => item.id === bId)!;
    for (const order of ["ab", "ba"] as const) {
      const key = `${base.calibrationGroupId}\0${base.a}\0${base.b}\0${order}`; if (done.has(key)) continue;
      const verdict = await judgePair(deps, group.criteria, a.render, b.render, order);
      appendLine(path, JSON.stringify({ groupId: base.calibrationGroupId, a: base.a, b: base.b, order, valueWinner: verdict.valueWinner, costUsd: verdict.costUsd } satisfies ReplayLine));
    }
  }
  const replayed = lines<ReplayLine>(path); const score = replayPairs(replayed, replay.lines); const costUsd = record.costUsd();
  return { ...score, quality: score.n === 0 ? 0 : score.wins / score.n, usdPerSuccess: score.wins === 0 ? null : costUsd / score.wins, costUsd };
}

function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function resolved(context: ProductionEffortVehicleContext, overrides: Partial<Record<Role, string>> = {}): Partial<Record<Role, ResolvedEffort>> {
  const file = readEffortFile(context.home);
  return Object.fromEntries(Object.keys(context.cfg.roles).map((key) => {
    const role = key as Role; const found = resolveEffort(context.cfg, role, context.runtime.models(role), file, overrides[role]
      ? { name: "default", effort: { [role]: overrides[role] as Effort } } : "default");
    return [role, { level: (found.level ?? context.cfg.effort) as Effort, source: found.source === "global" ? "fallback" : found.source }];
  })) as Partial<Record<Role, ResolvedEffort>>;
}
function spec(stage: StagedHome, seed: LoadedSeed, request: EffortCellRequest, arm: string, effort: Partial<Record<Role, ResolvedEffort>>, through: "ideate" | "form" | "build"): RunExecutorSpec {
  return { home: stage.home, seedText: seed.text, seedIdentity: { id: seed.id, split: seed.split, sha256: seed.sha256 }, arm, through,
    cloneAfter: through === "build" ? "freeze" : "none", ...(through === "build" ? { buildArm: "fresh" as const } : {}), rounds: request.rounds,
    runId: `${request.evalId}-${seed.id}-${safe(arm)}`, effort };
}
function successful(run: RunSummary): boolean { return pairCensoredBy([run]).length === 0 && run.status.state !== "failed" && run.outcome?.kind !== "honest_exit"; }
function paidBefore(request: EffortCellRequest, home: string): boolean {
  const path = effortSweepReportPath(home, request.evalId);
  if (!existsSync(path)) return false;
  try { return (readJson<{ cells?: unknown[] }>(path).cells?.length ?? 0) > 0; } catch { return false; }
}

async function ideateVehicle(request: EffortCellRequest, context: ProductionEffortVehicleContext): Promise<EffortCellMeasurement> {
  const baseline = stageHome(context.home, request.evalId, "effort-incumbent"); const cell = stageHome(context.home, request.evalId, `effort-${safe(request.id)}`);
  const baseEffort = resolved(context); const joint = ["generator", "brain"].includes(request.target) || request.target === "generator+brain" ? ["generator", "brain"] as Role[] : request.roles;
  const cellEffort = request.kind === "aa" ? baseEffort : resolved(context, Object.fromEntries(joint.map((role) => [role, request.level])));
  const evalDir = join(context.home, "evolution", "reports", request.evalId, "vehicles", request.id); ensureDir(evalDir);
  const record = new RunRecord(join(evalDir, "record.jsonl")); const judgeDeps: JudgeDeps = { home: context.home,
    run: { ...runPaths(context.home, `${request.evalId}-${request.id}-judge`), record: record.path }, record, cfg: context.cfg,
    models: context.runtime.models, apiKeyFor: context.runtime.apiKeyFor, streamFn: context.cli.streamFn, effort: context.cfg.effort };
  const pairs: number[] = []; let costUsd = 0; const chargeBaseline = !paidBefore(request, context.home);
  for (const seed of loadSeeds(context.home, "dev")) {
    const base = await context.executor(spec(baseline, seed, request, "effort-baseline", baseEffort, "ideate"));
    const candidate = await context.executor(spec(cell, seed, request, `effort-${request.id}`, cellEffort, "ideate"));
    if (chargeBaseline) costUsd += base.costUsd; costUsd += candidate.costUsd;
    if (!successful(base) || !successful(candidate)) continue;
    const judged = await judgeArms(evalDir, seed, { name: "incumbent", run: runPaths(baseline.home, base.runId) }, { name: request.id, run: runPaths(cell.home, candidate.runId) }, judgeDeps, { pairsPerSeed: context.cfg.evals.sweepPairsPerSeed });
    pairs.push(...judged.collapsed.value.map((pair) => 1 - pair.score));
  }
  costUsd += record.costUsd(); const wins = pairs.reduce((sum, score) => sum + score, 0);
  return { wins, n: pairs.length, quality: pairs.length ? wins / pairs.length : 0, usdPerSuccess: wins ? costUsd / wins : null, costUsd };
}

function featurePairs(incumbent: RunPaths, cell: RunPaths): number[] {
  const a = foldState(incumbent); const b = foldState(cell);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map((id) => {
    const ap = a[id]?.passes && a[id]?.passSource === "executed"; const bp = b[id]?.passes && b[id]?.passSource === "executed";
    return ap === bp ? 0.5 : bp ? 1 : 0;
  });
}
async function buildVehicle(request: EffortCellRequest, context: ProductionEffortVehicleContext): Promise<EffortCellMeasurement> {
  if (request.target === "auditor") {
    const builder = context.runtime.models("builder");
    if (effortEntryStatus(readEffortFile(context.home), "builder", builder.ref, "default") !== "current") {
      throw new Error("auditor effort sweep requires a current builder sweep winner first");
    }
  }
  const formed = stageHome(context.home, request.evalId, "effort-formed"); const incumbent = stageHome(context.home, request.evalId, "effort-build-incumbent");
  const cell = stageHome(context.home, request.evalId, `effort-${safe(request.id)}`); const baseEffort = resolved(context);
  const cellEffort = resolved(context, Object.fromEntries(request.roles.map((role) => [role, request.level]))); const scores: number[] = []; let costUsd = 0;
  const chargeShared = !paidBefore(request, context.home);
  for (const seed of loadSeeds(context.home, "dev").slice(0, 5)) {
    const source = await context.executor(spec(formed, seed, request, "effort-formed", baseEffort, "form"));
    if (source.status.phase !== "build" || source.status.state !== "running") { if (chargeShared) costUsd += source.costUsd; continue; }
    const incumbentId = `${request.evalId}-${seed.id}-effort-build-incumbent`; const cellArm = `effort-${request.id}`; const cellId = `${request.evalId}-${seed.id}-${safe(cellArm)}`;
    if (!existsSync(runPaths(incumbent.home, incumbentId).status)) context.clone({ fromHome: formed.home, fromId: source.runId, toHome: incumbent.home, toId: incumbentId, boundary: "freeze" });
    if (!existsSync(runPaths(cell.home, cellId).status)) context.clone({ fromHome: formed.home, fromId: source.runId, toHome: cell.home, toId: cellId, boundary: "freeze" });
    const a = await context.executor({ ...spec(incumbent, seed, request, "effort-build-incumbent", baseEffort, "build"), runId: incumbentId });
    const b = await context.executor({ ...spec(cell, seed, request, cellArm, cellEffort, "build"), runId: cellId });
    costUsd += b.costUsd - source.costUsd; if (chargeShared) costUsd += a.costUsd;
    if (successful(a) && successful(b)) scores.push(...featurePairs(runPaths(incumbent.home, a.runId), runPaths(cell.home, b.runId)));
  }
  const wins = scores.reduce((sum, score) => sum + score, 0);
  return { wins, n: scores.length, quality: scores.length ? wins / scores.length : 0, usdPerSuccess: wins ? costUsd / wins : null, costUsd };
}

export function productionEffortProjector(request: EffortCellRequest): number {
  if (request.target === "judge") return ({ low: 3.95, medium: 5.15, high: 6.35, xhigh: 8.75 } as Record<string, number>)[request.level] ?? 8.75;
  if (request.target === "generator+brain" || request.target === "generator" || request.target === "brain") {
    if (request.kind === "aa") return 53.42;
    const cell = ({ low: 46.33, medium: 50.95, high: 55.57, xhigh: 64.81 } as Record<string, number>)[request.level] ?? 64.81;
    return cell + 2.47 + (request.level === "low" ? 50.95 : 0);
  }
  if (request.target === "builder") return ({ low: 44.5, medium: 50.5, high: 56.4, xhigh: 68.4 } as Record<string, number>)[request.level] ?? 68.4;
  if (request.target === "auditor") return 52.25;
  return 0;
}

/** Build the real runtime-backed handler consumed by `kiln evals effort`. */
export async function createProductionEffortSweepDeps(
  home: string, cfg: KilnConfig, cli: CliDeps = {}, overrides: ProductionEffortVehicleOverrides = {},
): Promise<RunEffortSweepDeps> {
  const frozenCli: CliDeps = { ...cli, runtimeEffort: { enabled: false, profile: "default" } };
  const runtime = overrides.runtime ?? await createCliRuntime(home, cfg, frozenCli);
  const context: ProductionEffortVehicleContext = { home, cfg, cli: frozenCli, runtime,
    executor: overrides.executor ?? createRunExecutor(home, frozenCli), clone: overrides.clone ?? cloneRunAcrossHomes };
  const handler: EffortSweepHandler = (request) => request.target === "judge"
    ? (overrides.judge ?? judgeVehicle)(request, context)
    : request.target === "builder" || request.target === "auditor"
      ? (overrides.build ?? buildVehicle)(request, context)
      : (overrides.ideate ?? ideateVehicle)(request, context);
  const project: EffortSweepProjector = productionEffortProjector;
  return { models: runtime.models, git: overrides.git ?? new RealGitRunner(), handler, project };
}
