import { normalQuantile } from "../ideation/bt";

/** Local structural subset of `cfg.evals`; callers may pass the full config once it exists. */
export interface EvalStatisticsConfig {
  level: number;
  minPairs: number;
  minUncensoredSeeds: number;
  noninferiorityMargin: number;
}

export const DEFAULT_EVAL_STATISTICS: Readonly<EvalStatisticsConfig> = Object.freeze({
  level: 0.95,
  minPairs: 32,
  minUncensoredSeeds: 8,
  noninferiorityMargin: 0.1,
});

/** One statistical unit after the two presentation orderings have been collapsed. */
export interface CollapsedJudgedPair {
  /** Candidate outcome: win = 1, loss = 0, tie = 0.5. */
  score: number;
  /** Optional only because `bt.Outcome` predates eval seed identity. */
  seedId?: string;
}

export interface WilsonInterval {
  lower: number;
  upper: number;
}

export type GateVerdict = "win" | "lose" | "not_evidence";

export interface GateResult extends WilsonInterval {
  n: number;
  /** Effective wins: full wins plus one half per tied collapsed record. */
  wins: number;
  /** Least integer full-win count whose lower bound strictly exceeds 0.5. */
  required: number;
  verdict: GateVerdict;
}

export interface GateOptions extends Partial<Pick<EvalStatisticsConfig, "level" | "minPairs" | "minUncensoredSeeds">> {
  /** Explicit because honest exits are uncensored but contribute no judged pairs. */
  uncensoredSeeds?: number;
}

function validateLevel(level: number): void {
  if (!Number.isFinite(level) || level <= 0 || level >= 1) {
    throw new Error("level must be a finite number strictly between 0 and 1");
  }
}

function validateCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

/** Two-sided Wilson score interval. Fractional `wins` are intentional: every tie is half a win. */
export function wilson(wins: number, n: number, level: number = DEFAULT_EVAL_STATISTICS.level): WilsonInterval {
  validateCount(n, "n");
  validateLevel(level);
  if (!Number.isFinite(wins) || wins < 0 || wins > n) {
    throw new Error("wins must be finite and between 0 and n");
  }
  if (n === 0) return { lower: 0, upper: 1 };

  const z = normalQuantile((1 + level) / 2);
  const z2 = z * z;
  const p = wins / n;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

/** Integer bar printed in reports; `n + 1` means the requested bound is impossible at that n. */
export function requiredWins(n: number, level: number = DEFAULT_EVAL_STATISTICS.level, threshold = 0.5): number {
  validateCount(n, "n");
  validateLevel(level);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 1) {
    throw new Error("threshold must be finite and in [0, 1)");
  }
  let low = 0;
  let high = n;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (wilson(middle, n, level).lower > threshold) high = middle;
    else low = middle + 1;
  }
  return wilson(low, n, level).lower > threshold ? low : n + 1;
}

function effectiveWins(lines: readonly CollapsedJudgedPair[]): number {
  let wins = 0;
  for (const [index, line] of lines.entries()) {
    if (line.score !== 0 && line.score !== 0.5 && line.score !== 1) {
      throw new Error(`collapsed pair ${index} score must be 0, 0.5, or 1`);
    }
    wins += line.score;
  }
  return wins;
}

function inferredUncensoredSeeds(lines: readonly CollapsedJudgedPair[]): number {
  if (lines.some((line) => line.seedId === undefined)) {
    throw new Error("uncensoredSeeds is required when a collapsed pair has no seedId");
  }
  return new Set(lines.flatMap((line) => line.seedId === undefined ? [] : [line.seedId])).size;
}

/** Apply the promotion evidence rule to collapsed pair records, never to seed majorities. */
export function gate(lines: readonly CollapsedJudgedPair[], options: GateOptions = {}): GateResult {
  const level = options.level ?? DEFAULT_EVAL_STATISTICS.level;
  const minPairs = options.minPairs ?? DEFAULT_EVAL_STATISTICS.minPairs;
  const minUncensoredSeeds = options.minUncensoredSeeds ?? DEFAULT_EVAL_STATISTICS.minUncensoredSeeds;
  validateLevel(level);
  validateCount(minPairs, "minPairs");
  validateCount(minUncensoredSeeds, "minUncensoredSeeds");
  const inferredSeeds = options.uncensoredSeeds === undefined ? inferredUncensoredSeeds(lines) : undefined;
  const uncensoredSeeds = options.uncensoredSeeds ?? inferredSeeds!;
  validateCount(uncensoredSeeds, "uncensoredSeeds");
  const identifiedSeeds = new Set(lines.flatMap((line) => line.seedId === undefined ? [] : [line.seedId])).size;
  if (uncensoredSeeds < identifiedSeeds) {
    throw new Error("uncensoredSeeds cannot be smaller than the judged records' seed count");
  }

  const n = lines.length;
  const wins = effectiveWins(lines);
  const interval = wilson(wins, n, level);
  const enoughEvidence = n >= minPairs && uncensoredSeeds >= minUncensoredSeeds;
  return {
    n,
    wins,
    required: requiredWins(n, level),
    ...interval,
    verdict: !enoughEvidence ? "not_evidence" : interval.lower > 0.5 ? "win" : "lose",
  };
}

export interface SweepAssessment extends WilsonInterval {
  n: number;
  wins: number;
  admissible: boolean;
  qualityWin: boolean;
}

/** Assess one sweep cell. Non-inferiority is inclusive; a quality win remains strict. */
export function assessSweep(
  lines: readonly CollapsedJudgedPair[],
  margin: number = DEFAULT_EVAL_STATISTICS.noninferiorityMargin,
  level: number = DEFAULT_EVAL_STATISTICS.level,
): SweepAssessment {
  if (!Number.isFinite(margin) || margin < 0 || margin > 0.5) {
    throw new Error("margin must be finite and between 0 and 0.5");
  }
  const wins = effectiveWins(lines);
  const interval = wilson(wins, lines.length, level);
  return {
    n: lines.length,
    wins,
    ...interval,
    admissible: interval.lower >= 0.5 - margin,
    qualityWin: interval.lower > 0.5,
  };
}

export function admissible(
  lines: readonly CollapsedJudgedPair[],
  margin: number = DEFAULT_EVAL_STATISTICS.noninferiorityMargin,
  level: number = DEFAULT_EVAL_STATISTICS.level,
): boolean {
  return assessSweep(lines, margin, level).admissible;
}

/** The pre-registered incumbent A/A cell must not reject parity in either direction. */
export function incumbentSweepStatus(
  lines: readonly CollapsedJudgedPair[],
  level: number = DEFAULT_EVAL_STATISTICS.level,
): "ok" | "judging_biased" {
  const interval = wilson(effectiveWins(lines), lines.length, level);
  return interval.lower <= 0.5 && interval.upper >= 0.5 ? "ok" : "judging_biased";
}

export interface SweepLevel<T extends string = string> {
  level: T;
  lower: number;
  usdPerSuccess: number | null;
  incumbent?: boolean;
}

export interface SweepSelection<T extends string = string> {
  winner: T;
  reason: "quality_win" | "cheapest_admissible" | "incumbent";
}

/** Quality wins outrank cost; otherwise cost may choose only among non-inferior levels. */
export function selectSweepWinner<T extends string>(
  levels: readonly SweepLevel<T>[],
  margin: number = DEFAULT_EVAL_STATISTICS.noninferiorityMargin,
): SweepSelection<T> {
  if (!Number.isFinite(margin) || margin < 0 || margin > 0.5) {
    throw new Error("margin must be finite and between 0 and 0.5");
  }
  const incumbents = levels.filter((row) => row.incumbent === true);
  if (incumbents.length !== 1) throw new Error("sweep must contain exactly one incumbent level");
  const incumbent = incumbents[0]!;
  for (const row of levels) {
    if (!Number.isFinite(row.lower) || row.lower < 0 || row.lower > 1) throw new Error("lower must be in [0, 1]");
    if (row.usdPerSuccess !== null && (!Number.isFinite(row.usdPerSuccess) || row.usdPerSuccess < 0)) {
      throw new Error("usdPerSuccess must be null or a non-negative finite number");
    }
  }

  const quality = levels.filter((row) => !row.incumbent && row.lower > 0.5);
  if (quality.length > 0) {
    const bestLower = Math.max(...quality.map((row) => row.lower));
    const best = quality.filter((row) => row.lower === bestLower);
    if (best.length === 1) return { winner: best[0]!.level, reason: "quality_win" };
    return { winner: incumbent.level, reason: "incumbent" };
  }

  if (incumbent.usdPerSuccess === null) return { winner: incumbent.level, reason: "incumbent" };
  const comparable = [
    incumbent,
    ...levels.filter((row) => !row.incumbent && row.lower >= 0.5 - margin && row.usdPerSuccess !== null),
  ];
  const cheapest = Math.min(...comparable.map((row) => row.usdPerSuccess!));
  const best = comparable.filter((row) => row.usdPerSuccess === cheapest);
  if (best.length !== 1 || best[0]!.incumbent) return { winner: incumbent.level, reason: "incumbent" };
  return { winner: best[0]!.level, reason: "cheapest_admissible" };
}
