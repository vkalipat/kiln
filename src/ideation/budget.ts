import type { Model } from "@oh-my-pi/pi-catalog";
import type { KilnConfig, Role } from "../core/config";
import type { StoredEvent } from "../core/events";

export interface ProjectionRow {
  name: string;
  calls: number;
  costUsd: number;
}

export interface RoundCostProjection {
  rows: ProjectionRow[];
  calls: number;
  costUsd: number;
}

export interface AdaptiveRoundProjection extends RoundCostProjection {
  /** Planning estimate with stage concurrency and explicit slack; not a completion guarantee. */
  estimatedWallSeconds: number;
  /** Wall estimate before the stated slack multiplier. */
  baseWallSeconds: number;
}

/**
 * Initial latency assumptions for adaptive portfolio sizing. The scout figure is grounded in the
 * 2026-09-09 diagnostic's roughly 7–8 second median Opus scout turns plus a small retrieval
 * allowance. No completed live ideation round exists yet, so every value remains an engineering
 * assumption to replace with stage telemetry rather than a measured service-level guarantee.
 */
export const ADAPTIVE_LATENCY_SECONDS = {
  islandAttempt: 40,
  scoutTurn: 10,
  producerDecision: 14,
  reviewerDecision: 8,
  stageSlackMultiplier: 1.25,
  costHeadroomMultiplier: 1.1,
} as const;

export interface RoundCostOptions {
  /** Resolved assignment for this round; when present its exact model mix prices island turns. */
  islandPlans?: readonly { model: Model }[];
}

export type ModelResolver = (role: Role) => { model: Model; ref: string };

/** Project one provider call from catalog list prices (rates are dollars per million tokens). */
function callCost(model: Model, input: number, output: number): number {
  return (input * model.cost.input + output * model.cost.output) / 1_000_000;
}

/** The planning assumptions are intentionally explicit. The first paid end-to-end run replaces
 *  them; until then they make the floor conservative without pretending to be measurements. */
const TOKENS = {
  island: { input: 3_000, output: 4_000 },
  arbiter: { input: 1_500, output: 250 },
  scout: { input: 4_000, output: 1_500 },
  probe: { input: 2_000, output: 700 },
  brain: { input: 5_000, output: 400 },
  judge: { input: 5_000, output: 400 },
  criteria: { input: 3_000, output: 500 },
  meta: { input: 4_000, output: 500 },
} as const;

/** Calls and dollars for the record §3 minimum viable round, at the configured seats. */
export function projectedRoundCost(cfg: KilnConfig, models: ModelResolver, opts: RoundCostOptions = {}): RoundCostProjection {
  const capacity = cfg.ideation.islands * cfg.ideation.ideasPerBatch * 2;
  const cheapIslands = cfg.ideation.cheapIsland && cfg.ideation.islands > 0 ? 1 : 0;
  const strongIslands = cfg.ideation.islands - cheapIslands;
  const generator = models("generator").model;
  const cheap = models("prober").model;
  const arbiter = models("arbiter").model;
  const scout = models("scout").model;
  const prober = models("prober").model;
  const brain = models("brain").model;
  const judge = models("judge").model;
  const mixedIslandCost = opts.islandPlans
    ? opts.islandPlans.reduce((sum, plan) => sum + callCost(plan.model, TOKENS.island.input, TOKENS.island.output), 0)
    : strongIslands * callCost(generator, TOKENS.island.input, TOKENS.island.output)
      + cheapIslands * callCost(cheap, TOKENS.island.input, TOKENS.island.output);
  const row = (name: string, calls: number, model: Model, usage: { input: number; output: number }): ProjectionRow => ({
    name,
    calls,
    costUsd: calls * callCost(model, usage.input, usage.output),
  });
  const rows: ProjectionRow[] = [
    { name: "island first batches", calls: cfg.ideation.islands, costUsd: mixedIslandCost },
    { name: "island second batches", calls: cfg.ideation.islands, costUsd: mixedIslandCost },
    row("novelty tie-breaks", cfg.ideation.arbiterCaps.novelty, arbiter, TOKENS.arbiter),
    // A successful scout necessarily calls a retrieval tool and then synthesizes its findings.
    row("prior-art scouts", capacity * 2, scout, TOKENS.scout),
    row("collision verdicts", Math.min(capacity, cfg.ideation.arbiterCaps.collision), arbiter, TOKENS.arbiter),
    // The selector reads the supplied dossiers, then makes its terminal probe_request decision.
    row("probe decision", 2, brain, TOKENS.brain),
    row("probe writers", capacity, prober, TOKENS.probe),
    row("criteria", 1, judge, TOKENS.criteria),
    row("tournament orderings", Math.min(cfg.ideation.pairCap, cfg.ideation.entrantsCap * (cfg.ideation.entrantsCap - 1) / 2) * 2, judge, TOKENS.judge),
    row("meta-review", 1, judge, TOKENS.meta),
  ];
  return {
    rows,
    calls: rows.reduce((sum, item) => sum + item.calls, 0),
    costUsd: rows.reduce((sum, item) => sum + item.costUsd, 0),
  };
}

/**
 * Adaptive-only planning envelope. Unlike the historical preview above, dollar rows include the
 * bounded correction attempts where modeled: two attempts per generated batch,
 * decision/probe/criteria/judge unit, and every configured prior-art scout turn. Probe selection,
 * token sizes, and wall latency remain planning assumptions rather than a financial reservation or
 * completion guarantee, so execution's durable dollar/deadline guards remain authoritative.
 */
export function projectedAdaptiveRound(cfg: KilnConfig, models: ModelResolver): AdaptiveRoundProjection {
  const capacity = cfg.ideation.islands * cfg.ideation.ideasPerBatch * 2;
  const entrants = Math.min(capacity, cfg.ideation.entrantsCap);
  const pairUnits = Math.min(cfg.ideation.pairCap, entrants * (entrants - 1) / 2);
  const noveltyUnits = Math.min(capacity, cfg.ideation.arbiterCaps.novelty);
  const collisionUnits = Math.min(capacity, cfg.ideation.arbiterCaps.collision);
  const cheapIslands = cfg.ideation.cheapIsland && cfg.ideation.islands > 0 ? 1 : 0;
  const strongIslands = cfg.ideation.islands - cheapIslands;
  const generator = models("generator").model;
  const cheap = models("prober").model;
  const arbiter = models("arbiter").model;
  const scout = models("scout").model;
  const prober = models("prober").model;
  const brain = models("brain").model;
  const judge = models("judge").model;
  const islandAttemptCost = strongIslands * callCost(generator, TOKENS.island.input, TOKENS.island.output)
    + cheapIslands * callCost(cheap, TOKENS.island.input, TOKENS.island.output);
  const row = (name: string, calls: number, model: Model, usage: { input: number; output: number }): ProjectionRow => ({
    name, calls, costUsd: calls * callCost(model, usage.input, usage.output),
  });
  const rows: ProjectionRow[] = [
    // Two batches per island, with one bounded correction attempt for each batch.
    { name: "island batches with correction reserve", calls: cfg.ideation.islands * 4, costUsd: islandAttemptCost * 4 },
    row("novelty decisions with correction reserve", noveltyUnits * 2, arbiter, TOKENS.arbiter),
    row("prior-art scout turn reserve", capacity * cfg.ideation.scoutTurnCap, scout, TOKENS.scout),
    row("collision decisions with correction reserve", collisionUnits * 2, arbiter, TOKENS.arbiter),
    row("probe selection", 2, brain, TOKENS.brain),
    row("probe writers with correction reserve", capacity * 2, prober, TOKENS.probe),
    row("criteria with correction reserve", 2, judge, TOKENS.criteria),
    // Every pair is judged AB and BA; each ordering has one bounded retry.
    row("tournament orderings with correction reserve", pairUnits * 4, judge, TOKENS.judge),
    row("meta-review", 1, judge, TOKENS.meta),
  ];

  const lanes = Math.max(1, cfg.ideation.concurrency);
  const waves = (units: number): number => Math.ceil(units / lanes);
  const latency = ADAPTIVE_LATENCY_SECONDS;
  // Wall sizing follows the successful stage path. Dollar rows above reserve explicit retries;
  // retry wall risk is represented by stageSlackMultiplier rather than called a worst-case bound.
  const baseWallSeconds =
    waves(cfg.ideation.islands) * 2 * latency.islandAttempt
    + noveltyUnits * latency.reviewerDecision
    + waves(capacity) * cfg.ideation.scoutTurnCap * latency.scoutTurn
    + waves(collisionUnits) * latency.reviewerDecision
    + 2 * latency.producerDecision
    + waves(capacity) * latency.producerDecision
    + latency.reviewerDecision
    // phases/ideate.ts runs pairs sequentially; AB and BA overlap only when the limiter has room.
    + pairUnits * Math.ceil(2 / lanes) * latency.reviewerDecision
    + latency.reviewerDecision;
  return {
    rows,
    calls: rows.reduce((sum, item) => sum + item.calls, 0),
    costUsd: rows.reduce((sum, item) => sum + item.costUsd, 0),
    baseWallSeconds,
    estimatedWallSeconds: baseWallSeconds * latency.stageSlackMultiplier,
  };
}

/** Spend attributable to ideate. The first ideate phase.start is the stable resume boundary. */
export function ideateSpentUsd(events: readonly StoredEvent[]): number {
  const start = events.find((event) => event.t === "phase.start" && event.phase === "ideate")?.seq;
  if (start === undefined) return 0;
  return events.reduce((sum, event) => sum + (event.seq > start && event.t === "model.call" ? event.costUsd : 0), 0);
}

/** Task 8 consumes only ideate's allocated share. Cross-phase roll-forward is defined later. */
export function remainingIdeateUsd(cfg: KilnConfig, events: readonly StoredEvent[]): number {
  return cfg.budgets.phaseBudgetUsd("ideate") - ideateSpentUsd(events);
}
