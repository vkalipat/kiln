import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { GitRunner } from "../build/git";
import type { Effort, KilnConfig, Role } from "../core/config";
import { writeAtomic } from "../core/paths";
import { hashInput } from "../core/record";
import { clampEffort, type EffortName } from "../providers/models";
import { verifyEvalsManifest } from "./manifest";
import { selectSweepWinner, wilson } from "./wilson";

export const EFFORT_GRID_ROLES = ["judge", "generator", "brain", "builder", "auditor"] as const satisfies readonly Role[];
export const NOT_SWEPT_ROLES = ["critic", "scout", "prober", "arbiter", "reflector"] as const satisfies readonly Role[];
export type EffortSweepTarget = Role | "generator+brain";
export type EffortMetric = "agreement" | "pairWinRate" | "featuresPassed.executed" | "featuresPassed.executed+auditorDisagreeRate";

export interface EffortEntry {
  winner: EffortName;
  sweptLevels: EffortName[];
  metric: EffortMetric;
  quality: number;
  usdPerSuccess: number | null;
  n: number;
  rounds?: number;
  at: string;
  evalId: string;
}
export interface EffortFile { version: 1; entries: Record<string, EffortEntry> }
export interface EffortProfile {
  name: string;
  /** An arm-local override, such as M1's Fable-at-low cell. */
  effort?: Partial<Record<Role, EffortName>>;
}
export interface EffortResolution { level: EffortName | undefined; source: "profile" | "swept" | "config" | "global" }
export interface EffortSeat { model: Model; ref: string }

export function effortPath(home: string): string { return join(home, "evals", "effort.json"); }
export function effortKey(role: Role, modelRef: string, profile: string): string {
  if ([role, modelRef, profile].some((part) => part.includes("|"))) throw new Error("effort key parts may not contain '|'");
  return `${role}|${modelRef}|${profile}`;
}

function validEntry(value: unknown): value is EffortEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<EffortEntry>;
  return typeof entry.winner === "string" && Array.isArray(entry.sweptLevels) && entry.sweptLevels.every((level) => typeof level === "string")
    && typeof entry.metric === "string" && typeof entry.quality === "number" && Number.isFinite(entry.quality)
    && (entry.usdPerSuccess === null || (typeof entry.usdPerSuccess === "number" && Number.isFinite(entry.usdPerSuccess) && entry.usdPerSuccess >= 0))
    && Number.isSafeInteger(entry.n) && entry.n! >= 0 && typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at))
    && typeof entry.evalId === "string" && entry.evalId.length > 0;
}

/** Missing files are the unswept initial state; malformed files are integrity failures. */
export function readEffortFile(home: string): EffortFile {
  const path = effortPath(home);
  if (!existsSync(path)) return { version: 1, entries: {} };
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new EffortSweepError("integrity", `cannot parse evals/effort.json: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1) {
    throw new EffortSweepError("integrity", "evals/effort.json must be { version: 1, entries: {...} }");
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new EffortSweepError("integrity", "effort entries must be an object");
  for (const [key, entry] of Object.entries(entries)) if (!validEntry(entry)) throw new EffortSweepError("integrity", `invalid effort entry ${key}`);
  return { version: 1, entries: entries as Record<string, EffortEntry> };
}

export function writeEffortFile(home: string, file: EffortFile): void {
  if (file.version !== 1 || Object.values(file.entries).some((entry) => !validEntry(entry))) throw new EffortSweepError("integrity", "cannot write invalid effort.json");
  writeAtomic(effortPath(home), `${JSON.stringify(file, null, 2)}\n`);
}

function seat(value: Model | EffortSeat): EffortSeat {
  const possible = value as Partial<EffortSeat>;
  return typeof possible.ref === "string" && possible.model !== null && typeof possible.model === "object"
    ? possible as EffortSeat
    : { model: value as Model, ref: `${String((value as Model).provider)}/${(value as Model).id}` };
}
function profileValue(value: string | EffortProfile): EffortProfile { return typeof value === "string" ? { name: value } : value; }
function requested(cfg: KilnConfig, role: Role, file: EffortFile, model: EffortSeat, profile: EffortProfile): { level: string; source: EffortResolution["source"] } {
  const override = profile.effort?.[role]; if (override) return { level: override, source: "profile" };
  const measured = file.entries[effortKey(role, model.ref, profile.name)]; if (measured) return { level: measured.winner, source: "swept" };
  const configured = cfg.effortByRole?.[role]; if (configured) return { level: configured, source: "config" };
  return { level: cfg.effort, source: "global" };
}

/** Exact-key lookup makes both a changed ref and a changed seating profile expire the measurement. */
export function resolveEffort(
  cfg: KilnConfig, role: Role, modelValue: Model | EffortSeat, effortJson: EffortFile, profileValueOrName: string | EffortProfile = "default",
): EffortResolution {
  const model = seat(modelValue); const profile = profileValue(profileValueOrName); const choice = requested(cfg, role, effortJson, model, profile);
  return { level: clampEffort(model.model, choice.level), source: choice.source };
}

export function effortEntryStatus(file: EffortFile, role: Role, modelRef: string, profile: string): "current" | "expired" | "missing" {
  if (file.entries[effortKey(role, modelRef, profile)]) return "current";
  return Object.keys(file.entries).some((key) => key.startsWith(`${role}|`)) ? "expired" : "missing";
}

export function effortsSwept(
  roles: readonly Role[], seats: Partial<Record<Role, EffortSeat>>, file: EffortFile, profile: string,
): boolean {
  return roles.filter((role) => EFFORT_GRID_ROLES.includes(role as typeof EFFORT_GRID_ROLES[number]))
    .every((role) => seats[role] !== undefined && effortEntryStatus(file, role, seats[role]!.ref, profile) === "current");
}

const ORDER: readonly EffortName[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export function supportedEffortLevels(model: Model, requestedLevels: readonly EffortName[] = ["low", "medium", "high", "xhigh"]): EffortName[] {
  const supported = new Set((model.thinking?.efforts ?? []) as readonly EffortName[]);
  return ORDER.filter((level) => requestedLevels.includes(level) && supported.has(level));
}

export interface EffortSweepCell {
  id: string;
  level: EffortName;
  kind: "level" | "aa";
  wins: number;
  n: number;
  quality: number;
  lower: number;
  upper: number;
  usdPerSuccess: number | null;
  costUsd: number;
  admissible: boolean;
  qualityWin: boolean;
}
export interface EffortWinner {
  verdict: "ok" | "judging_biased";
  winner: EffortName;
  reason: "quality_win" | "cheapest_admissible" | "incumbent" | "judging_biased";
}

/** Pure policy: validate A/A first, then apply quality-before-cost non-inferiority. */
export function chooseEffortWinner(cells: readonly EffortSweepCell[], incumbent: EffortName, margin = 0.1): EffortWinner {
  const aa = cells.filter((cell) => cell.kind === "aa");
  if (aa.length > 1) throw new Error("sweep may contain at most one A/A cell");
  if (aa[0] && !(aa[0].lower <= 0.5 && aa[0].upper >= 0.5)) return { verdict: "judging_biased", winner: incumbent, reason: "judging_biased" };
  const levels = cells.filter((cell) => cell.kind === "level");
  const incumbents = levels.filter((cell) => cell.level === incumbent);
  if (incumbents.length !== 1) throw new Error("sweep must contain exactly one incumbent effort level");
  const selected = selectSweepWinner(levels.map((cell) => ({ level: cell.level, lower: cell.lower, usdPerSuccess: cell.usdPerSuccess, incumbent: cell.level === incumbent })), margin);
  return { verdict: "ok", ...selected };
}

export interface EffortCellRequest {
  id: string; target: EffortSweepTarget; roles: Role[]; profile: string; level: EffortName; kind: "level" | "aa"; rounds: number; evalId: string;
}
export interface EffortCellMeasurement { wins: number; n: number; quality?: number; usdPerSuccess: number | null; costUsd?: number }
export type EffortSweepHandler = (request: EffortCellRequest) => Promise<EffortCellMeasurement>;
export type EffortSweepProjector = (request: EffortCellRequest) => number;
export interface RunEffortSweepOptions {
  budgetUsd: number; levels?: EffortName[]; profile?: string; rounds?: number; evalId?: string; projectedUsd?: number; write?: boolean; now?: () => Date;
}
export interface RunEffortSweepDeps { models: (role: Role) => EffortSeat; handler: EffortSweepHandler; git: GitRunner; project?: EffortSweepProjector }
export interface EffortSweepReport {
  version: 1; target: EffortSweepTarget; roles: Role[]; modelRefs: Record<string, string>; profile: string; metric: EffortMetric;
  levels: EffortName[]; incumbent: EffortName; projectedUsd: number; cellCeilingsUsd: Record<string, number>; budgetUsd: number; spentUsd: number; cells: EffortSweepCell[];
  verdict: "ok" | "judging_biased" | "not_swept" | "incomplete"; stoppedReason?: "budget"; winner?: EffortName; reason?: EffortWinner["reason"]; entry?: EffortEntry; commit?: string;
}

export class EffortSweepError extends Error {
  constructor(readonly reason: "integrity" | "usage" | "budget", message: string) { super(message); this.name = "EffortSweepError"; }
}

function statusPaths(status: string): Set<string> {
  const records = status.includes("\0") ? status.split("\0") : status.split("\n");
  return new Set(records.filter(Boolean).map((record) => record.length > 3 ? record.slice(3) : record));
}
async function dirtyOwnedPaths(home: string, git: GitRunner, paths: readonly string[]): Promise<boolean> {
  const status = git.statusPorcelainZ ? await git.statusPorcelainZ(home) : await git.statusPorcelain(home);
  const dirty = statusPaths(status); return paths.some((path) => dirty.has(path));
}
async function commitEffortOperation(home: string, git: GitRunner, operationId: string, message: string): Promise<string | undefined> {
  const paths = ["evals/effort.json"];
  if (await git.hasTrailer(home, "Kiln-Operation", operationId)) {
    if (await dirtyOwnedPaths(home, git, paths)) throw new EffortSweepError("integrity", `completed operation ${operationId} has uncommitted effort output`);
    return undefined;
  }
  const commit = await git.commit(home, { message, allowEmpty: true,
    trailers: { "Kiln-Evals-Write": "evals/effort.json", "Kiln-Operation": operationId }, paths });
  if (!await git.hasTrailer(home, "Kiln-Operation", operationId) || await dirtyOwnedPaths(home, git, paths)) {
    throw new EffortSweepError("integrity", `operation ${operationId} did not commit its exact effort output`);
  }
  return commit;
}

const FULL_PROJECTION: Partial<Record<EffortSweepTarget, number>> = { judge: 24.2, generator: 328.6, brain: 328.6, "generator+brain": 328.6, builder: 220, auditor: 209 };
export function projectedSweepBudget(target: EffortSweepTarget, levels: number, cellProjection?: readonly number[]): number {
  if (!Number.isSafeInteger(levels) || levels < 1) throw new EffortSweepError("usage", "a sweep needs at least one level");
  if (cellProjection) {
    if (cellProjection.some((cost) => !Number.isFinite(cost) || cost < 0)) throw new EffortSweepError("usage", "cell projections must be non-negative finite dollars");
    return cellProjection.reduce((sum, cost) => sum + cost, 0);
  }
  const full = FULL_PROJECTION[target];
  if (full === undefined) return 0;
  const fullCells = target === "generator+brain" || target === "generator" || target === "brain" ? 5 : 4;
  const cells = levels + (fullCells === 5 ? 1 : 0);
  return full * cells / fullCells;
}

function targetRoles(target: EffortSweepTarget): Role[] { return target === "generator+brain" ? ["generator", "brain"] : [target]; }
function metricFor(target: EffortSweepTarget): EffortMetric {
  if (target === "judge") return "agreement";
  if (target === "builder") return "featuresPassed.executed";
  if (target === "auditor") return "featuresPassed.executed+auditorDisagreeRate";
  return "pairWinRate";
}
function normalizeCell(request: EffortCellRequest, value: EffortCellMeasurement, cfg: KilnConfig): EffortSweepCell {
  if (!Number.isSafeInteger(value.n) || value.n < 1 || !Number.isFinite(value.wins) || value.wins < 0 || value.wins > value.n) throw new EffortSweepError("usage", `invalid measurement for ${request.id}`);
  if (value.usdPerSuccess !== null && (!Number.isFinite(value.usdPerSuccess) || value.usdPerSuccess < 0)) throw new EffortSweepError("usage", `invalid usdPerSuccess for ${request.id}`);
  const interval = wilson(value.wins, value.n, cfg.evals.level); const quality = value.quality ?? value.wins / value.n;
  return { ...request, wins: value.wins, n: value.n, quality, ...interval, usdPerSuccess: value.usdPerSuccess, costUsd: value.costUsd ?? 0,
    admissible: interval.lower >= 0.5 - cfg.evals.noninferiorityMargin, qualityWin: interval.lower > 0.5 };
}

export function effortSweepReportPath(home: string, evalId: string): string {
  return join(home, "evolution", "reports", evalId, "effort.json");
}
function readSweepReport(path: string): EffortSweepReport | undefined {
  if (!existsSync(path)) return undefined;
  try { const value = JSON.parse(readFileSync(path, "utf8")) as EffortSweepReport; return value?.version === 1 && Array.isArray(value.cells) ? value : undefined; }
  catch { throw new EffortSweepError("integrity", `cannot parse ${path}`); }
}
function writeSweepReport(path: string, report: EffortSweepReport, enabled: boolean): void {
  if (enabled) writeAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** Programmatic command handler. All paid work is behind the injected cell handler. */
export async function runEffortSweep(home: string, cfg: KilnConfig, target: EffortSweepTarget, options: RunEffortSweepOptions, deps: RunEffortSweepDeps): Promise<EffortSweepReport> {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new EffortSweepError("usage", "--budget must be a positive dollar amount");
  const manifest = verifyEvalsManifest(home); if (!manifest.ok) throw new EffortSweepError("integrity", `eval manifest mismatch: ${[...manifest.changed, ...manifest.missing, ...manifest.extra].join(", ")}`);
  const roles = targetRoles(target); const grid = roles.every((role) => EFFORT_GRID_ROLES.includes(role as typeof EFFORT_GRID_ROLES[number]));
  const profile = options.profile ?? "default"; const modelRefs = Object.fromEntries(roles.map((role) => [role, deps.models(role).ref]));
  const base: EffortSweepReport = { version: 1, target, roles, modelRefs, profile, metric: metricFor(target), levels: [], incumbent: cfg.effort,
    projectedUsd: 0, cellCeilingsUsd: {}, budgetUsd: options.budgetUsd, spentUsd: 0, cells: [], verdict: grid ? "ok" : "not_swept" };
  if (!grid) return base;
  const primary = deps.models(roles.at(-1)!); const available = supportedEffortLevels(primary.model, options.levels);
  const levels = roles.slice(0, -1).reduce((held, role) => {
    const supported = new Set(supportedEffortLevels(deps.models(role).model, options.levels)); return held.filter((level) => supported.has(level));
  }, available);
  if (levels.length === 0) throw new EffortSweepError("usage", "the seated model supports none of the requested effort levels");
  const configured = clampEffort(primary.model, cfg.effortByRole?.[roles.at(-1)!] ?? cfg.effort);
  const incumbent = configured && levels.includes(configured) ? configured : levels[0]!;
  const rounds = options.rounds ?? 1; const evalId = options.evalId ?? `effort-${target.replace("+", "-")}-${profile}`;
  const requests: EffortCellRequest[] = levels.map((level) => ({ id: `${target}-${level}`, target, roles, profile, level, kind: "level", rounds, evalId }));
  if (target === "generator+brain" || target === "generator" || target === "brain") requests.push({ id: `${target}-incumbent-aa`, target, roles, profile, level: incumbent, kind: "aa", rounds, evalId });
  const projected = deps.project ? requests.map((request) => deps.project!(request)) : undefined;
  const projectedUsd = options.projectedUsd ?? projectedSweepBudget(target, levels.length, projected);
  if (!Number.isFinite(projectedUsd) || projectedUsd < 0) throw new EffortSweepError("usage", "projected sweep cost must be a non-negative finite amount");
  const ceilings = projected ?? requests.map(() => requests.length === 0 ? 0 : projectedUsd / requests.length);
  if (ceilings.some((value) => !Number.isFinite(value) || value < 0)) throw new EffortSweepError("usage", "cell projections must be non-negative finite dollars");
  if (options.budgetUsd < ceilings[0]!) throw new EffortSweepError("budget", `budget $${options.budgetUsd.toFixed(2)} is below one-cell sweep floor $${ceilings[0]!.toFixed(2)}`);
  const cellCeilingsUsd = Object.fromEntries(requests.map((request, index) => [request.id, ceilings[index]!])) as Record<string, number>;
  const path = effortSweepReportPath(home, evalId); const persist = options.write !== false;
  let report = readSweepReport(path);
  if (report) {
    const same = report.target === target && report.profile === profile && JSON.stringify(report.modelRefs) === JSON.stringify(modelRefs)
      && JSON.stringify(report.levels) === JSON.stringify(levels) && report.incumbent === incumbent && JSON.stringify(report.cellCeilingsUsd) === JSON.stringify(cellCeilingsUsd);
    if (!same) throw new EffortSweepError("integrity", "effort sweep inputs differ from the durable report");
    report.budgetUsd = options.budgetUsd;
    if (report.verdict === "judging_biased") return report;
  } else {
    report = { ...base, levels, incumbent, projectedUsd, cellCeilingsUsd, verdict: "incomplete" };
  }
  delete report.stoppedReason;
  writeSweepReport(path, report, persist);
  for (const [index, request] of requests.entries()) {
    if (report.cells.some((cell) => cell.id === request.id)) continue;
    report.spentUsd = report.cells.reduce((sum, cell) => sum + cell.costUsd, 0);
    if (options.budgetUsd - report.spentUsd < ceilings[index]!) {
      report.verdict = "incomplete"; report.stoppedReason = "budget"; writeSweepReport(path, report, persist); return report;
    }
    report.cells.push(normalizeCell(request, await deps.handler(request), cfg));
    report.spentUsd = report.cells.reduce((sum, cell) => sum + cell.costUsd, 0);
    writeSweepReport(path, report, persist);
  }
  const selected = chooseEffortWinner(report.cells, incumbent, cfg.evals.noninferiorityMargin);
  report.verdict = selected.verdict; report.winner = selected.winner; report.reason = selected.reason;
  if (selected.verdict === "judging_biased" || options.write === false) { writeSweepReport(path, report, persist); return report; }
  const winnerCell = report.cells.find((cell) => cell.kind === "level" && cell.level === selected.winner)!;
  const intended = report.entry;
  const entry: EffortEntry = intended ?? { winner: selected.winner, sweptLevels: levels, metric: metricFor(target), quality: winnerCell.quality,
    usdPerSuccess: winnerCell.usdPerSuccess, n: winnerCell.n, rounds, at: (options.now ?? (() => new Date()))().toISOString(), evalId };
  const expectedEntry = { ...entry, winner: selected.winner, sweptLevels: levels, metric: metricFor(target), quality: winnerCell.quality,
    usdPerSuccess: winnerCell.usdPerSuccess, n: winnerCell.n, rounds, evalId };
  if (intended && JSON.stringify(intended) !== JSON.stringify(expectedEntry)) {
    throw new EffortSweepError("integrity", "durable effort entry differs from its completed cells");
  }
  // This report is the durable commit intent. Record it before changing the authoritative lookup.
  report.entry = entry; writeSweepReport(path, report, persist);
  const file = readEffortFile(home);
  for (const role of roles) {
    const key = effortKey(role, deps.models(role).ref, profile); const held = file.entries[key];
    if (intended && held && JSON.stringify(held) !== JSON.stringify(entry)) {
      throw new EffortSweepError("integrity", `effort entry ${key} changed while its commit was pending`);
    }
    file.entries[key] = { ...entry };
  }
  writeEffortFile(home, file);
  const operationId = `eval-effort-${hashInput({ evalId, target, roles, modelRefs, profile, levels, cellCeilingsUsd }).slice(0, 24)}`;
  const commit = await commitEffortOperation(home, deps.git, operationId, `evals(effort): ${target} ${selected.winner}`);
  return { ...report, commit };
}

export const loadEffort = readEffortFile;
export const writeEffort = writeEffortFile;
