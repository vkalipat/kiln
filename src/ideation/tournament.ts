import { existsSync, readFileSync } from "node:fs";
import type { PairOrder } from "../core/events";
import type { Limiter } from "../core/limiter";
import { appendLine } from "../core/paths";
import type { RunPaths } from "../core/run";
import { bootstrapStrengths, collapsePairs, comparisonCounts, type Outcome, type StrengthInterval, type TournamentLine } from "./bt";
import { judgePair, type Criteria, type JudgeDeps } from "./judge";

/**
 * The tournament log (record §7): one line per (round, a, b, order), append-only, the resume key
 * for judging and the input to every fit. Human relations add `comparisonId` so they remain distinct
 * from a machine pair over the same ids. Winners are canonical (`a`/`b`/`tie`), never positional.
 */

/** The §7 line: `bt.ts`'s `TournamentLine` (what the math reads) plus the persistence fields.
 *  One owner for the winner types, so a tie reaches `collapsePairs` as a tie instead of being
 *  cast away. `weight` is omitted: on disk, evidence weight is derived from `source`. */
export interface TournamentRecord extends Omit<TournamentLine, "weight"> {
  seq: number;
  ts: string;
  order: PairOrder;
  judgeModel: string;
  aGenModel: string;
  bGenModel: string;
  criteriaId: string;
  aRenderHash: string;
  bRenderHash: string;
  costUsd: number;
  source: "judge" | "human";
  reason?: string;
}

export function readTournament(paths: RunPaths): TournamentRecord[] {
  if (!existsSync(paths.tournament)) return [];
  const out: TournamentRecord[] = [];
  for (const line of readFileSync(paths.tournament, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as TournamentRecord);
    } catch {
      // A torn line is skipped, never fatal; the pair it belonged to is simply judged again.
    }
  }
  return out;
}

export function appendTournamentLine(paths: RunPaths, line: Omit<TournamentRecord, "seq" | "ts">, seq: number): TournamentRecord {
  const full: TournamentRecord = { seq, ts: new Date().toISOString(), ...line };
  appendLine(paths.tournament, JSON.stringify(full));
  return full;
}

/** Which side of a comparison the judge itself generated: the asymmetry that biases a pair. */
export function selfPreferenceRisk(line: Pick<TournamentRecord, "judgeModel" | "aGenModel" | "bGenModel">): "none" | "a" | "b" | "both" {
  const a = line.aGenModel === line.judgeModel;
  const b = line.bGenModel === line.judgeModel;
  return a && b ? "both" : a ? "a" : b ? "b" : "none";
}

export interface TournamentInput {
  round: number;
  pairs: readonly [string, string][];
  renders: Record<string, { text: string; hash: string }>;
  genModels: Record<string, string>;
  criteria: Criteria;
  limiter?: Limiter;
  onLine?: (line: TournamentRecord) => void;
}

/** Judge every pair in both orders, skipping lines already on disk; returns this round's lines. */
export async function runTournament(deps: JudgeDeps, input: TournamentInput): Promise<TournamentRecord[]> {
  const existing = readTournament(deps.run);
  const machine = existing.filter((line) => line.source === "judge" && line.comparisonId === undefined);
  const done = new Set(machine.map((line) => `${line.round}|${line.a}|${line.b}|${line.order}`));
  let seq = existing.reduce((m, l) => Math.max(m, l.seq), 0);
  const results: TournamentRecord[] = machine.filter((line) => line.round === input.round);
  const jobs: Promise<void>[] = [];
  const runOne = async (a: string, b: string, order: PairOrder) => {
    const ra = input.renders[a];
    const rb = input.renders[b];
    if (!ra || !rb) throw new Error(`missing render for ${!ra ? a : b}`);
    const v = await judgePair(deps, input.criteria, ra.text, rb.text, order);
    seq += 1;
    const line = appendTournamentLine(deps.run, {
      round: input.round,
      a,
      b,
      order,
      valueWinner: v.valueWinner,
      feasibilityWinner: v.feasibilityWinner,
      judgeModel: v.judgeModel,
      aGenModel: input.genModels[a] ?? "unknown",
      bGenModel: input.genModels[b] ?? "unknown",
      criteriaId: input.criteria.id,
      aRenderHash: ra.hash,
      bRenderHash: rb.hash,
      costUsd: v.costUsd,
      source: "judge",
      reason: v.reason,
    }, seq);
    deps.record.append({ t: "verdict", round: input.round, a, b, order, valueWinner: v.valueWinner, feasibilityWinner: v.feasibilityWinner, judgeModel: v.judgeModel, costUsd: v.costUsd });
    results.push(line);
    input.onLine?.(line);
  };
  for (const [a, b] of input.pairs) {
    for (const order of ["ab", "ba"] as const) {
      if (done.has(`${input.round}|${a}|${b}|${order}`)) continue;
      const job = input.limiter ? input.limiter.run(() => runOne(a, b, order)) : runOne(a, b, order);
      jobs.push(job);
    }
  }
  await Promise.all(jobs);
  return results.sort((x, y) => x.seq - y.seq);
}

export interface RoundFit {
  value: Record<string, StrengthInterval>;
  feasibility: Record<string, StrengthInterval>;
  counts: { value: Record<string, number>; feasibility: Record<string, number> };
  incomplete: number;
}

/** Fit both ladders over the cumulative log with a seed derived from the run id and round.
 *  Lines go to `collapsePairs` whole: it owns tie handling and collapses each axis on its own,
 *  so a line that ties on feasibility still contributes its value comparison. */
export function fitRound(lines: readonly TournamentRecord[], ids: readonly string[], opts: { lambda: number; samples: number; humanWeight: number; level: number; seed: number }): RoundFit {
  const o = collapsePairs(lines, { humanWeight: opts.humanWeight });
  const bootstrap = (outcomes: Outcome[]) => bootstrapStrengths(outcomes, ids, { lambda: opts.lambda, samples: opts.samples, seed: opts.seed, levels: [opts.level, 0.95] });
  return {
    value: bootstrap(o.value),
    feasibility: bootstrap(o.feasibility),
    counts: { value: comparisonCounts(o.value, ids), feasibility: comparisonCounts(o.feasibility, ids) },
    incomplete: o.incomplete.length,
  };
}

export function seedFor(runId: string, round: number): number {
  let h = 2166136261;
  for (const ch of `${runId}:${round}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
