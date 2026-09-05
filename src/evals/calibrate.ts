import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { GitRunner } from "../build/git";
import { loadPrompt } from "../brain/prompts";
import { saveConfig, type IdeaShape, type KilnConfig, type Role } from "../core/config";
import { appendLine, ensureDir, writeAtomic } from "../core/paths";
import { hashInput, RunRecord } from "../core/record";
import { readStatus, runPaths } from "../core/run";
import { collapsePairs } from "../ideation/bt";
import { RENDER_VERSION } from "../ideation/dossier";
import { judgePair, type Criteria, type JudgeDeps } from "../ideation/judge";
import { bwsGroups } from "../phases/checkpoint";
import type { FrontierFile } from "../phases/ideate";
import { effortFor } from "../providers/models";
import type { TournamentRecord } from "../ideation/tournament";
import { selfPreferenceRisk } from "../ideation/tournament";
import { verifyEvalsManifest } from "./manifest";
import type { JudgeCalibrationHash, JudgeCalibrationStamp } from "./report";
import { sha256Bytes } from "./seeds";
import { labelBestWorst, type LabellerDeps, type LabellerItem } from "./labeller";

export type CalibrationLabelSource = "human" | "agent";
export interface CalibrationGroup {
  id: string;
  /** Real home or staged M1 arm that owns the immutable source run. */
  sourceHome: string;
  runId: string;
  round: number;
  shape: IdeaShape;
  frontierMode: "loop" | "bare";
  criteria: Criteria;
  items: readonly LabellerItem[];
  renderHashes: Record<string, string>;
  generationModels: Record<string, string>;
}
export interface CalibrationSlice { groups: number; pairs: number; agreement: number; orderAgreement: number }
export interface CalibrationStratum { pairs: number; agreement: number }
export interface CalibrationFile {
  version: 1;
  labelSource: CalibrationLabelSource;
  computedAt: string;
  hash: JudgeCalibrationHash;
  effort: JudgeCalibrationHash["effort"];
  groups: number;
  impliedPairs: number;
  refusedGroups: number;
  agreement: number;
  orderAgreement: number;
  feasibilityOrderAgreement: number;
  calibrated: boolean;
  provisional: boolean;
  byShape: Record<IdeaShape, CalibrationSlice>;
  strata: Record<"none" | "a" | "b" | "both", CalibrationStratum>;
  costUsd: number;
}
export interface CalibrationIo { ask(prompt: string): Promise<string> }
export interface CalibrateOptions { labels: CalibrationLabelSource; groups?: number; budgetUsd?: number; now?: () => Date }
export interface CalibrateDeps extends Omit<LabellerDeps, "home" | "cfg" | "record"> {
  cfg: KilnConfig;
  git: GitRunner;
  io?: CalibrationIo;
  streamFn?: StreamFn;
  judgePair?: typeof judgePair;
}
export interface CalibrateResult extends CalibrationFile { id: string; path: string; replayPath: string; commit?: string; gateCommit?: string }

export class CalibrationError extends Error {
  constructor(readonly reason: "integrity" | "insufficient_material" | "usage" | "budget", message: string) {
    super(message); this.name = "CalibrationError";
  }
}

/** M0's priced 20-group projection is $6.50, so one complete group owns this dispatch floor. */
export const CALIBRATION_GROUP_FLOOR_USD = 0.325;

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function criteriaFor(runId: string, home: string, round: number, shape: IdeaShape): Criteria | undefined {
  const dir = runPaths(home, runId).criteriaDir;
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).filter((file) => file.startsWith(`r${round}-`) && file.endsWith(".md") && !file.endsWith("-meta.md")).sort()[0];
  return name ? { id: name.slice(0, -3), text: readFileSync(join(dir, name), "utf8").trim(), round, shape } : undefined;
}

function generationModels(home: string, runId: string, ids: readonly string[]): Record<string, string> {
  const events = new RunRecord(runPaths(home, runId).record).read();
  const assigned = new Map<string, string>(events.flatMap((event) => event.t === "island.assign" ? [[`${event.round}|${event.island}`, event.model] as [string, string]] : []));
  return Object.fromEntries(ids.map((id) => {
    const match = /^r(\d+)-i(\d+)-/.exec(id);
    return [id, match ? assigned.get(`${match[1]}|${match[2]}`) ?? "unknown" : "unknown"];
  }));
}

function sourceGroups(sourceHome: string, namespace: string, runId: string): CalibrationGroup[][] {
  const paths = runPaths(sourceHome, runId);
  const status = json<ReturnType<typeof readStatus>>(paths.status);
  if (!status?.shape) return [];
  const shape = status.shape;
  const frontier = json<FrontierFile>(paths.frontier);
  const events = new RunRecord(paths.record).read();
  const sourceMap = new Map(events.flatMap((event) => event.t === "checkpoint.shown"
    ? [[`${event.round}\0${event.ideas.join("\0")}`, { round: event.round, shown: event.ideas, mode: frontier?.round === event.round ? frontier.mode : "loop" as const }] as const]
    : []));
  const sources = [...sourceMap.values()];
  if (frontier && !sources.some((source) => source.round === frontier.round)) {
    sources.push({ round: frontier.round, shown: frontier.shown, mode: frontier.mode });
  }
  return sources.sort((a, b) => a.round - b.round).flatMap((source) => {
    if (source.shown.length < 4) return [];
    const criteria = criteriaFor(runId, sourceHome, source.round, shape);
    if (!criteria) return [];
    const cells = frontier?.round === source.round
      ? Object.fromEntries(frontier.ideas.map((idea) => [idea.id, idea.cell]))
      : {};
    const candidates = bwsGroups(source.shown, cells);
    const groups: CalibrationGroup[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const ids = candidates[index]!;
      const items: LabellerItem[] = [];
      const renderHashes: Record<string, string> = {};
      for (const id of ids) {
        const path = join(paths.renderedDir, `${id}-r${source.round}.md`);
        if (!existsSync(path)) break;
        const render = readFileSync(path, "utf8");
        items.push({ id, render }); renderHashes[id] = sha256Bytes(render);
      }
      if (items.length !== 4) continue;
      const id = `${namespace}-${runId}-r${source.round}-g${index + 1}-${hashInput(ids).slice(0, 10)}`;
      groups.push({ id, sourceHome, runId, round: source.round, shape, frontierMode: source.mode, criteria,
        items, renderHashes, generationModels: generationModels(sourceHome, runId, ids) });
    }
    return [groups];
  });
}

/** Deterministic breadth-first draw: one group per run/round before taking a second. */
export function discoverCalibrationGroups(home: string): CalibrationGroup[] {
  const homes = [{ home, namespace: "home" }];
  const work = join(home, "evolution", "work");
  if (existsSync(work)) for (const evalId of readdirSync(work).sort()) {
    const evalDir = join(work, evalId); if (!existsSync(evalDir)) continue;
    for (const arm of readdirSync(evalDir).sort()) {
      const staged = join(evalDir, arm);
      if (existsSync(join(staged, "runs"))) homes.push({ home: staged, namespace: `${evalId}-${arm}` });
    }
  }
  const sources = homes.flatMap((source) => {
    const root = join(source.home, "runs");
    return existsSync(root) ? readdirSync(root).sort().flatMap((runId) => sourceGroups(source.home, source.namespace, runId)) : [];
  });
  const out: CalibrationGroup[] = [];
  for (let depth = 0; sources.some((groups) => depth < groups.length); depth += 1) {
    for (const groups of sources) if (groups[depth]) out.push(groups[depth]!);
  }
  return out;
}

/** Five BWS preferences: best over all three, both middles over worst, no middle-middle pair. */
export function impliedPreferences(group: readonly string[], best: string, worst: string): Array<{ winner: string; loser: string }> {
  if (group.length !== 4 || new Set(group).size !== 4 || best === worst || !group.includes(best) || !group.includes(worst)) {
    throw new CalibrationError("usage", "best and worst must be different members of a four-item group");
  }
  return [
    ...group.filter((id) => id !== best).map((loser) => ({ winner: best, loser })),
    ...group.filter((id) => id !== best && id !== worst).map((winner) => ({ winner, loser: worst })),
  ];
}

export function parseHumanBws(answer: string, group: readonly string[]): { best: string; worst: string } | undefined {
  const explicit = /\bbest\s+([^\s,;]+).*\bworst\s+([^\s,;]+)/i.exec(answer);
  const words = answer.trim().split(/\s+/);
  const best = explicit?.[1] ?? words[0]; const worst = explicit?.[2] ?? words[1];
  return best && worst && best !== worst && group.includes(best) && group.includes(worst) ? { best, worst } : undefined;
}

export function calibrationHash(home: string, cfg: KilnConfig, judge: { model: Model; ref: string }): JudgeCalibrationHash {
  return {
    judgePrompt: sha256Bytes(loadPrompt(home, "judge")), kernelPrompt: sha256Bytes(loadPrompt(home, "kernel")),
    judgeModel: judge.ref, renderVersion: RENDER_VERSION,
    effort: (effortFor(cfg, "judge", judge.model) ?? cfg.effortByRole?.judge ?? cfg.effort) as JudgeCalibrationHash["effort"],
  };
}

interface CalibrationLine extends TournamentRecord {
  calibrationGroupId: string; sourceRunId: string; frontierMode: "loop" | "bare";
  shape: IdeaShape;
  labelWinner: string; labelBest: string; labelWorst: string; labellerModel: string;
  labellerCrossProvider: boolean; labelCostUsd: number; fallbackUnknown: boolean;
}
function readLines(path: string): CalibrationLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as CalibrationLine] : []; } catch { return []; } });
}
function statusPaths(status: string): Set<string> {
  const records = status.includes("\0") ? status.split("\0") : status.split("\n");
  return new Set(records.filter(Boolean).map((record) => record.length > 3 ? record.slice(3) : record));
}
async function dirtyOwnedPaths(home: string, git: GitRunner, paths: readonly string[]): Promise<boolean> {
  const status = git.statusPorcelainZ ? await git.statusPorcelainZ(home) : await git.statusPorcelain(home);
  const dirty = statusPaths(status); return paths.some((path) => dirty.has(path));
}
async function commitCalibrationOperation(
  home: string, git: GitRunner, operationId: string, message: string, paths: readonly string[], writePath: string,
): Promise<string | undefined> {
  if (await git.hasTrailer(home, "Kiln-Operation", operationId)) {
    if (await dirtyOwnedPaths(home, git, paths)) throw new CalibrationError("integrity", `completed operation ${operationId} has uncommitted eval output`);
    return undefined;
  }
  const commit = await git.commit(home, { message, allowEmpty: true,
    trailers: { "Kiln-Evals-Write": writePath, "Kiln-Operation": operationId }, paths });
  if (!await git.hasTrailer(home, "Kiln-Operation", operationId) || await dirtyOwnedPaths(home, git, paths)) {
    throw new CalibrationError("integrity", `operation ${operationId} did not commit its exact eval output`);
  }
  return commit;
}
function pairKey(a: string, b: string, order: string): string { return `${a}\0${b}\0${order}`; }
// Group identity is part of the tournament id. BWS groups intentionally overlap; each group is a
// separate elicitation while `(a,b,order)` remains the complete resume key.
function namespaced(group: CalibrationGroup, id: string): string { return `${group.id}/${id}`; }

async function humanLabel(home: string, io: CalibrationIo, group: CalibrationGroup): Promise<{ best?: string; worst?: string; costUsd: number; model: string; crossProvider: boolean }> {
  const rubric = readFileSync(join(home, "evals", "judge-rubric.md"), "utf8");
  const shapeBlock = loadPrompt(home, "judge").split(/^## Value\s*$/m)[1]?.split(/^### /m).slice(1)
    .find((block) => block.split("\n")[0]?.trim().toLowerCase() === group.shape);
  const prompt = [rubric.trim(), "", `## Value\n\n### ${shapeBlock?.trimEnd() ?? group.shape}`, "", `Calibration group ${group.id}:`,
    ...group.items.flatMap((item) => ["", `## ${item.id}`, item.render.trim()]), "", `Enter best <id> worst <id>: `].join("\n");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseHumanBws(await io.ask(prompt), group.items.map((item) => item.id));
    if (parsed) return { ...parsed, costUsd: 0, model: "human", crossProvider: false };
  }
  return { costUsd: 0, model: "human", crossProvider: false };
}

function zeroSlices(): Record<IdeaShape, CalibrationSlice> {
  return { research: { groups: 0, pairs: 0, agreement: 0, orderAgreement: 0 }, product: { groups: 0, pairs: 0, agreement: 0, orderAgreement: 0 }, creative: { groups: 0, pairs: 0, agreement: 0, orderAgreement: 0 } };
}
function completeGroupIds(lines: readonly CalibrationLine[]): Set<string> {
  const keys = new Map<string, Set<string>>();
  for (const line of lines) {
    const held = keys.get(line.calibrationGroupId) ?? new Set<string>();
    held.add(pairKey(line.a, line.b, line.order)); keys.set(line.calibrationGroupId, held);
  }
  return new Set([...keys].filter(([, held]) => held.size === 10).map(([id]) => id));
}
function stats(lines: CalibrationLine[], refusedGroups: number, labelSource: CalibrationLabelSource, hash: JudgeCalibrationHash, computedAt: string, costUsd: number): CalibrationFile {
  const complete = completeGroupIds(lines); lines = lines.filter((line) => complete.has(line.calibrationGroupId));
  const collapsed = collapsePairs(lines);
  const values = collapsed.value.map((pair) => {
    const line = lines.find((held) => held.a === pair.a && held.b === pair.b)!;
    return { pair, line, agreement: line.labelWinner === pair.a ? pair.score : 1 - pair.score };
  }).filter((item) => item.line);
  const order = (axis: "valueWinner" | "feasibilityWinner", subset = lines) => {
    const slots = new Map<string, Partial<Record<"ab" | "ba", CalibrationLine>>>();
    for (const line of subset) { const key = `${line.round}\0${line.a}\0${line.b}`; const slot = slots.get(key) ?? {}; slot[line.order] = line; slots.set(key, slot); }
    const complete = [...slots.values()].filter((slot) => slot.ab && slot.ba);
    return complete.length === 0 ? 0 : complete.filter((slot) => slot.ab![axis] === slot.ba![axis]).length / complete.length;
  };
  const mean = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const byShape = zeroSlices();
  for (const shape of Object.keys(byShape) as IdeaShape[]) {
    const groupIds = new Set(lines.filter((line) => line.shape === shape).map((line) => line.calibrationGroupId));
    const shaped = values.filter((item) => groupIds.has(item.line.calibrationGroupId));
    byShape[shape] = { groups: groupIds.size, pairs: shaped.length, agreement: mean(shaped.map((item) => item.agreement)), orderAgreement: order("valueWinner", lines.filter((line) => groupIds.has(line.calibrationGroupId))) };
  }
  const strata = Object.fromEntries((["none", "a", "b", "both"] as const).map((stratum) => {
    const held = values.filter((item) => selfPreferenceRisk(item.line) === stratum);
    return [stratum, { pairs: held.length, agreement: mean(held.map((item) => item.agreement)) }];
  })) as CalibrationFile["strata"];
  const groups = new Set(lines.map((line) => line.calibrationGroupId)).size;
  const agreement = mean(values.map((item) => item.agreement)); const orderAgreement = order("valueWinner");
  const provisional = groups < 20;
  return { version: 1, labelSource, computedAt, hash, effort: hash.effort, groups, impliedPairs: values.length, refusedGroups,
    agreement, orderAgreement, feasibilityOrderAgreement: order("feasibilityWinner"), calibrated: labelSource === "human" && !provisional && agreement >= 0.70 && orderAgreement >= 0.80,
    provisional, byShape, strata, costUsd };
}

/** Run or resume M0 replay without ever appending to a source run's tournament truth. */
export async function calibrate(home: string, options: CalibrateOptions, deps: CalibrateDeps): Promise<CalibrateResult> {
  const requested = options.groups ?? 20;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new CalibrationError("usage", "groups must be a positive integer");
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd! < CALIBRATION_GROUP_FLOOR_USD) {
    throw new CalibrationError("budget", `--budget must cover one calibration group ($${CALIBRATION_GROUP_FLOOR_USD.toFixed(3)})`);
  }
  if (options.labels === "human" && !deps.io) throw new CalibrationError("usage", "human calibration requires io.ask");
  const manifest = verifyEvalsManifest(home);
  if (!manifest.ok) throw new CalibrationError("integrity", `eval manifest mismatch: ${[...manifest.changed, ...manifest.missing, ...manifest.extra].join(", ")}`);
  const groups = discoverCalibrationGroups(home);
  if (groups.length < requested) throw new CalibrationError("insufficient_material", "insufficient material: run M1 first");
  const judge = deps.models("judge"); const hash = calibrationHash(home, deps.cfg, judge);
  const id = `calibration-${hashInput({ labels: options.labels, requested, hash, groups: groups.slice(0, requested).map((group) => group.id) }).slice(0, 16)}`;
  const dir = join(home, "evals", "calibration"); ensureDir(dir);
  const replayPath = join(dir, `${id}.jsonl`); const path = join(home, "evals", "calibration.json");
  const commitPaths = ["evals/calibration.json", `evals/calibration/${id}.jsonl`];
  const operationId = `eval-calibration-${id}`;
  const commitResult = (result: CalibrationFile) => commitCalibrationOperation(home, deps.git, operationId,
    `evals(calibrate): ${options.labels} ${result.groups} groups`, commitPaths, "evals/calibration.json");
  const commitGate = async (result: CalibrationFile): Promise<string | undefined> => {
    if (options.labels !== "human" || result.provisional || result.agreement >= 0.60) return undefined;
    const gateOperation = `${operationId}-judge-gate`;
    if (deps.cfg.evals.judgeGate !== "removed") {
      deps.cfg.evals.judgeGate = "removed"; deps.cfg.autonomous = false; saveConfig(home, deps.cfg);
    } else if (!await deps.git.hasTrailer(home, "Kiln-Operation", gateOperation)
      && !await dirtyOwnedPaths(home, deps.git, ["config.json"])) return undefined;
    return commitCalibrationOperation(home, deps.git, gateOperation, "evals(gate): judge removed", ["config.json"], "config.json");
  };
  const held = json<CalibrationFile>(path);
  if (held?.labelSource === options.labels && held.groups >= requested && sameHash(held.hash, hash) && existsSync(replayPath)) {
    const commit = await commitResult(held); const gateCommit = await commitGate(held);
    return { ...held, id, path, replayPath, ...(commit ? { commit } : {}), ...(gateCommit ? { gateCommit } : {}) };
  }
  const reportDir = join(dir, id); ensureDir(join(reportDir, "criteria"));
  const record = new RunRecord(join(reportDir, "record.jsonl"));
  const run = { ...runPaths(home, id), dir: reportDir, criteriaDir: join(reportDir, "criteria"), record: record.path, tournament: replayPath };
  const judgeDeps: JudgeDeps = { home, run, record, cfg: deps.cfg, models: deps.models, apiKeyFor: deps.apiKeyFor, streamFn: deps.streamFn, effort: hash.effort };
  let lines = readLines(replayPath); let refusedGroups = 0; let accepted = completeGroupIds(lines);
  for (const group of groups) {
    if (accepted.size >= requested) break;
    const prior = lines.find((line) => line.calibrationGroupId === group.id);
    if (!prior && options.budgetUsd! - record.costUsd() < CALIBRATION_GROUP_FLOOR_USD) throw new CalibrationError("budget", "calibration budget exhausted before the next complete group");
    const label = prior ? { best: prior.labelBest, worst: prior.labelWorst, costUsd: prior.labelCostUsd, model: prior.labellerModel, crossProvider: prior.labellerCrossProvider }
      : options.labels === "human" ? await humanLabel(home, deps.io!, group)
      : await labelBestWorst({ ...deps, home, cfg: deps.cfg, record }, group);
    if (!label.best || !label.worst) { refusedGroups += 1; continue; }
    const done = new Set(lines.map((line) => pairKey(line.a, line.b, line.order)));
    for (const preference of impliedPreferences(group.items.map((item) => item.id), label.best, label.worst)) {
      const original = [preference.winner, preference.loser].sort(); const [originalA, originalB] = original as [string, string];
      const a = namespaced(group, originalA); const b = namespaced(group, originalB);
      for (const order of ["ab", "ba"] as const) {
        if (done.has(pairKey(a, b, order))) continue;
        const aItem = group.items.find((item) => item.id === originalA)!; const bItem = group.items.find((item) => item.id === originalB)!;
        if (options.budgetUsd! <= record.costUsd()) throw new CalibrationError("budget", "calibration budget exhausted before judge dispatch");
        const verdict = await (deps.judgePair ?? judgePair)(judgeDeps, group.criteria, aItem.render, bItem.render, order);
        const line: CalibrationLine = { seq: lines.reduce((max, held) => Math.max(max, held.seq), 0) + 1, ts: (options.now ?? (() => new Date()))().toISOString(),
          round: group.round, a, b, order, valueWinner: verdict.valueWinner, feasibilityWinner: verdict.feasibilityWinner,
          judgeModel: verdict.judgeModel, aGenModel: group.generationModels[originalA] ?? "unknown", bGenModel: group.generationModels[originalB] ?? "unknown",
          criteriaId: group.criteria.id, aRenderHash: group.renderHashes[originalA]!, bRenderHash: group.renderHashes[originalB]!, costUsd: verdict.costUsd,
          source: "judge", reason: verdict.reason, calibrationGroupId: group.id, sourceRunId: group.runId, frontierMode: group.frontierMode,
          labelWinner: namespaced(group, preference.winner), labelBest: label.best, labelWorst: label.worst, labellerModel: label.model,
          labellerCrossProvider: label.crossProvider, labelCostUsd: label.costUsd, fallbackUnknown: true,
          shape: group.shape };
        appendLine(replayPath, JSON.stringify(line)); lines.push(line); done.add(pairKey(a, b, order));
      }
    }
    accepted = completeGroupIds(lines);
  }
  const computedAt = (options.now ?? (() => new Date()))().toISOString(); const result = stats(lines, refusedGroups, options.labels, hash, computedAt, record.costUsd());
  writeAtomic(path, `${JSON.stringify(result, null, 2)}\n`);
  const commit = await commitResult(result); const gateCommit = await commitGate(result);
  return { ...result, id, path, replayPath, commit, gateCommit };
}

function sameHash(a: JudgeCalibrationHash, b: JudgeCalibrationHash): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Read the current provenance stamp; malformed or drifted calibration is stale, never silently absent. */
export function judgeCalibration(home: string, cfg: KilnConfig, judge: { model: Model; ref: string }): JudgeCalibrationStamp {
  if (cfg.evals.judgeGate === "removed") return { status: "removed" };
  const path = join(home, "evals", "calibration.json");
  if (!existsSync(path)) return { status: "absent" };
  const value = json<Partial<CalibrationFile>>(path); const current = calibrationHash(home, cfg, judge);
  if (!value?.hash || !sameHash(value.hash, current)) return { status: "stale", ...(value?.hash ? { hash: value.hash } : {}) };
  const common = { agreement: value.agreement, orderAgreement: value.orderAgreement, labelSource: value.labelSource, hash: value.hash, effort: value.effort };
  if (value.provisional || (value.groups ?? 0) < 20) return { status: "provisional", ...common };
  if (value.labelSource === "agent") return { status: "agent", ...common };
  return { status: value.calibrated ? "calibrated" : "provisional", ...common };
}

export const readJudgeCalibration = judgeCalibration;
