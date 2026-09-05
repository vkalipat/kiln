/** Bradley-Terry strength estimation over the tournament log.
 *
 *  Pure module: no imports from the rest of kiln, no I/O, no clock, no randomness that is not
 *  seeded. Every function is deterministic for identical inputs (decision record §7, §13). */

/** One collapsed comparison. `score` is the outcome for `a`: 1 win, 0 loss, 0.5 tie. */
export interface Outcome {
  a: string;
  b: string;
  score: number;
  /** Evidence weight; judge comparisons are 1, human comparisons are `humanWeight` (3). */
  weight?: number;
}

/** One axis's winner on one line: a canonical side, or no answer. A retry-exhausted judge ties
 *  both axes; a human best-worst answer is decisive on one and `"tie"` on the other. Per axis
 *  always, so a tie on one axis never speaks for the other. */
export type Winner = "a" | "b" | "tie";

/** A `tournament.jsonl` line, reduced to the fields the math needs (decision record §7).
 *  `TournamentRecord` in `tournament.ts` extends this with the persistence fields, so the line
 *  shape has exactly one owner and no cast is needed to fit it.
 *  Winners are expressed relative to the pair's canonical ids `a` and `b`, never relative to
 *  the presentation order, so a `ba` line saying `valueWinner: "a"` means the canonical `a`
 *  won while it was shown second. */
export interface TournamentLine {
  round: number;
  a: string;
  b: string;
  order: "ab" | "ba";
  valueWinner: Winner;
  feasibilityWinner: Winner;
  source?: "judge" | "human";
  /** Distinguishes independently elicited human relations from the machine pair at the same round. */
  comparisonId?: string;
  weight?: number;
}
export interface CollapsedOutcomes {
  value: Outcome[];
  feasibility: Outcome[];
  /** Pairs seen in exactly one ordering: judged but not collapsible, so not fit. */
  incomplete: { round: number; a: string; b: string }[];
}

export interface Bounds {
  lo: number;
  hi: number;
}

export interface StrengthInterval {
  mean: number;
  /** The 0.95 pair, kept flat for compatibility; the same values as `intervals["0.95"]`. */
  lo: number;
  hi: number;
  /** Collapsed comparisons involving this idea. Eligibility reads this, so it counts
   *  comparisons, not weight: one heavily weighted human comparison is still one comparison. */
  n: number;
  /** Percentile pairs keyed by two-sided interval probability, e.g. `"0.5"` holds the 25th
   *  and 75th percentiles. Present on everything `bootstrapStrengths` returns; optional so a
   *  test or a caller can hand-build a `StrengthInterval`. */
  intervals?: Record<string, Bounds>;
}

export interface BradleyTerryOptions {
  /** L2 shrinkage toward equal strength. */
  lambda?: number;
  maxIterations?: number;
  tolerance?: number;
}

export interface BootstrapOptions extends BradleyTerryOptions {
  samples?: number;
  seed?: number;
  /** Two-sided interval probabilities to report, e.g. `[0.5, 0.95]`. 0.95 is always included
   *  because `lo`/`hi` carry it. Ask for whatever level the frontier's dominance rule uses. */
  levels?: number[];
  /** Compute an idea's percentiles only over replicates that drew at least one of its
   *  comparisons. Default true; see `bootstrapStrengths` for why. */
  conditionOnObserved?: boolean;
}

export interface CollapseOptions {
  humanWeight?: number;
}

export const DEFAULT_LAMBDA = 0.1;
export const DEFAULT_HUMAN_WEIGHT = 3;
export const DEFAULT_SAMPLES = 1000;
/** The level `lo` and `hi` always carry. */
export const COMPAT_LEVEL = 0.95;

/** A level's key in `StrengthInterval.intervals`. */
export function levelKey(level: number): string {
  return String(level);
}

/** Acklam's inverse normal CDF, |error| < 1.15e-9. Only the prior interval needs it: an
 *  uncompared idea has no bootstrap distribution to take percentiles of. */
export function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const tail = (q: number): number =>
    (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same stream, on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Half-width of the interval an idea with no comparisons carries: the L2 prior N(0, 1/lambda)
 *  at `level`. It is deliberately huge - an uncompared idea is unmeasured, not average. */
export function priorInterval(lambda: number = DEFAULT_LAMBDA, level: number = COMPAT_LEVEL): number {
  return normalQuantile((1 + level) / 2) / Math.sqrt(lambda > 0 ? lambda : DEFAULT_LAMBDA);
}

interface Cmp {
  ai: number;
  bi: number;
  score: number;
  weight: number;
}

function logSigmoid(d: number): number {
  return d >= 0 ? -Math.log1p(Math.exp(-d)) : d - Math.log1p(Math.exp(d));
}

function objective(theta: Float64Array, cmps: readonly Cmp[], lambda: number): number {
  let total = 0;
  for (const c of cmps) {
    const d = theta[c.ai]! - theta[c.bi]!;
    total += c.weight * (c.score * logSigmoid(d) + (1 - c.score) * logSigmoid(-d));
  }
  for (let i = 0; i < theta.length; i++) total -= 0.5 * lambda * theta[i]! * theta[i]!;
  return total;
}

function indexOutcomes(outcomes: readonly Outcome[], index: Map<string, number>): Cmp[] {
  const cmps: Cmp[] = [];
  for (const o of outcomes) {
    const ai = index.get(o.a);
    const bi = index.get(o.b);
    // Outcomes touching an id outside `ids` carry no information about the ids being fit.
    if (ai === undefined || bi === undefined || ai === bi) continue;
    cmps.push({ ai, bi, score: o.score, weight: o.weight ?? 1 });
  }
  return cmps;
}

function solve(cmps: readonly Cmp[], size: number, opts: BradleyTerryOptions): Float64Array {
  const lambda = opts.lambda ?? DEFAULT_LAMBDA;
  const maxIterations = opts.maxIterations ?? 200;
  const tolerance = opts.tolerance ?? 1e-6;
  const theta = new Float64Array(size);
  if (cmps.length === 0 || size === 0) return theta;
  let value = objective(theta, cmps, lambda);
  const grad = new Float64Array(size);
  const curv = new Float64Array(size);
  const step = new Float64Array(size);
  const trial = new Float64Array(size);
  for (let iter = 0; iter < maxIterations; iter++) {
    grad.fill(0);
    curv.fill(lambda);
    for (const c of cmps) {
      const p = 1 / (1 + Math.exp(-(theta[c.ai]! - theta[c.bi]!)));
      const g = c.weight * (c.score - p);
      grad[c.ai]! += g;
      grad[c.bi]! -= g;
      const h = c.weight * p * (1 - p);
      curv[c.ai]! += h;
      curv[c.bi]! += h;
    }
    let maxStep = 0;
    for (let i = 0; i < size; i++) {
      // Diagonal Newton on a strictly concave objective: the curvature floor is lambda, so
      // an idea with no comparisons in this fit stays exactly at the prior.
      step[i] = (grad[i]! - lambda * theta[i]!) / curv[i]!;
      maxStep = Math.max(maxStep, Math.abs(step[i]!));
    }
    if (maxStep < tolerance) break;
    // Backtrack until the step actually improves the objective; the diagonal approximation
    // can overshoot, and a monotone ascent is what makes the fit reproducible.
    let scale = 1;
    let improved = false;
    for (let back = 0; back < 24; back++) {
      for (let i = 0; i < size; i++) trial[i] = theta[i]! + scale * step[i]!;
      const next = objective(trial, cmps, lambda);
      if (next >= value) {
        value = next;
        theta.set(trial);
        improved = true;
        break;
      }
      scale /= 2;
    }
    if (!improved || scale * maxStep < tolerance) break;
  }
  return theta;
}

/** Maximum a posteriori Bradley-Terry fit on log-strengths with L2 shrinkage toward 0.
 *  Ties enter as score 0.5. Ids with no usable comparison stay at 0. */
export function fitBradleyTerry(
  outcomes: readonly Outcome[],
  ids: readonly string[],
  opts: BradleyTerryOptions = {},
): Record<string, number> {
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  const theta = solve(indexOutcomes(outcomes, index), ids.length, opts);
  const out: Record<string, number> = {};
  ids.forEach((id, i) => {
    out[id] = theta[i]!;
  });
  return out;
}

/** Collapse `(round, a, b, comparisonId?, order)` lines into one outcome per elicitation per axis.
 *  A pair is only usable once both orderings exist; agreement is decisive, anything else -
 *  a swap disagreement, or either ordering answering `"tie"` on that axis - is half a win.
 *  Each axis is collapsed on its own: a line decisive on value and tied on feasibility still
 *  contributes its value comparison. Output is sorted by `(round, a, b)` so the fit does not
 *  depend on the order in which the log happened to be appended across resumes. */
export function collapsePairs(lines: readonly TournamentLine[], opts: CollapseOptions = {}): CollapsedOutcomes {
  const humanWeight = opts.humanWeight ?? DEFAULT_HUMAN_WEIGHT;
  interface Slot {
    round: number;
    a: string;
    b: string;
    comparisonId?: string;
    ab?: TournamentLine;
    ba?: TournamentLine;
  }
  const slots = new Map<string, Slot>();
  for (const l of lines) {
    const key = `${l.round} ${l.a} ${l.b} ${l.comparisonId ?? "judge"}`;
    let slot = slots.get(key);
    if (!slot) {
      slot = { round: l.round, a: l.a, b: l.b, comparisonId: l.comparisonId };
      slots.set(key, slot);
    }
    // First line wins: the log is append-only and a duplicate can only be a replayed write.
    if (slot[l.order] === undefined) slot[l.order] = l;
  }
  const ordered = [...slots.values()].sort(
    (x, y) => x.round - y.round || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0) || (x.comparisonId ?? "").localeCompare(y.comparisonId ?? ""),
  );
  const out: CollapsedOutcomes = { value: [], feasibility: [], incomplete: [] };
  for (const slot of ordered) {
    const { ab, ba } = slot;
    if (!ab || !ba) {
      out.incomplete.push({ round: slot.round, a: slot.a, b: slot.b });
      continue;
    }
    const weight = Math.max(weightOf(ab, humanWeight), weightOf(ba, humanWeight));
    out.value.push({ a: slot.a, b: slot.b, score: collapse(ab.valueWinner, ba.valueWinner), weight });
    out.feasibility.push({
      a: slot.a,
      b: slot.b,
      score: collapse(ab.feasibilityWinner, ba.feasibilityWinner),
      weight,
    });
  }
  return out;
}

function weightOf(line: TournamentLine, humanWeight: number): number {
  return line.weight ?? (line.source === "human" ? humanWeight : 1);
}

function collapse(first: Winner, second: Winner): number {
  // `!==` already covers "one ordering answered, the other tied": that is not agreement either.
  if (first !== second) return 0.5;
  return first === "a" ? 1 : first === "b" ? 0 : 0.5;
}

/** Collapsed comparisons per id, ignoring weight. This is the eligibility count. */
export function comparisonCounts(outcomes: readonly Outcome[], ids: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = 0;
  for (const o of outcomes) {
    if (counts[o.a] !== undefined) counts[o.a]!++;
    if (counts[o.b] !== undefined) counts[o.b]!++;
  }
  return counts;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Seeded case-resampling bootstrap over collapsed pair outcomes (never over log lines: a
 *  line-level resample can draw one ordering of a pair without the other and destroy the swap
 *  rule). Returns the bootstrap mean with the 2.5 and 97.5 percentiles.
 *
 *  `conditionOnObserved` (default true) drops, from an idea's own percentiles, the replicates
 *  in which none of its comparisons were drawn. Such a replicate returns the prior for that
 *  idea, not an estimate of it. With three comparisons each - the minimum the record requires -
 *  a replicate misses a given idea entirely about 4% of the time, which is more than the 2.5%
 *  tail: including those replicates pins `lo` at exactly 0 for the strongest idea and `hi` at
 *  exactly 0 for the weakest, so `A.lo > B.hi` can never hold and interval dominance degenerates
 *  to "every idea is on the frontier" (grill round 2, item 1). Pass false to see that behavior.
 *
 *  `levels` picks which two-sided interval probabilities come back in `intervals`; 0.95 is
 *  always present and is what `lo`/`hi` hold. The frontier's dominance rule reads the level it
 *  is configured with, so ask for that level here. */
export function bootstrapStrengths(
  outcomes: readonly Outcome[],
  ids: readonly string[],
  opts: BootstrapOptions = {},
): Record<string, StrengthInterval> {
  const samples = opts.samples ?? DEFAULT_SAMPLES;
  const seed = opts.seed ?? 0;
  const lambda = opts.lambda ?? DEFAULT_LAMBDA;
  const conditionOnObserved = opts.conditionOnObserved ?? true;
  // Default to both the dominance level the frontier uses (0.5) and the compatibility 0.95 pair,
  // so a caller taking every default gets a frontier that works instead of a missing-level throw.
  const levels = [...new Set([...(opts.levels ?? [0.5, COMPAT_LEVEL]), COMPAT_LEVEL])].sort((x, y) => x - y);
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  const cmps = indexOutcomes(outcomes, index);
  const counts = new Int32Array(ids.length);
  for (const c of cmps) {
    counts[c.ai]!++;
    counts[c.bi]!++;
  }
  const draws: number[][] = ids.map(() => []);
  if (cmps.length > 0 && samples > 0) {
    const rng = mulberry32(seed);
    const drawn = new Int32Array(ids.length);
    const replicate: Cmp[] = new Array(cmps.length);
    for (let s = 0; s < samples; s++) {
      drawn.fill(0);
      for (let k = 0; k < cmps.length; k++) {
        const c = cmps[Math.floor(rng() * cmps.length)]!;
        replicate[k] = c;
        drawn[c.ai]!++;
        drawn[c.bi]!++;
      }
      const theta = solve(replicate, ids.length, { ...opts, lambda });
      for (let i = 0; i < ids.length; i++) {
        if (counts[i] === 0) continue;
        if (conditionOnObserved && drawn[i] === 0) continue;
        draws[i]!.push(theta[i]!);
      }
    }
  }
  const out: Record<string, StrengthInterval> = {};
  ids.forEach((id, i) => {
    const n = counts[i]!;
    const values = draws[i]!;
    const intervals: Record<string, Bounds> = {};
    let mean = 0;
    if (n === 0 || values.length === 0) {
      for (const level of levels) {
        const half = priorInterval(lambda, level);
        intervals[levelKey(level)] = { lo: -half, hi: half };
      }
    } else {
      values.sort((x, y) => x - y);
      let sum = 0;
      for (const v of values) sum += v;
      mean = sum / values.length;
      for (const level of levels) {
        const tail = (1 - level) / 2;
        intervals[levelKey(level)] = { lo: percentile(values, tail), hi: percentile(values, 1 - tail) };
      }
    }
    const compat = intervals[levelKey(COMPAT_LEVEL)]!;
    out[id] = { mean, lo: compat.lo, hi: compat.hi, n, intervals };
  });
  return out;
}
