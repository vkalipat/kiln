import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PHASES, ROLES, type Effort, type Phase, type Role } from "../core/config";
import { foldCost, survivingIdeaCount, type CostBlock } from "../core/cost";
import type { StopKind, StoredEvent } from "../core/events";
import { writeAtomic } from "../core/paths";
import { RunRecord } from "../core/record";
import { readStatus, type RunPaths } from "../core/run";
import type { Evidence } from "./dossier";
import { collapsePairs } from "./bt";
import { readTournament, selfPreferenceRisk, type TournamentRecord } from "./tournament";

export interface IdeationMetrics {
  schemaVersion: 1;
  modelCalls: number;
  costUsd: number;
  costByRole: Record<Role, number>;
  costByPhase: Record<Phase, number>;
  cost: Record<Phase, CostBlock>;
  tokensByRole: Record<Role, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  refusals: { byRole: Record<Role, number>; byCategory: Record<string, number> };
  addendaHashes: string[];
  effortByRole: Record<Role, Effort | null>;
  arbiterCalls: { novelty: number; collision: number };
  similarity: { count: number; min: number | null; max: number | null; mean: number | null; p50: number | null };
  searchHealth: { healthy: number; total: number; rate: number; floor: number };
  noveltyEnforced: boolean;
  collisionRate: number | null;
  priorArt: { collided: number; notFalsified: number; searchFailed: number };
  probes: { pass: number; fail: number; timeout: number; error: number; notRun: number; passRate: number | null };
  tournament: {
    lines: number;
    pairs: number;
    incompletePairs: number;
    tieRate: { value: number | null; feasibility: number | null };
    haloCorrelation: number | null;
    selfPreferenceRisk: Record<"none" | "a" | "b" | "both", number>;
  };
  frontier: { raw: number; shown: number };
  stops: Record<StopKind, number>;
  honestExits: { total: number; declaredNoIdea: number; mechanicalNoIdea: number };
  corruptRecordLines: number;
}

/** Backward-compatible name for pre-build consumers; combined metrics live in build/metrics. */
export type Metrics = IdeationMetrics;

export const STOP_KINDS: readonly StopKind[] = ["rounds", "stagnant", "stalled", "budget", "no_idea_clears_bar", "blocked", "deadline", "transient"];

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function evidence(paths: RunPaths): Evidence[] {
  if (!existsSync(paths.ideasDir)) return [];
  const out: Evidence[] = [];
  for (const file of readdirSync(paths.ideasDir).filter((name) => name.endsWith(".evidence.json")).sort()) {
    try {
      const value = JSON.parse(readFileSync(join(paths.ideasDir, file), "utf8")) as Evidence;
      if (value && typeof value === "object") out.push(value);
    } catch {
      // A torn sidecar is absent evidence; the archive will reconstruct it on resume.
    }
  }
  return out;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)]!;
}

function winnerValue(winner: string): number {
  return winner === "a" ? 1 : winner === "b" ? -1 : 0;
}

/** Pearson correlation between the two decisions returned by each judge call. */
export function haloCorrelation(lines: readonly Pick<TournamentRecord, "valueWinner" | "feasibilityWinner">[]): number | null {
  if (lines.length < 2) return null;
  const xs = lines.map((line) => winnerValue(line.valueWinner));
  const ys = lines.map((line) => winnerValue(line.feasibilityWinner));
  const mx = xs.reduce((sum, n) => sum + n, 0) / xs.length;
  const my = ys.reduce((sum, n) => sum + n, 0) / ys.length;
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    covariance += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return vx === 0 || vy === 0 ? null : covariance / Math.sqrt(vx * vy);
}

function frontierSizes(paths: RunPaths): { raw: number; shown: number } {
  if (!existsSync(paths.frontier)) return { raw: 0, shown: 0 };
  try {
    const f = JSON.parse(readFileSync(paths.frontier, "utf8")) as { rawFront?: unknown[]; shown?: unknown[]; ideas?: unknown[] };
    const shown = Array.isArray(f.shown) ? f.shown.length : Array.isArray(f.ideas) ? f.ideas.length : 0;
    return { raw: Array.isArray(f.rawFront) ? f.rawFront.length : shown, shown };
  } catch {
    return { raw: 0, shown: 0 };
  }
}

function phaseAt(events: readonly StoredEvent[]): Map<number, Phase> {
  const out = new Map<number, Phase>();
  let phase: Phase = "frame";
  for (const event of events) {
    if (event.t === "phase.start") phase = event.phase;
    out.set(event.seq, phase);
  }
  return out;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

/** Final executed passes visible in the record; build/metrics supplies its reconciled count. */
function recordedExecutedPasses(events: readonly StoredEvent[]): number {
  const sources = new Map<string, "executed" | "human">();
  for (const event of events) {
    if (event.t !== "feature.state") continue;
    if (event.to === "passed" && event.source) sources.set(event.featureId, event.source);
    else if (event.from !== event.to) sources.delete(event.featureId);
  }
  return [...sources.values()].filter((source) => source === "executed").length;
}

function phaseCosts(events: readonly StoredEvent[], buildSuccesses: number): Record<Phase, CostBlock> {
  const successes: Record<Phase, number> = {
    frame: events.some((event) => event.t === "phase.end" && event.phase === "frame" && event.outcome === "ok") ? 1 : 0,
    discover: events.some((event) => event.t === "phase.end" && event.phase === "discover" && event.outcome === "ok") ? 1 : 0,
    ideate: survivingIdeaCount(events),
    form: events.filter((event) => event.t === "freeze").length,
    build: buildSuccesses,
    reflect: events.filter((event) => event.t === "delta" && event.accepted).length,
  };
  return Object.fromEntries(PHASES.map((phase) => [phase, foldCost(events, phase, successes[phase])])) as Record<Phase, CostBlock>;
}

function refusalMetrics(events: readonly StoredEvent[]): IdeationMetrics["refusals"] {
  const byRole = zeros(ROLES);
  const callCategories: Record<string, number> = {};
  const failureCategories: Record<string, number> = {};
  for (const event of events) {
    if (event.t === "model.call" && (event.stopDetails?.type === "refusal" || event.stopDetails?.type === "sensitive")) {
      byRole[event.role] += 1;
      const category = event.stopDetails.category?.trim() || "unknown";
      callCategories[category] = (callCategories[category] ?? 0) + 1;
    }
    if (event.t === "failure" && event.class === "refusal" && event.category?.trim()) {
      const category = event.category.trim();
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
    }
  }
  const byCategory: Record<string, number> = {};
  for (const category of [...new Set([...Object.keys(callCategories), ...Object.keys(failureCategories)])].sort()) {
    // Task 4 journals both the provider call and its classified failure. Max keeps those two
    // views from double-counting while retaining legacy failures that lack structured call data.
    byCategory[category] = Math.max(callCategories[category] ?? 0, failureCategories[category] ?? 0);
  }
  return { byRole, byCategory };
}

function effortModes(events: readonly StoredEvent[]): Record<Role, Effort | null> {
  const counts = Object.fromEntries(ROLES.map((role) => [role, zeros(EFFORTS)])) as Record<Role, Record<Effort, number>>;
  for (const event of events) if (event.t === "model.call" && event.effortSent !== undefined) counts[event.role][event.effortSent] += 1;
  return Object.fromEntries(ROLES.map((role) => {
    let mode: Effort | null = null;
    let maximum = 0;
    // Fixed semantic order makes ties deterministic (the lower effort wins a tie).
    for (const effort of EFFORTS) if (counts[role][effort] > maximum) { mode = effort; maximum = counts[role][effort]; }
    return [role, mode];
  })) as Record<Role, Effort | null>;
}

/** Fold only durable artifacts. No in-memory orchestration state can improve this answer. */
export function computeMetrics(paths: RunPaths, options: { buildSuccesses?: number } = {}): IdeationMetrics {
  const record = new RunRecord(paths.record);
  const events = record.read();
  const corruptRecordLines = record.corrupt;
  const phaseBySeq = phaseAt(events);
  const costByRole = zeros(ROLES);
  const costByPhase = zeros(PHASES);
  const tokensByRole = Object.fromEntries(ROLES.map((role) => [role, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }])) as IdeationMetrics["tokensByRole"];
  let modelCalls = 0;
  for (const event of events) {
    if (event.t !== "model.call") continue;
    modelCalls += 1;
    costByRole[event.role] += event.costUsd;
    costByPhase[phaseBySeq.get(event.seq) ?? "frame"] += event.costUsd;
    const t = tokensByRole[event.role];
    t.input += event.usage.input;
    t.output += event.usage.output;
    t.cacheRead += event.usage.cacheRead;
    t.cacheWrite += event.usage.cacheWrite;
  }

  const sidecars = evidence(paths);
  const similarities = sidecars.flatMap((item) => (typeof item.similarity === "number" ? [item.similarity] : []));
  const priorArt = { collided: 0, notFalsified: 0, searchFailed: 0 };
  const probes = { pass: 0, fail: 0, timeout: 0, error: 0, notRun: 0, passRate: null as number | null };
  for (const item of sidecars) {
    if (item.priorArt?.status === "collided") priorArt.collided += 1;
    else if (item.priorArt?.status === "not_falsified") priorArt.notFalsified += 1;
    else if (item.priorArt?.status === "search_failed") priorArt.searchFailed += 1;
    if (item.probe?.status === "pass") probes.pass += 1;
    else if (item.probe?.status === "fail") probes.fail += 1;
    else if (item.probe?.status === "timeout") probes.timeout += 1;
    else if (item.probe?.status === "error") probes.error += 1;
    else if (item.probe?.status === "not_run") probes.notRun += 1;
  }
  const probeDenominator = probes.pass + probes.fail + probes.timeout;
  probes.passRate = probeDenominator === 0 ? null : probes.pass / probeDenominator;

  const status = readStatus(paths);
  const priorTotal = priorArt.collided + priorArt.notFalsified + priorArt.searchFailed;
  const healthy = priorArt.collided + priorArt.notFalsified;
  const healthRate = status.searchHealth ?? (priorTotal === 0 ? 1 : healthy / priorTotal);
  const healthFloor = status.searchHealthFloor ?? 0.8;
  const noveltyEnforced = status.noveltyEnforced ?? healthRate >= healthFloor;
  const searched = priorArt.collided + priorArt.notFalsified;

  const lines = readTournament(paths);
  const collapsed = collapsePairs(lines);
  const judgeLines = lines.filter((line) => line.source === "judge");
  const judgeCollapsed = collapsePairs(judgeLines);
  const ties = (axis: "value" | "feasibility") => {
    const values = judgeCollapsed[axis];
    return values.length === 0 ? null : values.filter((outcome) => outcome.score === 0.5).length / values.length;
  };
  const risks = zeros(["none", "a", "b", "both"] as const);
  for (const line of judgeLines) risks[selfPreferenceRisk(line)] += 1;
  const pairKeys = new Set(lines.map((line) => `${line.round}|${line.a}|${line.b}|${line.comparisonId ?? "judge"}`));

  const stops = zeros(STOP_KINDS);
  let honestTotal = 0;
  let declaredNoIdea = 0;
  for (const event of events) {
    if (event.t === "stop") stops[event.stopKind] += 1;
    if (event.t === "honest_exit") {
      honestTotal += 1;
      if (event.kind === "no_idea_clears_bar") declaredNoIdea += 1;
    }
  }

  return {
    schemaVersion: 1,
    modelCalls,
    costUsd: record.costUsd(),
    costByRole,
    costByPhase,
    cost: phaseCosts(events, options.buildSuccesses ?? recordedExecutedPasses(events)),
    tokensByRole,
    refusals: refusalMetrics(events),
    addendaHashes: [...new Set(events.flatMap((event) => event.t === "model.call" && event.addendaHash !== undefined ? [event.addendaHash] : []))],
    effortByRole: effortModes(events),
    arbiterCalls: {
      novelty: events.filter((event) => event.t === "arbiter.verdict" && event.kind === "novelty").length,
      collision: events.filter((event) => event.t === "arbiter.verdict" && event.kind === "collision").length,
    },
    similarity: {
      count: similarities.length,
      min: similarities.length === 0 ? null : Math.min(...similarities),
      max: similarities.length === 0 ? null : Math.max(...similarities),
      mean: similarities.length === 0 ? null : similarities.reduce((sum, n) => sum + n, 0) / similarities.length,
      p50: percentile(similarities, 0.5),
    },
    searchHealth: { healthy, total: priorTotal, rate: healthRate, floor: healthFloor },
    noveltyEnforced,
    collisionRate: noveltyEnforced && searched > 0 ? priorArt.collided / searched : null,
    priorArt,
    probes,
    tournament: {
      lines: lines.length,
      pairs: pairKeys.size,
      incompletePairs: collapsed.incomplete.length,
      tieRate: { value: ties("value"), feasibility: ties("feasibility") },
      haloCorrelation: haloCorrelation(judgeLines),
      selfPreferenceRisk: risks,
    },
    frontier: frontierSizes(paths),
    stops,
    honestExits: { total: honestTotal + stops.no_idea_clears_bar, declaredNoIdea, mechanicalNoIdea: stops.no_idea_clears_bar },
    corruptRecordLines,
  };
}

export function writeMetrics(paths: RunPaths): IdeationMetrics {
  const metrics = computeMetrics(paths);
  writeAtomic(paths.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}
