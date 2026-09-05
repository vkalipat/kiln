import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog";
import { loadPrompt } from "../brain/prompts";
import { validateDelta } from "../build/delta";
import type { GitRunner } from "../build/git";
import { foldState } from "../build/state";
import type { EvalCloneAfter, EvalPhasePlan, IdeaShape, KilnConfig, Role } from "../core/config";
import { candidatePath, ensureDir, writeAtomic } from "../core/paths";
import { RunRecord } from "../core/record";
import { readStatus, runPaths, type RunPaths } from "../core/run";
import { cloneRunAcrossHomes } from "../evals/clone";
import { readCost } from "../evals/cost";
import { effortsSwept, readEffortFile, resolveEffort, type EffortSeat } from "../evals/effort";
import { pairCensoredBy, type RunExecutor, type RunExecutorSpec, type RunSummary } from "../evals/executor";
import { judgeArms, type JudgingSeed } from "../evals/judging";
import { leakcheck } from "../evals/leakcheck";
import { verifyEvalsManifest } from "../evals/manifest";
import { passReport, type EvalPassReport, type EvalReport, type EvalRunReport, type FrozenEffort, type JudgeCalibrationStamp } from "../evals/report";
import { loadSeeds, type LoadedSeed } from "../evals/seeds";
import { gate, type CollapsedJudgedPair } from "../evals/wilson";
import type { JudgeDeps } from "../ideation/judge";
import { trigramJaccard } from "../ideation/novelty";
import { acquireEvolveLock } from "./lock";
import { conflictRequestHash } from "./conflict";
import type { ConflictArbiter, ConflictInput, ConflictVerdict } from "./operator";
import { activeBulletCount, applyDelta, parsePlaybook, playbookHash } from "./playbook";
import { assertCandidateId, readCandidate, type Candidate } from "./candidate";
import { stageHome } from "./stage";

export type EvolutionClass = "ideate" | "form" | "build";
export type EvolutionArchiveReason = "invalid" | "stale_champion" | "heldout_seed" | "leak" | "playbook_overflow" | "conflicting_bullet" | "conflicting_prompt" | "duplicate_bullet" | "lost_dev";
export interface EvalProjection { pairFloorUsd: number; expectedUsd: number; ceilingUsd: number; seedPairs: number }
export interface EvolutionConflictCheck { inputHash: string; kind: ConflictInput["kind"]; againstId: string | null; verdict: ConflictVerdict }
export interface EvolutionRunReport extends EvalRunReport { costUsd: number; sharedPrefixUsd?: number; censorStops?: RunSummary["censorStops"] }
export interface EvolutionEvalReport extends Omit<EvalReport<Candidate>, "runs"> {
  class: EvolutionClass; projection: EvalProjection; conflictChecks?: EvolutionConflictCheck[]; runs: EvolutionRunReport[];
}
export interface EvolutionJudgeInput { evalDir: string; seed: LoadedSeed; champion: RunPaths; candidate: RunPaths }
/** Must return the complete durable pair set for this seed, including lines from earlier invocations. */
export type EvolutionJudge = (input: EvolutionJudgeInput) => Promise<CollapsedJudgedPair[]>;
export type EvolutionBuildPairs = (input: { seed: LoadedSeed; champion: RunPaths; candidate: RunPaths; summaries: [RunSummary, RunSummary] }) => CollapsedJudgedPair[];
export type EvolutionClone = (input: { fromHome: string; fromId: string; toHome: string; toId: string; boundary: Exclude<EvalCloneAfter, "none"> }) => void;
export type EvolutionBoundaryReady = (summary: RunSummary, run: RunPaths, boundary: Exclude<EvalCloneAfter, "none">) => boolean;
export type EvolutionArchive = (reason: EvolutionArchiveReason, detail: string) => void | Promise<void>;
export interface EvolveEvalOptions { budgetUsd: number; rounds?: number; wallSeconds?: number; forceLock?: boolean; now?: () => Date; nowMs?: () => number }
export interface EvolveEvalDeps {
  git: GitRunner;
  executor: RunExecutor;
  judge: EvolutionJudge;
  arbiter: ConflictArbiter;
  archive: EvolutionArchive;
  models: (role: Role) => { model: Model; ref: string };
  calibration?: JudgeCalibrationStamp;
  buildPairs?: EvolutionBuildPairs;
  clone?: EvolutionClone;
  boundaryReady?: EvolutionBoundaryReady;
}

export class EvolutionEvalError extends Error {
  constructor(readonly reason: string, detail?: string) { super(detail ? `${reason}: ${detail}` : reason); this.name = "EvolutionEvalError"; }
}

const SECTION_PROMPT: Record<string, Role> = { lenses: "generator", frame: "brain", discover: "brain", ideate: "brain", form: "brain", build: "builder" };
const PROMPT_ROLE: Partial<Record<string, Role>> = { brain: "brain", scout: "scout", generator: "generator", prober: "prober", arbiter: "arbiter", critic: "critic", builder: "builder", auditor: "auditor" };

export function candidatePlan(candidate: Candidate, cfg: KilnConfig): { plan: EvalPhasePlan; class: EvolutionClass; role: Role } {
  const role = candidate.kind === "prompt" ? PROMPT_ROLE[candidate.prompt!.name] : SECTION_PROMPT[candidate.delta!.section];
  if (!role) throw new EvolutionEvalError("invalid", "candidate has no runnable evaluator role");
  const plan = candidate.kind === "prompt" ? cfg.evals.rolePhases[role] : cfg.evals.sectionPhases[candidate.delta!.section as keyof typeof cfg.evals.sectionPhases];
  if (!plan) throw new EvolutionEvalError("invalid", "candidate has no configured phase plan");
  const kind: EvolutionClass = plan.cloneAfter === "freeze" ? "build" : plan.cloneAfter === "checkpoint" ? "form" : "ideate";
  return { plan, class: kind, role };
}

export function evalPairFloor(cfg: KilnConfig, kind: EvolutionClass): number {
  const through = kind === "ideate" ? ["frame", "discover", "ideate"] as const : ["frame", "discover", "ideate", "form", "build"] as const;
  const runBudgetUsd = cfg.evals.runBudgetUsd ?? cfg.budgets.usd;
  const runCeiling = through.reduce((sum, phase) => sum + runBudgetUsd * cfg.budgets.share[phase], 0);
  return 2 * runCeiling + (kind === "ideate" ? 0.24 : 0);
}

export function evalProjection(cfg: KilnConfig, kind: EvolutionClass, seedPairs = 24): EvalProjection {
  const pairFloorUsd = evalPairFloor(cfg, kind);
  const judgeUsd = kind === "ideate" ? 0.24 : 0;
  const runCeiling = (pairFloorUsd - judgeUsd) / 2;
  const modeled = kind === "ideate" ? (cfg.evals.rounds ?? cfg.ideation.rounds) === 1 ? 3.97 : 10.19 : 22.95;
  const expectedPerRun = Math.min(modeled, runCeiling);
  return { pairFloorUsd, expectedUsd: seedPairs * (2 * expectedPerRun + judgeUsd), ceilingUsd: seedPairs * pairFloorUsd, seedPairs };
}

function digestHeadings(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => line.startsWith("## ") ? [line.slice(3).trim()] : []);
}
function json(path: string): unknown { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } }
function promptForSection(section: string): "generator" | "builder" | "brain" { return SECTION_PROMPT[section] === "generator" ? "generator" : SECTION_PROMPT[section] === "builder" ? "builder" : "brain"; }

type PlaybookPreflight = { ok: true; playbook: string; conflictChecks: EvolutionConflictCheck[] } | { ok: false; reason: string };
function usableConflict(check: EvolutionConflictCheck | undefined, input: ConflictInput): ConflictVerdict | undefined {
  if (!check || check.inputHash !== conflictRequestHash(input) || check.kind !== input.kind || check.againstId !== input.againstId) return undefined;
  const verdict = check.verdict;
  if (typeof verdict?.conflicts !== "boolean" || !(verdict.against === null || typeof verdict.against === "string") || typeof verdict.reason !== "string" || !verdict.reason.trim()
    || (verdict.conflicts && verdict.against !== input.againstId)) throw new EvolutionEvalError("integrity", "stored conflict verdict is malformed");
  return verdict;
}
async function validatePlaybookCandidate(
  home: string, id: string, candidate: Candidate, playbook: string, arbiter: ConflictArbiter, now: Date,
  cached: readonly EvolutionConflictCheck[] = [],
): Promise<PlaybookPreflight> {
  const delta = candidate.delta!; const source = candidate.runId ? runPaths(home, candidate.runId) : undefined;
  const rolePrompt = loadPrompt(home, promptForSection(delta.section));
  const context = { digestHeadings: source ? digestHeadings(source.digest) : [], runDir: source?.dir ?? home,
    projectDir: source && existsSync(source.status) ? readStatus(source).projectDir : undefined,
    metrics: source ? json(source.metrics) : {}, playbook, kernel: loadPrompt(home, "kernel"), rolePrompt };
  const valid = validateDelta(delta, context); if (!valid.ok) return { ok: false, reason: valid.reason };
  if (delta.op === "add" && activeBulletCount(playbook) >= 120) return { ok: false, reason: "playbook_overflow" };
  let next: string;
  try { next = applyDelta(playbook, delta, { by: id, at: candidate.createdAt || now }); }
  catch (error) { return { ok: false, reason: (error as Error).message }; }
  if (activeBulletCount(next) > 120) return { ok: false, reason: "playbook_overflow" };
  const section = parsePlaybook(playbook).sections.find((held) => held.name === delta.section);
  const text = `${delta.text}${delta.why && !/\bWhy:\s/.test(delta.text) ? ` Why: ${delta.why}` : ""}`;
  const siblings = (section?.bullets ?? []).filter((bullet) => bullet.id !== delta.id)
    .map((bullet) => ({ bullet, score: trigramJaccard(text, bullet.text) }))
    .sort((a, b) => b.score - a.score || a.bullet.id.localeCompare(b.bullet.id)).slice(0, 5);
  const inputs = [{ kind: "role_prompt" as const, against: rolePrompt, againstId: null },
    ...siblings.map(({ bullet }) => ({ kind: "sibling" as const, against: bullet.text, againstId: bullet.id }))];
  if (cached.length > inputs.length) throw new EvolutionEvalError("integrity", "stored conflict checks exceed the current preflight");
  const conflictChecks: EvolutionConflictCheck[] = [];
  for (const [index, check] of inputs.entries()) {
    const input = { bullet: text, ...check } satisfies ConflictInput;
    const stored = cached[index]; const replayed = usableConflict(stored, input);
    if (stored && !replayed) throw new EvolutionEvalError("integrity", "stored conflict check no longer matches the preflight");
    const verdict = replayed ?? await arbiter(input);
    if (typeof verdict?.conflicts !== "boolean" || !(verdict.against === null || typeof verdict.against === "string") || typeof verdict.reason !== "string" || !verdict.reason.trim()) {
      return { ok: false, reason: "arbiter_invalid" };
    }
    if (verdict.conflicts && verdict.against !== check.againstId) return { ok: false, reason: "arbiter_invalid" };
    conflictChecks.push({ inputHash: conflictRequestHash(input), kind: input.kind, againstId: input.againstId, verdict });
    if (verdict.conflicts) return { ok: false, reason: check.kind === "role_prompt" ? "conflicting_prompt" : "conflicting_bullet" };
  }
  return { ok: true, playbook: next, conflictChecks };
}

function blockedDirty(status: string): string[] {
  return status.split(/\r?\n/).flatMap((line) => {
    const path = line.slice(3).split(" -> ").at(-1) ?? "";
    return path === "config.json" || ["playbook/", "prompts/", "evals/"].some((prefix) => path.startsWith(prefix)) ? [path] : [];
  });
}
function judgeGateDirty(diff: string): boolean {
  return diff.split(/\r?\n/).some((line) => (/^[+-](?![+-])/.test(line) && /["']?judgeGate["']?\s*[:=]/.test(line)));
}

function emptyPass(cfg: KilnConfig): EvalPassReport {
  return passReport([], { seeds: 0, uncensoredSeeds: 0, seedWins: 0, level: cfg.evals.level, minPairs: cfg.evals.minPairs, minUncensoredSeeds: cfg.evals.minUncensoredSeeds });
}
function frozenBudgets(cfg: KilnConfig) {
  const { phaseBudgetUsd: _usd, phaseBudgetWallSeconds: _wall, ...plain } = cfg.budgets;
  return { ...plain, usd: cfg.evals.runBudgetUsd ?? plain.usd, wallSeconds: cfg.evals.runWallSeconds ?? plain.wallSeconds };
}
function effortState(home: string, cfg: KilnConfig, deps: EvolveEvalDeps, roles: Role[]) {
  const effort: Record<string, Partial<Record<Role, FrozenEffort>>> = { champion: {}, candidate: {} };
  const file = readEffortFile(home);
  const seats: Partial<Record<Role, EffortSeat>> = {};
  for (const role of roles) {
    const held = deps.models(role); seats[role] = held;
    const resolved = resolveEffort(cfg, role, held, file, "default");
    if (resolved.level && ["low", "medium", "high", "xhigh"].includes(resolved.level)) {
      const value = { level: resolved.level as FrozenEffort["level"], source: resolved.source === "global" ? "fallback" as const : resolved.source };
      effort.champion![role] = value; effort.candidate![role] = value;
    }
  }
  return { effort, swept: effortsSwept(roles, seats, file, "default") };
}

function row(summary: RunSummary, seed: LoadedSeed, censor: ReturnType<typeof pairCensoredBy>, cfg: KilnConfig, sharedPrefixUsd?: number): EvolutionRunReport {
  const outcome = summary.status.outcome;
  return { runId: summary.runId, seedId: seed.id, split: seed.split, shape: seed.shape, arm: summary.arm, state: summary.status.state,
    ...(outcome ? { outcome } : {}), ...(outcome?.stopKind ? { stopKind: outcome.stopKind } : {}), pairCensored: censor.length > 0,
    pairCensoredBy: censor as EvalRunReport["pairCensoredBy"], ...(outcome?.kind === "honest_exit" ? { honestExit: outcome.exitKind } : {}),
    ...(outcome?.kind === "failure" ? { failedClass: outcome.failureClass } : {}), shapeMismatch: summary.shape !== "unknown" && summary.shape !== seed.shape,
    cacheHealthy: null, unhealthyCallsByRole: {},
    ...(cfg.evals.runBudgetUsd === undefined ? {} : { runBudgetUsd: cfg.evals.runBudgetUsd }),
    ...(cfg.evals.runWallSeconds === undefined ? {} : { runWallSeconds: cfg.evals.runWallSeconds }),
    ...(summary.censorStops === undefined ? {} : { censorStops: summary.censorStops }),
    metrics: summary.metrics, cost: readCost(summary.metrics), costUsd: summary.costUsd,
    ...(sharedPrefixUsd === undefined ? {} : { sharedPrefixUsd }) };
}
function upsert(report: EvolutionEvalReport, value: EvolutionRunReport): void {
  const index = report.runs.findIndex((held) => held.runId === value.runId); if (index < 0) report.runs.push(value); else report.runs[index] = value;
}
function writeReport(path: string, report: EvolutionEvalReport, now: () => Date): void {
  report.updatedAt = now().toISOString(); writeAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
}
function summaryFromRow(value: EvolutionRunReport): RunSummary {
  return { runId: value.runId, seedId: value.seedId, split: value.split, shape: value.shape, arm: value.arm,
    status: { id: value.runId, phase: "ideate", state: value.state, outcome: value.outcome, usdSpent: 0, turns: {}, createdAt: "", updatedAt: "" },
    outcome: value.outcome, censorStops: value.censorStops ?? value.pairCensoredBy, costUsd: value.costUsd, metrics: value.metrics };
}
function mirrorPrefix(summary: RunSummary, runId: string): RunSummary {
  return { ...summary, runId, arm: "candidate", costUsd: 0, status: { ...summary.status, id: runId } };
}
function reportCost(report: EvolutionEvalReport, record: RunRecord): number {
  let total = report.runs.reduce((sum, held) => sum + held.costUsd, 0) + record.costUsd();
  const seeds = new Set(report.runs.map((row) => row.seedId));
  for (const seed of seeds) {
    const rows = report.runs.filter((row) => row.seedId === seed && row.sharedPrefixUsd !== undefined);
    if (rows.length >= 2) total -= Math.max(...rows.map((row) => row.sharedPrefixUsd ?? 0));
  }
  return total;
}

/** Cross-stage clone seam backed by the canonical boundary-validating clone implementation. */
export const cloneEvolutionRun: EvolutionClone = (input) => { cloneRunAcrossHomes(input); };
export const evolutionBoundaryReady: EvolutionBoundaryReady = (summary, run, boundary) => boundary === "checkpoint"
  ? summary.status.phase === "ideate" && summary.status.cursor?.step === "checkpoint" && existsSync(run.frontier)
  : summary.status.phase === "build" && summary.status.state === "running" && existsSync(run.features) && existsSync(run.acceptanceLock) && existsSync(run.project);

export function createEvolutionJudge(depsFor: (evalDir: string) => JudgeDeps, pairsPerSeed: number): EvolutionJudge {
  return async ({ evalDir, seed, champion, candidate }) => {
    const result = await judgeArms(evalDir, { id: seed.id, text: seed.text, shape: seed.shape } satisfies JudgingSeed,
      { name: "champion", run: champion }, { name: "candidate", run: candidate }, depsFor(evalDir), { pairsPerSeed });
    return result.collapsed.value.map((pair) => ({ score: 1 - pair.score, seedId: seed.id }));
  };
}

function defaultBuildPairs(input: Parameters<EvolutionBuildPairs>[0]): CollapsedJudgedPair[] {
  const champion = foldState(input.champion); const candidate = foldState(input.candidate);
  return [...new Set([...Object.keys(champion), ...Object.keys(candidate)])].sort().map((id) => {
    const a = champion[id]?.passes && champion[id]?.passSource === "executed"; const b = candidate[id]?.passes && candidate[id]?.passSource === "executed";
    return { score: b === a ? 0.5 : b ? 1 : 0, seedId: input.seed.id };
  });
}

function seedWin(pairs: readonly CollapsedJudgedPair[], champion: RunSummary, candidate: RunSummary): number {
  const failed = (run: RunSummary) => run.status.outcome?.kind === "honest_exit" || run.status.outcome?.kind === "failure";
  const championFailed = failed(champion); const candidateFailed = failed(candidate);
  if (championFailed && candidateFailed) return 0.5;
  if (championFailed !== candidateFailed) return championFailed ? 1 : 0;
  if (pairs.length === 0) return 0.5;
  const rate = pairs.reduce((sum, pair) => sum + pair.score, 0) / pairs.length; return rate > 0.5 ? 1 : rate < 0.5 ? 0 : 0.5;
}

function frozenEqual(a: EvolutionEvalReport["frozen"], b: EvolutionEvalReport["frozen"]): string[] {
  return Object.keys(a).filter((key) => JSON.stringify(a[key as keyof typeof a]) !== JSON.stringify(b[key as keyof typeof b]));
}

/** Full staged dev/held-out evaluation. No phase or provider is constructed unless supplied in deps. */
export async function evolveEval(home: string, id: string, cfg: KilnConfig, options: EvolveEvalOptions, deps: EvolveEvalDeps): Promise<EvolutionEvalReport> {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new EvolutionEvalError("usage", "--budget is required and must be positive");
  try { assertCandidateId(id); } catch (error) { throw new EvolutionEvalError("invalid_candidate_id", (error as Error).message); }
  const now = options.now ?? (() => new Date()); const nowMs = options.nowMs ?? Date.now;
  const lock = acquireEvolveLock(home, { force: options.forceLock });
  try {
    const fail = async (reason: EvolutionArchiveReason | "integrity" | "dirty_tree" | "candidate_not_found", detail: string, archive = false): Promise<never> => {
      if (archive) await deps.archive(reason === "integrity" ? "invalid" : reason as EvolutionArchiveReason, detail);
      throw new EvolutionEvalError(reason, detail);
    };
    const manifest = verifyEvalsManifest(home); if (!manifest.ok) await fail("integrity", [...manifest.changed, ...manifest.missing, ...manifest.extra].join(", "), true);
    const dirty = blockedDirty(await deps.git.statusPorcelain(home));
    if (dirty.some((path) => path !== "config.json")) await fail("dirty_tree", dirty.join(", "));
    if (dirty.includes("config.json") && judgeGateDirty(await deps.git.diff(home, { ref: "HEAD", path: "config.json" }))) await fail("dirty_tree", "config.json evals.judgeGate differs from HEAD");
    if (existsSync(join(home, "evolution", "archive", id))) await fail("invalid", "archive is terminal in v1; reflect again", false);
    const path = candidatePath(home, id); if (!existsSync(path)) await fail("candidate_not_found", id);
    const championText = readFileSync(join(home, "playbook", "playbook.md"), "utf8"); const championHash = playbookHash(championText);
    const checked = readCandidate(path, { currentPlaybookHash: championHash });
    if ("reason" in checked) await fail(checked.reason === "stale_champion" ? "stale_champion" : "invalid", checked.reason, true);
    const candidate = checked as Candidate;
    let heldout = candidate.seed?.split === "heldout";
    if (!heldout && candidate.runId && existsSync(runPaths(home, candidate.runId).status)) heldout = readStatus(runPaths(home, candidate.runId)).seed?.split === "heldout";
    if (heldout) await fail("heldout_seed", candidate.seed?.id ?? candidate.runId ?? id, true);
    const leaks = leakcheck(home); if (!leaks.ok) await fail("leak", leaks.rows.map((row) => `${row.kind}:${row.source}`).join(", "), true);
    const planned = candidatePlan(candidate, cfg); let candidatePlaybook = championText; let conflictChecks: EvolutionConflictCheck[] = [];
    const projection = evalProjection(cfg, planned.class);
    if (options.budgetUsd < projection.pairFloorUsd) throw new EvolutionEvalError("budget", `budget $${options.budgetUsd.toFixed(2)} is below one pair ceiling $${projection.pairFloorUsd.toFixed(2)}`);
    const reportDir = join(home, "evolution", "reports", id); const reportPath = join(reportDir, "eval.json");
    const priorReport = existsSync(reportPath) ? json(reportPath) as EvolutionEvalReport : undefined;
    const rounds = options.rounds ?? cfg.evals.rounds ?? cfg.ideation.rounds;
    const scoredRoles = planned.class === "ideate" ? ["brain", "generator", "judge"] as Role[] : planned.class === "build" ? ["builder", "auditor"] as Role[] : [planned.role];
    const effort = effortState(home, cfg, deps, scoredRoles);
    const frozen = { k: cfg.evals.pairsPerSeed, sweepPairsPerSeed: cfg.evals.sweepPairsPerSeed, level: cfg.evals.level, rounds,
      minPairs: cfg.evals.minPairs, minUncensoredSeeds: cfg.evals.minUncensoredSeeds, noninferiorityMargin: cfg.evals.noninferiorityMargin,
      seating: { champion: "default", candidate: "default" }, effort: effort.effort, roles: cfg.roles, budgets: frozenBudgets(cfg) };
    if (priorReport) {
      if (priorReport.playbookHash !== championHash) await fail("stale_champion", "champion moved since eval start", true);
      if (JSON.stringify(priorReport.candidate) !== JSON.stringify(candidate)) await fail("integrity", "candidate changed since eval start", false);
      if (priorReport.class !== planned.class) await fail("integrity", "candidate class changed since eval start", false);
      const changed = frozenEqual(priorReport.frozen, frozen); if (changed.length) await fail("integrity", `frozen config changed: ${changed.join(", ")}`, false);
    }
    const cachedChecks = Array.isArray(priorReport?.conflictChecks)
      ? priorReport.conflictChecks.filter((item) => item !== null && typeof item === "object") : [];
    if (candidate.kind === "playbook") {
      const validated = await validatePlaybookCandidate(home, id, candidate, championText, deps.arbiter, now(), cachedChecks);
      if (!validated.ok) {
        const known = (["playbook_overflow", "conflicting_bullet", "conflicting_prompt"] as const).find((reason) => validated.reason.startsWith(reason));
        await fail(known ?? (validated.reason.startsWith("duplicate_bullet") ? "duplicate_bullet" : "invalid"), validated.reason, true);
      } else {
        candidatePlaybook = validated.playbook;
        conflictChecks = validated.conflictChecks;
      }
    }
    ensureDir(join(reportDir, "criteria"));
    const evalRecord = new RunRecord(join(reportDir, "record.jsonl"));
    let report = priorReport;
    if (report) {
      report.budgetUsd = options.budgetUsd; report.conflictChecks = conflictChecks; writeReport(reportPath, report, now);
    } else {
      report = { version: 1, evalId: id, candidateId: id, candidate, playbookHash: championHash, class: planned.class, projection,
        frozen, effortSwept: effort.swept, judgeCalibration: deps.calibration ?? { status: "absent" }, startedAt: now().toISOString(), updatedAt: now().toISOString(),
        budgetUsd: options.budgetUsd, costUsd: 0, conflictChecks, runs: [], passes: { dev: emptyPass(cfg), heldout: emptyPass(cfg) }, verdict: "incomplete" };
      writeReport(reportPath, report, now);
    }
    const championStage = stageHome(home, id, "champion");
    const candidateStage = stageHome(home, id, "candidate", candidate.kind === "prompt"
      ? { prompts: { [candidate.prompt!.name]: candidate.prompt!.text } }
      : { playbook: candidatePlaybook });
    delete report.stoppedReason;
    const allPairs: Record<"dev" | "heldout", CollapsedJudgedPair[]> = { dev: [], heldout: [] }; const seedWins = { dev: 0, heldout: 0 }; const uncensored = { dev: 0, heldout: 0 }; const processed = { dev: 0, heldout: 0 };
    const clone = deps.clone ?? cloneEvolutionRun; const deadline = nowMs() + (options.wallSeconds ?? cfg.evals.wallSeconds) * 1_000;
    let stoppedReason: "budget" | "deadline" | undefined;
    for (const split of ["dev", "heldout"] as const) {
      if (split === "heldout" && report.stoppedEarly === "lost_dev") break;
      for (const seed of loadSeeds(home, split)) {
        const ids = { champion: `${id}-${seed.id}-champion`, candidate: `${id}-${seed.id}-candidate` };
        const previous = (arm: string) => report!.runs.find((held) => held.runId === ids[arm as keyof typeof ids] && ["done", "stopped", "failed"].includes(held.state));
        const owed = !previous("champion") || !previous("candidate");
        report.costUsd = reportCost(report, evalRecord);
        if (owed && options.budgetUsd - report.costUsd < projection.pairFloorUsd) { stoppedReason = "budget"; break; }
        if (owed && nowMs() >= deadline) { stoppedReason = "deadline"; break; }
        const common = (arm: "champion" | "candidate", stagedHome: string): RunExecutorSpec => ({ home: stagedHome, seedText: seed.text,
          seedIdentity: { id: seed.id, split, sha256: seed.sha256 }, arm, through: planned.plan.through, cloneAfter: planned.plan.cloneAfter,
          rounds, runId: ids[arm], effort: effort.effort[arm] ?? {} });
        let champion = previous("champion") ? summaryFromRow(previous("champion")!) : undefined;
        let challenger = previous("candidate") ? summaryFromRow(previous("candidate")!) : undefined;
        let sharedPrefixUsd = previous("champion")?.sharedPrefixUsd ?? previous("candidate")?.sharedPrefixUsd;
        let prefixPaused = false;
        if (planned.plan.cloneAfter === "none") {
          if (!champion) { champion = await deps.executor(common("champion", championStage.home)); upsert(report, row(champion, seed, [], cfg)); writeReport(reportPath, report, now); }
          if (!challenger) { challenger = await deps.executor(common("candidate", candidateStage.home)); upsert(report, row(challenger, seed, [], cfg)); writeReport(reportPath, report, now); }
        } else {
          const prefixThrough = planned.plan.cloneAfter === "checkpoint" ? "ideate" : "form";
          let cloned = existsSync(runPaths(candidateStage.home, ids.candidate).status);
          if (!champion) {
            const prefix = await deps.executor({ ...common("champion", championStage.home), through: prefixThrough, cloneAfter: "none" });
            const abnormal = prefix.status.state === "paused" || prefix.status.outcome?.kind === "failure" || prefix.status.outcome?.kind === "honest_exit"
              || !(deps.boundaryReady ?? evolutionBoundaryReady)(prefix, runPaths(championStage.home, ids.champion), planned.plan.cloneAfter);
            if (abnormal) {
              champion = prefix; challenger = mirrorPrefix(prefix, ids.candidate); prefixPaused = prefix.status.state === "paused";
              upsert(report, row(champion, seed, [], cfg)); upsert(report, row(challenger, seed, [], cfg)); writeReport(reportPath, report, now);
            } else {
              sharedPrefixUsd = prefix.costUsd;
              if (!cloned) { clone({ fromHome: championStage.home, fromId: ids.champion, toHome: candidateStage.home, toId: ids.candidate, boundary: planned.plan.cloneAfter }); cloned = true; }
              champion = await deps.executor(common("champion", championStage.home)); upsert(report, row(champion, seed, [], cfg, sharedPrefixUsd)); writeReport(reportPath, report, now);
            }
          }
          if (!challenger && !cloned) clone({ fromHome: championStage.home, fromId: ids.champion, toHome: candidateStage.home, toId: ids.candidate, boundary: planned.plan.cloneAfter });
          if (!challenger) { challenger = await deps.executor(common("candidate", candidateStage.home)); upsert(report, row(challenger, seed, [], cfg, sharedPrefixUsd)); writeReport(reportPath, report, now); }
        }
        processed[split] += 1;
        const censor = pairCensoredBy([champion!, challenger!]); upsert(report, row(champion!, seed, censor, cfg, sharedPrefixUsd)); upsert(report, row(challenger!, seed, censor, cfg, sharedPrefixUsd));
        const failed = [champion!, challenger!].some((summary) => summary.status.outcome?.kind === "failure");
        if (censor.length === 0 && !failed) {
          uncensored[split] += 1; let pairs: CollapsedJudgedPair[] = [];
          const honest = [champion!, challenger!].some((summary) => summary.status.outcome?.kind === "honest_exit");
          if (!honest && planned.class === "ideate") pairs = await deps.judge({ evalDir: reportDir, seed, champion: runPaths(championStage.home, ids.champion), candidate: runPaths(candidateStage.home, ids.candidate) });
          else if (planned.class === "build" && sharedPrefixUsd !== undefined) pairs = (deps.buildPairs ?? defaultBuildPairs)({ seed, champion: runPaths(championStage.home, ids.champion), candidate: runPaths(candidateStage.home, ids.candidate), summaries: [champion!, challenger!] });
          else if (!honest && planned.class === "form") {
            const count = (run: RunSummary) => Number((run.metrics.featuresPassed as { executed?: number } | undefined)?.executed ?? 0);
            pairs = [{ score: count(challenger!) === count(champion!) ? 0.5 : count(challenger!) > count(champion!) ? 1 : 0, seedId: seed.id }];
          }
          allPairs[split].push(...pairs); seedWins[split] += seedWin(pairs, champion!, challenger!);
        }
        writeReport(reportPath, report, now);
        if (prefixPaused) { stoppedReason = "deadline"; break; }
      }
      const pass = passReport(allPairs[split], { seeds: processed[split], uncensoredSeeds: uncensored[split], seedWins: seedWins[split],
        level: cfg.evals.level, minPairs: cfg.evals.minPairs, minUncensoredSeeds: cfg.evals.minUncensoredSeeds });
      report.passes[split] = pass; writeReport(reportPath, report, now);
      if (stoppedReason) break;
      if (split === "dev" && pass.pairs > 0 && pass.wilson.upper < 0.5) {
        report.verdict = "lose"; report.stoppedEarly = "lost_dev"; writeReport(reportPath, report, now); await deps.archive("lost_dev", "dev Wilson upper bound is below 0.5"); return report;
      }
    }
    report.costUsd = reportCost(report, evalRecord);
    if (stoppedReason) { report.verdict = "incomplete"; report.stoppedReason = stoppedReason; }
    else if (planned.class === "form") report.verdict = "not_evidence";
    else if (uncensored.heldout === 0) report.verdict = "censored";
    else report.verdict = gate(allPairs.heldout, { level: cfg.evals.level, minPairs: cfg.evals.minPairs, minUncensoredSeeds: cfg.evals.minUncensoredSeeds, uncensoredSeeds: uncensored.heldout }).verdict;
    report.gap = report.passes.dev.rate - report.passes.heldout.rate; writeReport(reportPath, report, now); return report;
  } finally { lock.release(); }
}

export const runEvolutionEval = evolveEval;
