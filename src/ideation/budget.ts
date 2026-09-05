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
export function projectedRoundCost(cfg: KilnConfig, models: ModelResolver): RoundCostProjection {
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
  const mixedIslandCost = strongIslands * callCost(generator, TOKENS.island.input, TOKENS.island.output)
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
    row("prior-art scouts", capacity, scout, TOKENS.scout),
    row("collision verdicts", Math.min(capacity, cfg.ideation.arbiterCaps.collision), arbiter, TOKENS.arbiter),
    row("probe decision", 1, brain, TOKENS.brain),
    row("probe writers", capacity, prober, TOKENS.probe),
    row("criteria", 1, judge, TOKENS.criteria),
    row("tournament orderings", cfg.ideation.pairCap * 2, judge, TOKENS.judge),
    row("meta-review", 1, judge, TOKENS.meta),
  ];
  return {
    rows,
    calls: rows.reduce((sum, item) => sum + item.calls, 0),
    costUsd: rows.reduce((sum, item) => sum + item.costUsd, 0),
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
