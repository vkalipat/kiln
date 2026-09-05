import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Metrics } from "../build/metrics";
import { loadConfig, PHASES, type IdeaShape, type Phase } from "../core/config";
import { survivingIdeaCount, type CostBlock } from "../core/cost";
import type { StoredEvent, StopKind } from "../core/events";
import { RunRecord } from "../core/record";
import { readStatus, runPaths, type RunStatus } from "../core/run";
import { resolveRole } from "../providers/models";
import { judgeCalibration } from "./calibrate";
import { cacheHealth, foldCostFallback, readCost, type CacheHealth, type CostSource } from "./cost";
import type { JudgeCalibrationStamp } from "./report";

/** Compile-time closed roots: persisted additions cannot silently become report columns. */
export const METRIC_ROOTS = ["costUsd", "costByPhase", "frontier", "collisionRate", "noveltyEnforced", "searchHealth", "probes", "tournament", "stops", "honestExits", "featuresPassed", "featuresBlocked", "regressionsCaught", "auditorDisagreeRate", "wallByPhase", "stopKind", "censored", "budgetOvershootUsd", "usdCapHits", "crossProviderCritic", "crossProviderAuditor", "cost"] as const satisfies readonly (keyof (Metrics & { cost: unknown }))[];
const STOP_KEYS = ["rounds", "stagnant", "stalled", "budget", "no_idea_clears_bar", "blocked", "deadline", "transient"] as const satisfies readonly StopKind[];
const BLOCK_KEYS = ["attempts_exhausted", "not_verifiable", "missing_dependency", "declared_unsatisfiable", "regression_unrepairable", "feature_budget"] as const satisfies readonly (keyof Metrics["featuresBlocked"])[];
export const METRIC_KEYS = [
  "costUsd", "frontier.raw", "frontier.shown", "collisionRate", "noveltyEnforced", "searchHealth.rate", "probes.passRate", "tournament.tieRate.value", "tournament.haloCorrelation",
  "featuresPassed.executed", "featuresPassed.humanVerified", "regressionsCaught", "auditorDisagreeRate", "stopKind", "censored", "budgetOvershootUsd", "usdCapHits", "crossProviderCritic", "crossProviderAuditor",
  "honestExits.total", "honestExits.declaredNoIdea", "honestExits.mechanicalNoIdea", "honestExits.cannot_be_satisfied.declared", "honestExits.not_formable.mechanical", "honestExits.not_formable.declared",
  ...STOP_KEYS.map((key) => `stops.${key}` as const), ...BLOCK_KEYS.map((key) => `featuresBlocked.${key}` as const),
  ...PHASES.flatMap((phase) => [`costByPhase.${phase}`, `wallByPhase.${phase}`, `cost.${phase}.usdPerSuccess`, `cost.${phase}.cacheReadRatio`] as const),
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
type MetricValue = number | boolean | string | null;
type Shape = IdeaShape | "unknown";
export const METRIC_SHAPES: readonly Shape[] = ["research", "product", "creative", "unknown"];
export interface MetricSummary { n: number; mean: number | null; median: number | null; sum?: number }
export interface RunCounts {
  total: number; done: number; stopped: Record<string, number>; failed: Record<string, number>;
  paused: number; running: number; honestExits: Record<string, number>;
}
export interface MetricsRow {
  runId: string; shape: Shape; state: RunStatus["state"]; createdAt: string; seedId?: string;
  evalId?: string; arm?: string;
  values: Record<MetricKey, MetricValue>;
  costSource: Record<Phase, CostSource>;
  cacheHealth: Record<Phase, CacheHealth>;
  pairCensored?: boolean | null;
  pairCensoredBy?: StopKind[];
  pairCensoring?: Array<{ arm: string; pairCensored: boolean; pairCensoredBy: StopKind[] }>;
}
export interface MetricsBucket { runs: RunCounts; metrics: Record<MetricKey, { done: MetricSummary; all: MetricSummary }> }
export interface MetricsReport {
  version: 1; judgeCalibration: JudgeCalibrationStamp; runs: RunCounts;
  buckets: Record<Shape, MetricsBucket>; rows: MetricsRow[]; skipped: string[];
}

function objectFile(path: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(readFileSync(path, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
  catch { return undefined; }
}
function dirs(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return []; }
}
function at(value: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((held, part) => held && typeof held === "object" ? (held as Record<string, unknown>)[part] : undefined, value);
}
function scalar(value: unknown): MetricValue {
  return typeof value === "number" ? (Number.isFinite(value) ? value : null) : typeof value === "boolean" || typeof value === "string" ? value : null;
}
function successes(phase: Phase, metrics: unknown, events: StoredEvent[]): number {
  if (phase === "ideate") return survivingIdeaCount(events);
  if (phase === "form") return events.filter((event) => event.t === "freeze").length;
  if (phase === "reflect") return events.filter((event) => event.t === "delta" && event.accepted).length;
  if (phase === "build") { const count = at(metrics, "featuresPassed.executed"); return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0; }
  return events.some((event) => event.t === "phase.end" && event.phase === phase && event.outcome === "ok") ? 1 : 0;
}
function crossProvider(events: StoredEvent[], role: "critic" | "auditor"): number | null {
  let last: Extract<StoredEvent, { t: "model.call" }> | undefined;
  let observed = false; let count = 0;
  for (const event of events) {
    if (event.t === "model.call" && event.role === role) last = event;
    if ((role === "critic" && event.t === "critique") || (role === "auditor" && event.t === "audit")) {
      if (!last) continue;
      observed = true;
      if (!last.fallbackServed && event.crossProvider) count += 1;
    }
  }
  return observed ? count : null;
}
interface HeldRow { row: MetricsRow; status: RunStatus }
function row(home: string, id: string, evalId?: string, arm?: string): HeldRow | undefined {
  const paths = runPaths(home, id); const metrics = objectFile(paths.metrics);
  if (!metrics) return undefined;
  let status: RunStatus;
  try { status = readStatus(paths); if (!status || status.id !== id || !Number.isFinite(Date.parse(status.createdAt)) || !["running", "paused", "stopped", "done", "failed"].includes(status.state)) return undefined; }
  catch { return undefined; }
  const events = new RunRecord(paths.record).read(); const stored = readCost(metrics);
  const cost = Object.fromEntries(PHASES.map((phase) => [phase, stored[phase] ?? foldCostFallback(events, phase, successes(phase, metrics, events))])) as Record<Phase, CostBlock>;
  const document = { ...metrics, cost, crossProviderCritic: crossProvider(events, "critic"), crossProviderAuditor: crossProvider(events, "auditor") };
  return { status, row: {
    runId: id, shape: METRIC_SHAPES.includes(status.shape as Shape) ? status.shape! : "unknown", state: status.state, createdAt: status.createdAt, seedId: status.seed?.id,
    ...(evalId ? { evalId, arm } : {}),
    values: Object.fromEntries(METRIC_KEYS.map((key) => [key, scalar(at(document, key))])) as Record<MetricKey, MetricValue>,
    costSource: Object.fromEntries(PHASES.map((phase) => [phase, stored[phase] ? "metrics" : "fallback"])) as Record<Phase, CostSource>,
    cacheHealth: Object.fromEntries(PHASES.map((phase) => [phase, cacheHealth(events, phase)])) as Record<Phase, CacheHealth>,
  } };
}
function counts(rows: HeldRow[]): RunCounts {
  const result: RunCounts = { total: rows.length, done: 0, stopped: {}, failed: {}, paused: 0, running: 0, honestExits: {} };
  const add = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };
  for (const { status } of rows) {
    if (status.outcome?.kind === "honest_exit") add(result.honestExits, status.outcome.exitKind ?? "unknown");
    if (status.state === "stopped") add(result.stopped, status.outcome?.stopKind ?? "unknown");
    else if (status.state === "failed") add(result.failed, status.outcome?.failureClass ?? "unknown");
    else if (status.state === "done") { if (status.outcome?.kind !== "honest_exit") result.done += 1; }
    else result[status.state] += 1;
  }
  return result;
}
function summary(rows: HeldRow[], key: MetricKey): MetricSummary {
  const values = rows.flatMap(({ row }) => { const value = row.values[key]; return typeof value === "number" ? [value] : typeof value === "boolean" ? [Number(value)] : []; }).sort((a, b) => a - b);
  const n = values.length; const sum = values.reduce((a, b) => a + b, 0);
  const counter = /^(stops|honestExits|featuresPassed|featuresBlocked|crossProvider)/.test(key) || ["regressionsCaught", "usdCapHits"].includes(key);
  return { n, mean: n ? sum / n : null, median: n ? (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2 : null, ...(counter ? { sum } : {}) };
}
function censor(status: RunStatus): StopKind[] {
  if (status.state === "paused") return ["deadline"];
  const kind = status.outcome?.kind === "stopped" ? status.outcome.stopKind : undefined;
  return kind && ["budget", "deadline", "transient", "stalled"].includes(kind) ? [kind] : [];
}
function pairRows(rows: HeldRow[]): void {
  for (const held of rows.filter(({ row }) => row.evalId)) {
    const { row } = held;
    // M1 has three baseline comparisons, not one four-arm pair. M2/evolution are two-arm.
    const partners = rows.filter(({ row: other }) => other.evalId === row.evalId && other.seedId && other.seedId === row.seedId && other.arm !== row.arm && (
      !["A0", "B0", "A1", "A2"].includes(row.arm ?? "") || row.arm === "A0" || other.arm === "A0"
    ));
    row.pairCensoring = partners.map((partner) => {
      const reasons = [...new Set([...censor(held.status), ...censor(partner.status)])];
      return { arm: partner.row.arm!, pairCensored: reasons.length > 0, pairCensoredBy: reasons };
    });
    row.pairCensored = partners.length ? row.pairCensoring.some((pair) => pair.pairCensored) : null;
    row.pairCensoredBy = [...new Set(row.pairCensoring.flatMap((pair) => pair.pairCensoredBy))];
  }
}
function calibration(home: string): JudgeCalibrationStamp {
  const cfg = loadConfig(home);
  if (cfg.evals.judgeGate === "removed") return { status: "removed" };
  if (!existsSync(join(home, "evals", "calibration.json"))) return { status: "absent" };
  try { return judgeCalibration(home, cfg, resolveRole("judge", cfg, new Set(cfg.roles.judge.map((ref) => ref.split("/")[0]!)))); }
  catch { return { status: "stale" }; }
}

/** Read-only aggregation: never regenerates metrics, initializes homes, resolves auth, or calls models. */
export function collectMetrics(home: string, options: { since?: string; evals?: boolean } = {}): MetricsReport {
  const rows: HeldRow[] = []; const skipped: string[] = [];
  const collect = (source: string, evalId?: string, arm?: string) => {
    for (const id of dirs(join(source, "runs"))) { const held = row(source, id, evalId, arm); if (held) rows.push(held); else skipped.push([evalId, arm, id].filter(Boolean).join("/")); }
  };
  collect(home);
  if (options.evals) for (const evalId of dirs(join(home, "evolution", "work"))) for (const arm of dirs(join(home, "evolution", "work", evalId))) collect(join(home, "evolution", "work", evalId, arm), evalId, arm);
  pairRows(rows);
  let since = Number.NEGATIVE_INFINITY;
  if (options.since) {
    const match = rows.find(({ row }) => row.runId === options.since);
    let runDate = match?.status.createdAt;
    if (!runDate && dirs(join(home, "runs")).includes(options.since)) {
      try { runDate = readStatus(runPaths(home, options.since)).createdAt; } catch { /* no readable anchor */ }
    }
    since = Date.parse(runDate ?? options.since);
    if (!Number.isFinite(since) || (!runDate && !/^\d{4}-\d{2}-\d{2}T/.test(options.since))) throw new Error("--since must be an ISO timestamp or a readable run ID");
  }
  const selected = rows.filter(({ status }) => Date.parse(status.createdAt) >= since).sort((a, b) => a.status.createdAt.localeCompare(b.status.createdAt) || a.row.runId.localeCompare(b.row.runId));
  const buckets = Object.fromEntries(METRIC_SHAPES.map((shape) => {
    const all = selected.filter(({ row }) => row.shape === shape); const done = all.filter(({ status }) => status.state === "done" && status.outcome?.kind !== "honest_exit");
    return [shape, { runs: counts(all), metrics: Object.fromEntries(METRIC_KEYS.map((key) => [key, { done: summary(done, key), all: summary(all, key) }])) }];
  })) as Record<Shape, MetricsBucket>;
  return { version: 1, judgeCalibration: calibration(home), runs: counts(selected), buckets, rows: selected.map(({ row }) => row), skipped };
}
