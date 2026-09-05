import type { Metrics } from "../build/metrics";
import type { BudgetConfig, Effort, IdeaShape, Phase, Role } from "../core/config";
import type { StopKind } from "../core/events";
import type { FailureClass } from "../core/failure";
import type { RunOutcome, RunStatus } from "../core/run";
import type { CostBlock } from "../core/cost";
import { gate, type CollapsedJudgedPair, type GateOptions, type GateResult, type GateVerdict, type WilsonInterval } from "./wilson";

/** Shared semantic order: every comparison table must lead with quality and follow with cost. */
export const QUALITY_REPORT_COLUMNS = [
  "pairWinRate",
  "wilson",
  "seedWins",
  "honestExits",
  "featuresPassed.executed",
  "collisionRate",
  "probes.passRate",
] as const;

export const COST_REPORT_COLUMNS = [
  "usdPerSuccess",
  "costUsd",
  "tokensPerSuccess",
  "turnsPerSuccess",
  "cacheReadRatio",
] as const;

/** Report-level evidence provenance printed with every table, normally in its footer. */
export const REPORT_STAMP_COLUMNS = [
  "judgeCalibration.status",
  "n",
  "requiredWins",
  "observedWins",
] as const;

export const REPORT_COLUMNS = [
  ...QUALITY_REPORT_COLUMNS,
  ...COST_REPORT_COLUMNS,
] as const;

export type JudgeCalibrationStatus = "absent" | "stale" | "provisional" | "agent" | "calibrated" | "removed";

export interface JudgeCalibrationHash {
  judgePrompt: string;
  kernelPrompt: string;
  judgeModel: string;
  renderVersion: number;
  effort: Effort;
}

export interface JudgeCalibrationStamp {
  status: JudgeCalibrationStatus;
  agreement?: number;
  orderAgreement?: number;
  labelSource?: "human" | "agent";
  hash?: JudgeCalibrationHash;
  effort?: Effort;
}

export interface EvidenceStamp {
  judgeCalibration: JudgeCalibrationStamp;
  n: number;
  requiredWins: number;
  observedWins: number;
}

/** Translate internal gate terms to the binding serialized report field names. */
export function evidenceStamp(
  result: Pick<GateResult, "n" | "wins" | "required">,
  judgeCalibration: JudgeCalibrationStamp,
): EvidenceStamp {
  return {
    judgeCalibration: { ...judgeCalibration },
    n: result.n,
    requiredWins: result.required,
    observedWins: result.wins,
  };
}

export interface EvalPassReport {
  seeds: number;
  uncensoredSeeds: number;
  pairs: number;
  /** Decisive candidate wins; ties are carried separately. */
  wins: number;
  ties: number;
  /** `(wins + ties / 2) / pairs`. */
  rate: number;
  wilson: WilsonInterval;
  requiredWins: number;
  evidence: boolean;
  seedWins: number;
}

export interface PassReportOptions extends GateOptions {
  seeds: number;
  uncensoredSeeds: number;
  seedWins: number;
}

function nonNegativeCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

/** Construct the exact `eval.json.passes.*` shape from already-collapsed statistical units. */
export function passReport(lines: readonly CollapsedJudgedPair[], options: PassReportOptions): EvalPassReport {
  nonNegativeCount(options.seeds, "seeds");
  nonNegativeCount(options.uncensoredSeeds, "uncensoredSeeds");
  if (options.uncensoredSeeds > options.seeds) throw new Error("uncensoredSeeds cannot exceed seeds");
  if (!Number.isFinite(options.seedWins) || options.seedWins < 0 || options.seedWins > options.seeds) {
    throw new Error("seedWins must be finite and between 0 and seeds");
  }
  const result = gate(lines, options);
  const wins = lines.filter((line) => line.score === 1).length;
  const ties = lines.filter((line) => line.score === 0.5).length;
  return {
    seeds: options.seeds,
    uncensoredSeeds: options.uncensoredSeeds,
    pairs: result.n,
    wins,
    ties,
    rate: result.n === 0 ? 0 : result.wins / result.n,
    wilson: { lower: result.lower, upper: result.upper },
    requiredWins: result.required,
    evidence: result.verdict !== "not_evidence",
    seedWins: options.seedWins,
  };
}

export type EffortSource = "profile" | "swept" | "config" | "fallback";
export interface FrozenEffort { level: Effort; source: EffortSource }
export type FrozenBudgets = Omit<BudgetConfig, "phaseBudgetUsd" | "phaseBudgetWallSeconds">;
export type PairCensorStopKind = Extract<StopKind, "budget" | "deadline" | "transient" | "stalled">;

export interface FrozenEvalConfig {
  k: number;
  sweepPairsPerSeed: number;
  level: number;
  rounds: number;
  minPairs: number;
  minUncensoredSeeds: number;
  noninferiorityMargin: number;
  seating: Record<string, string>;
  effort: Record<string, Partial<Record<Role, FrozenEffort>>>;
  roles: Record<Role, string[]>;
  budgets: FrozenBudgets;
}

/** A staged run row. Pair censoring remains distinct from run-level metrics.censored. */
export interface EvalRunReport {
  runId: string;
  seedId: string;
  split: "dev" | "heldout";
  shape: IdeaShape;
  arm: string;
  state: RunStatus["state"];
  outcome?: RunOutcome;
  stopKind?: StopKind;
  pairCensored: boolean;
  pairCensoredBy: PairCensorStopKind[];
  honestExit?: string;
  failedClass?: FailureClass;
  shapeMismatch: boolean;
  cacheHealthy: boolean | null;
  unhealthyCallsByRole: Partial<Record<Role, number>>;
  /** Present when the eval overrides the ordinary run defaults. */
  runBudgetUsd?: number;
  runWallSeconds?: number;
  metrics: Partial<Metrics>;
  cost: Partial<Record<Phase, CostBlock>>;
}

export type EvalReportVerdict = GateVerdict | "censored" | "incomplete";

/** Binding version-1 report envelope; runner modules own population and persistence. */
export interface EvalReport<TCandidate = unknown> {
  version: 1;
  evalId: string;
  candidateId: string;
  candidate: TCandidate;
  playbookHash: string;
  frozen: FrozenEvalConfig;
  effortSwept: boolean;
  judgeCalibration: JudgeCalibrationStamp;
  startedAt: string;
  updatedAt: string;
  budgetUsd: number;
  costUsd: number;
  runs: EvalRunReport[];
  passes: { dev: EvalPassReport; heldout: EvalPassReport };
  verdict: EvalReportVerdict;
  stoppedEarly?: "lost_dev";
  stoppedReason?: "budget" | "deadline";
  costFlag?: CostWarning;
  gap?: number;
}

export interface CostWarning {
  ratio: number | null;
  flagged: boolean;
}

/** Cost is a warning only. A missing/zero denominator yields null, never Infinity. */
export function costWarning(
  candidateUsdPerSuccess: number | null,
  championUsdPerSuccess: number | null,
  ratioCap = 1.5,
): CostWarning {
  if (!Number.isFinite(ratioCap) || ratioCap <= 0) throw new Error("ratioCap must be a positive finite number");
  for (const value of [candidateUsdPerSuccess, championUsdPerSuccess]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error("usdPerSuccess must be null or a non-negative finite number");
    }
  }
  if (candidateUsdPerSuccess === null || championUsdPerSuccess === null) {
    return { ratio: null, flagged: false };
  }
  const ratio = candidateUsdPerSuccess / championUsdPerSuccess;
  return {
    ratio: Number.isFinite(ratio) ? ratio : null,
    flagged: championUsdPerSuccess === 0 ? candidateUsdPerSuccess > 0 : ratio > ratioCap,
  };
}
