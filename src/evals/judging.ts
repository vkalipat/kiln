import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendLine, ensureDir } from "../core/paths";
import type { IdeaShape } from "../core/config";
import type { PairOrder, StoredEvent } from "../core/events";
import type { RunPaths } from "../core/run";
import { parseRawIsland } from "../ideation/island-raw";
import { judgePair, writeCriteria, type Criteria, type CriteriaResult, type JudgeDeps, type PairVerdict } from "../ideation/judge";
import { collapsePairs } from "../ideation/bt";
import type { TournamentRecord } from "../ideation/tournament";

export interface JudgingSeed { id: string; text: string; shape: IdeaShape }
export interface JudgingArm { name: string; run: RunPaths }

export interface EvalJudgedLine extends TournamentRecord {
  seedId: string;
  aArm: string;
  bArm: string;
  aFallbackServed: boolean;
  bFallbackServed: boolean;
  judgeFallbackServed: boolean;
  fallbackUnknown?: boolean;
}

export interface JudgeArmsOptions {
  pairsPerSeed: number;
  writeCriteria?: (deps: JudgeDeps, round: number, brief: string, shape: IdeaShape) => Promise<CriteriaResult>;
  judgePair?: (deps: JudgeDeps, criteria: Criteria, a: string, b: string, order: PairOrder) => Promise<PairVerdict>;
  now?: () => Date;
}

function frontier(run: RunPaths): { round: number; ids: string[]; bare: boolean } {
  const value = JSON.parse(readFileSync(run.frontier, "utf8")) as { round?: number; shown?: string[]; ideas?: Array<string | { id?: string }>; mode?: string };
  const ideaIds = Array.isArray(value.ideas) ? value.ideas.flatMap((item) => typeof item === "string" ? [item] : typeof item?.id === "string" ? [item.id] : []) : [];
  const bare = value.mode === "bare";
  const ids = bare ? ideaIds : Array.isArray(value.shown) ? value.shown : ideaIds;
  return { round: value.round ?? 1, ids, bare };
}

function render(run: RunPaths, id: string, round: number): { text: string; hash: string } {
  const exact = join(run.renderedDir, `${id}-r${round}.md`);
  const fallback = readdirSync(run.renderedDir).filter((name) => name.startsWith(`${id}-r`) && name.endsWith(".md")).sort().at(-1);
  const path = existsSync(exact) ? exact : fallback ? join(run.renderedDir, fallback) : exact;
  const text = readFileSync(path, "utf8");
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}

function events(run: RunPaths): StoredEvent[] {
  if (!existsSync(run.record)) return [];
  return readFileSync(run.record, "utf8").split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as StoredEvent] : []; } catch { return []; }
  });
}

function generation(run: RunPaths, id: string): { model: string; fallback: boolean; unknown: boolean } {
  const held = events(run);
  const match = /^r(\d+)-i(\d+)-/.exec(id);
  if (match) {
    const raw = join(run.rawIdeasDir, `r${match[1]}-i${match[2]}.md`);
    if (existsSync(raw)) {
      const model = parseRawIsland(readFileSync(raw, "utf8")).meta.model;
      const calls = held.flatMap((event) => event.t === "model.call" && event.role === "generator" ? [event] : []);
      if (model) return { model, fallback: calls.some((event) => event.fallbackServed === true), unknown: calls.some((event) => event.fallbackServed === undefined) };
    }
  }
  const found = held.findLast((event) => event.t === "model.call" && event.role === "generator");
  const call = found?.t === "model.call" ? found : undefined;
  return call
    ? { model: `${call.provider}/${call.model}`, fallback: call.fallbackServed === true, unknown: call.fallbackServed === undefined }
    : { model: "unknown", fallback: false, unknown: true };
}

function readLines(path: string): EvalJudgedLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as EvalJudgedLine] : []; } catch { return []; }
  });
}

/** Rank-match two arms, judge both orderings, append after every verdict, and skip durable keys. */
export async function judgeArms(
  evalDir: string,
  seed: JudgingSeed,
  a: JudgingArm,
  b: JudgingArm,
  deps: JudgeDeps,
  options: JudgeArmsOptions,
): Promise<{ lines: EvalJudgedLine[]; collapsed: ReturnType<typeof collapsePairs> }> {
  if (!Number.isSafeInteger(options.pairsPerSeed) || options.pairsPerSeed < 1) throw new Error("pairsPerSeed must be a positive safe integer");
  const judged = join(evalDir, "judged.jsonl");
  const criteriaDir = join(evalDir, "criteria", seed.id); ensureDir(criteriaDir);
  const virtual: RunPaths = { ...deps.run, criteriaDir, tournament: judged };
  const judgeDeps = { ...deps, run: virtual };
  const criteriaResult = await (options.writeCriteria ?? writeCriteria)(judgeDeps, 1, seed.text, seed.shape);
  if (!criteriaResult.ok) throw new Error(criteriaResult.message);
  const af = frontier(a.run); const bf = frontier(b.run);
  const k = Math.min(options.pairsPerSeed, af.ids.length, bf.ids.length);
  const pairs = Array.from({ length: k }, (_, index) => ({ aId: af.ids[index]!, bId: bf.ids[index]! }));
  const existing = readLines(judged);
  const done = new Set(existing.map((line) => `${line.seedId}|${line.a}|${line.b}|${line.order}`));
  let seq = existing.reduce((max, line) => Math.max(max, line.seq), 0);
  for (const pair of pairs) {
    const aKey = `${a.name}:${pair.aId}`; const bKey = `${b.name}:${pair.bId}`;
    const ar = render(a.run, pair.aId, af.round); const br = render(b.run, pair.bId, bf.round);
    const ag = generation(a.run, pair.aId); const bg = generation(b.run, pair.bId);
    for (const order of ["ab", "ba"] as const) {
      if (done.has(`${seed.id}|${aKey}|${bKey}|${order}`)) continue;
      const verdict = await (options.judgePair ?? judgePair)(judgeDeps, criteriaResult, ar.text, br.text, order);
      const judgeCall = events(deps.run).findLast((event) => event.t === "model.call" && event.role === "judge");
      const judgeFallback = judgeCall?.t === "model.call" && judgeCall.fallbackServed === true;
      const fallbackUnknown = ag.unknown || bg.unknown || judgeCall?.t !== "model.call" || judgeCall.fallbackServed === undefined;
      const line: EvalJudgedLine = {
        seq: ++seq, ts: (options.now ?? (() => new Date()))().toISOString(), round: 1,
        a: aKey, b: bKey, order, valueWinner: verdict.valueWinner, feasibilityWinner: verdict.feasibilityWinner,
        judgeModel: verdict.judgeModel, aGenModel: ag.model, bGenModel: bg.model,
        criteriaId: criteriaResult.id, aRenderHash: ar.hash, bRenderHash: br.hash,
        costUsd: verdict.costUsd, source: "judge", reason: verdict.reason,
        seedId: seed.id, aArm: a.name, bArm: b.name,
        aFallbackServed: ag.fallback, bFallbackServed: bg.fallback, judgeFallbackServed: judgeFallback,
        ...(fallbackUnknown ? { fallbackUnknown: true } : {}),
      };
      appendLine(judged, JSON.stringify(line));
    }
  }
  const lines = readLines(judged).filter((line) => line.seedId === seed.id && line.aArm === a.name && line.bArm === b.name);
  return { lines, collapsed: collapsePairs(lines) };
}
