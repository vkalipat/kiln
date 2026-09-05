/** Frontier: eligibility, interval dominance, the checkpoint trim, and MMR selection
 *  (decision record §7, §8). Pure and deterministic; the only shared type is the strength
 *  interval produced by `bt.ts`. */

import { type Bounds, COMPAT_LEVEL, levelKey, type StrengthInterval } from "./bt";

/** How one idea is judged to beat another. `interval` is the record's rule - A dominates B only
 *  when A's lower bound beats B's upper bound on both axes - with the confidence `level` (the
 *  two-sided interval probability) as the tuning knob: 0.95 reads the 2.5/97.5 percentiles,
 *  0.5 reads the 25/75 percentiles and so dominates far more often. `mean` compares the two
 *  bootstrap means, i.e. the limit of shrinking the interval to a point. */
export type Dominance = { kind: "mean" } | { kind: "interval"; level: number };

/** Provisional, set from the measurements in `test/ideation/simulation.test.ts`. */
export const DEFAULT_DOMINANCE: Dominance = { kind: "interval", level: 0.5 };

/** An archive cell as an axis-to-value map, e.g. `{ medium: "cli", buyer: "solo" }`. */
export type Cell = Record<string, string>;

export interface AxisIntervals {
  value: StrengthInterval;
  feasibility: StrengthInterval;
}

export interface FrontierInput {
  strengths: Record<string, AxisIntervals>;
  minComparisons: number;
  /** Defaults to `DEFAULT_DOMINANCE`. An `interval` rule needs the strengths to carry that
   *  level: pass `levels: [level]` to `bootstrapStrengths`. */
  dominance?: Dominance;
}

export interface FrontierResult {
  /** Ideas with at least `minComparisons` on both axes, by value mean then id. */
  eligible: string[];
  /** The non-dominated eligible ideas, in the same order. */
  front: string[];
}

export interface TrimOptions {
  max: number;
  min: number;
  /** Cell champions, in the order they should be offered, used only to reach `min`. */
  champions?: readonly string[];
  /** Value means; when absent the incoming front order is taken as the value ranking. */
  values?: Record<string, number>;
}

export interface TrimResult {
  /** What the checkpoint displays: front members first, then any backfill. */
  shown: string[];
  /** The subset of `shown` that is not on the frontier and must be marked as such. */
  backfill: string[];
  /** Front members dropped by the cell-spread trim. */
  trimmed: string[];
}

export type SimSource = Record<string, Record<string, number>> | ((a: string, b: string) => number);

export interface MmrOptions {
  values?: Record<string, number>;
  /** Weight on relevance against diversity; 0.5 by default. */
  lambda?: number;
}

const EPS = 1e-9;

/** A stable, axis-order-independent key for a cell. A string is already a key; a missing cell
 *  collapses to the empty key so uncelled ideas group together instead of each forming a cell. */
export function cellKey(cell: Cell | string | undefined): string {
  if (cell === undefined) return "";
  if (typeof cell === "string") return cell;
  return Object.keys(cell)
    .sort()
    .map((axis) => `${axis}=${cell[axis]}`)
    .join("|");
}

/** Archive-cell distance: the number of axes on which two cells differ, counting an axis that
 *  only one cell carries as a difference. */
export function cellDistance(a: Cell | undefined, b: Cell | undefined): number {
  const axes = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  let d = 0;
  for (const axis of axes) if ((a ?? {})[axis] !== (b ?? {})[axis]) d++;
  return d;
}

/** The pair of bounds a dominance rule compares. Collapsing `mean` to `lo = hi = mean` makes
 *  both rules the same comparison. A missing level is an error rather than a silent fallback:
 *  quietly answering at the wrong confidence would corrupt the frontier. */
function bounds(interval: StrengthInterval, rule: Dominance): Bounds {
  if (rule.kind === "mean") return { lo: interval.mean, hi: interval.mean };
  const found = interval.intervals?.[levelKey(rule.level)];
  if (found) return found;
  if (rule.level === COMPAT_LEVEL) return { lo: interval.lo, hi: interval.hi };
  throw new Error(
    `frontier: strengths carry no ${levelKey(rule.level)} interval; pass levels: [${rule.level}] to bootstrapStrengths`,
  );
}

function axisSpan(a: Cell | undefined, b: Cell | undefined): number {
  return new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]).size;
}

function similarity(sims: SimSource, a: string, b: string): number {
  if (typeof sims === "function") return sims(a, b) ?? 0;
  return sims[a]?.[b] ?? sims[b]?.[a] ?? 0;
}

/** Eligible ideas and the interval-dominance Pareto set over them.
 *
 *  Eligibility is `n >= minComparisons` on both axes: an idea nobody compared sits at the prior
 *  with a maximal interval and would otherwise be undominated by construction, which would hand
 *  the least-examined ideas a guaranteed frontier seat (grill round 2, item 1).
 *
 *  A dominates B only when A's lower bound beats B's upper bound on both axes, so an idea that
 *  trades value against feasibility stays on the front. How wide those bounds are is the
 *  `dominance` rule's `level`: at 0.95 the rule eliminates almost nobody (the simulation
 *  measures 14.8 of 16), which is why the default level is lower. */
export function frontier(input: FrontierInput): FrontierResult {
  const { strengths, minComparisons } = input;
  const eligible = Object.keys(strengths)
    .filter((id) => {
      const s = strengths[id]!;
      return s.value.n >= minComparisons && s.feasibility.n >= minComparisons;
    })
    .sort((x, y) => strengths[y]!.value.mean - strengths[x]!.value.mean || (x < y ? -1 : x > y ? 1 : 0));
  const rule = input.dominance ?? DEFAULT_DOMINANCE;
  const value = new Map(eligible.map((id) => [id, bounds(strengths[id]!.value, rule)]));
  const feasibility = new Map(eligible.map((id) => [id, bounds(strengths[id]!.feasibility, rule)]));
  const front = eligible.filter((id) => {
    const bv = value.get(id)!;
    const bf = feasibility.get(id)!;
    return !eligible.some(
      (other) => other !== id && value.get(other)!.lo > bv.hi && feasibility.get(other)!.lo > bf.hi,
    );
  });
  return { eligible, front };
}

/** Trim the front to the checkpoint's display window (decision record §7).
 *
 *  Over `max`: keep by cell spread, taking one idea per cell in value order before any cell's
 *  second, so the display never shows eight variations on one cell. Under `min`: extend the
 *  display with cell champions, returned separately so the caller can mark them `backfill` -
 *  they are pickable but are not frontier members and are not counted in the frontier size. */
export function trimForCheckpoint(
  front: readonly string[],
  cells: Record<string, Cell>,
  opts: TrimOptions,
): TrimResult {
  const ordered = rankByValue(front, opts.values);
  if (ordered.length > opts.max) {
    const groups = new Map<string, string[]>();
    for (const id of ordered) {
      const key = cellKey(cells[id]);
      const group = groups.get(key);
      if (group) group.push(id);
      else groups.set(key, [id]);
    }
    // Insertion order of `groups` follows `ordered`, so cells are visited best-idea first.
    const lanes = [...groups.values()];
    const shown: string[] = [];
    for (let depth = 0; shown.length < opts.max; depth++) {
      let progressed = false;
      for (const lane of lanes) {
        if (depth >= lane.length) continue;
        progressed = true;
        shown.push(lane[depth]!);
        if (shown.length >= opts.max) break;
      }
      if (!progressed) break;
    }
    const kept = new Set(shown);
    return { shown, backfill: [], trimmed: ordered.filter((id) => !kept.has(id)) };
  }
  const shown = [...ordered];
  const backfill: string[] = [];
  if (shown.length < opts.min) {
    const seen = new Set(shown);
    for (const champion of opts.champions ?? []) {
      if (shown.length >= opts.min) break;
      if (seen.has(champion)) continue;
      seen.add(champion);
      shown.push(champion);
      backfill.push(champion);
    }
  }
  return { shown, backfill, trimmed: [] };
}

/** Greedy maximal marginal relevance over the front: relevance is the value mean, diversity is
 *  archive-cell distance, and trigram Jaccard similarity breaks cell-distance ties
 *  (decision record §8). `k` is capped at the front size. */
export function mmrSelect(
  front: readonly string[],
  cells: Record<string, Cell>,
  sims: SimSource,
  k: number,
  opts: MmrOptions = {},
): string[] {
  const ordered = rankByValue(front, opts.values);
  const lambda = opts.lambda ?? 0.5;
  const limit = Math.min(k, ordered.length);
  if (limit <= 0) return [];
  const rel = normalizedRelevance(ordered, opts.values);
  const picked: string[] = [];
  const remaining = [...ordered];
  while (picked.length < limit) {
    let best = 0;
    let bestScore = -Infinity;
    let bestSim = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const id = remaining[i]!;
      let cellSim = 0;
      let jaccard = 0;
      for (const chosen of picked) {
        const span = axisSpan(cells[id], cells[chosen]);
        const closeness = span === 0 ? 1 : 1 - cellDistance(cells[id], cells[chosen]) / span;
        cellSim = Math.max(cellSim, closeness);
        jaccard = Math.max(jaccard, similarity(sims, id, chosen));
      }
      const score = lambda * rel[id]! - (1 - lambda) * cellSim;
      if (score > bestScore + EPS || (score > bestScore - EPS && jaccard < bestSim - EPS)) {
        best = i;
        bestScore = score;
        bestSim = jaccard;
      }
    }
    picked.push(remaining[best]!);
    remaining.splice(best, 1);
  }
  return picked;
}

function rankByValue(front: readonly string[], values?: Record<string, number>): string[] {
  if (!values) return [...front];
  return [...front].sort((x, y) => (values[y] ?? 0) - (values[x] ?? 0) || (x < y ? -1 : x > y ? 1 : 0));
}

function normalizedRelevance(ordered: readonly string[], values?: Record<string, number>): Record<string, number> {
  const rel: Record<string, number> = {};
  if (values) {
    const nums = ordered.map((id) => values[id] ?? 0);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min;
    ordered.forEach((id, i) => {
      rel[id] = span > EPS ? (nums[i]! - min) / span : 0;
    });
    return rel;
  }
  // No means supplied: the incoming order is the ranking, spread evenly over [0, 1].
  const last = Math.max(1, ordered.length - 1);
  ordered.forEach((id, i) => {
    rel[id] = 1 - i / last;
  });
  return rel;
}
