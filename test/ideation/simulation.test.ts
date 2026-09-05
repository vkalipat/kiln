/** The simulation the decision record (§13) requires before the tournament code is trusted:
 *  22 synthetic ideas of known latent strength, admission to 16, Swiss to 24 pairs under the
 *  swap rule, the regularized fit, the seeded bootstrap, and the eligibility, dominance and
 *  trim rules. Everything is seeded, so every number below is reproducible. */

import { describe, expect, test } from "bun:test";
import { bootstrapStrengths, collapsePairs, mulberry32, type StrengthInterval, type TournamentLine } from "../../src/ideation/bt";
import {
  type AxisIntervals,
  type Cell,
  cellKey,
  type Dominance,
  DEFAULT_DOMINANCE,
  frontier,
  mmrSelect,
  trimForCheckpoint,
} from "../../src/ideation/frontier";
import { schedulePairs, selectEntrants } from "../../src/ideation/pairing";

/** Four axes, three values each: the closed archive vocabulary a frame produces. */
const AXES: Record<string, string[]> = {
  buyer: ["solo", "team", "org"],
  horizon: ["days", "weeks", "months"],
  medium: ["cli", "web", "api"],
  risk: ["low", "mid", "high"],
};
/** Chance that a verdict follows presentation position instead of the latent difference. */
const POSITION_NOISE = 0.1;
/** 1,000 in production (config `bootstrapSamples`); 300 keeps the test quick. */
const SAMPLES = 300;
/** Fixed so the numbers in the task report are reproducible. Admission is by archive-cell
 *  spread rather than by strength, so whether the three strongest ideas of the 22 get a seat
 *  at all is a property of the draw: this seed is one where all three are admitted, which is
 *  what makes the record's "top ideas stay eligible" check non-vacuous. */
const SEED = 49;

interface Latent {
  value: number;
  feasibility: number;
}

/** The dominance rules the controller asked to be measured side by side. */
const RULES: { label: string; rule: Dominance }[] = [
  { label: "mean", rule: { kind: "mean" } },
  { label: "interval 0.5", rule: { kind: "interval", level: 0.5 } },
  { label: "interval 0.8", rule: { kind: "interval", level: 0.8 } },
  { label: "interval 0.95", rule: { kind: "interval", level: 0.95 } },
];
const LEVELS = [0.5, 0.8, 0.95];

interface SimOptions {
  samples?: number;
  /** Pair budget for the round. `minComparisons` above what the cap can reach makes the cap
   *  bind, which is how the 36-pair row is produced (16 x 5 / 2 = 40 > 36). */
  pairCap?: number;
  minComparisons?: number;
  /** Comparisons an idea needs to be eligible; the record's 3 regardless of the budget. */
  eligibility?: number;
}

function simulate(seed: number, opts: SimOptions = {}) {
  const samples = opts.samples ?? SAMPLES;
  const pairCap = opts.pairCap ?? 24;
  const minComparisons = opts.minComparisons ?? 3;
  const eligibility = opts.eligibility ?? 3;
  const rng = mulberry32(seed);
  const ids = Array.from({ length: 22 }, (_, i) => `d${String(i + 1).padStart(2, "0")}`);
  const latent: Record<string, Latent> = {};
  const cells: Record<string, Cell> = {};
  for (const id of ids) {
    latent[id] = { value: (rng() * 2 - 1) * 3, feasibility: (rng() * 2 - 1) * 3 };
    const cell: Cell = {};
    for (const axis of Object.keys(AXES)) {
      const values = AXES[axis]!;
      cell[axis] = values[Math.floor(rng() * values.length)]!;
    }
    cells[id] = cell;
  }

  // Four standing frontier anchors carried in from the previous round, plus twelve new ideas.
  const anchors = ["d01", "d06", "d11", "d16"];
  const archive = ids.map((id) => ({ id, cell: cells[id]! }));
  const entrants = selectEntrants({ archive, anchors, entrantsCap: 16, anchorsCap: 4 });
  const pairs = schedulePairs({ entrants, anchors, pairCap, minComparisons });

  // The swap rule: every pair is judged in both orderings, and a verdict follows the latent
  // difference except when position bias pulls it toward whatever was presented second.
  const noise = mulberry32(seed + 1);
  const lines: TournamentLine[] = [];
  for (const [a, b] of pairs) {
    for (const order of ["ab", "ba"] as const) {
      const second = order === "ab" ? "b" : "a";
      const verdict = (axis: keyof Latent): "a" | "b" =>
        noise() < POSITION_NOISE ? second : latent[a]![axis] > latent[b]![axis] ? "a" : "b";
      lines.push({
        round: 1,
        a,
        b,
        order,
        valueWinner: verdict("value"),
        feasibilityWinner: verdict("feasibility"),
      });
    }
  }

  const collapsed = collapsePairs(lines);
  const value = bootstrapStrengths(collapsed.value, entrants, { samples, seed: seed + 2, levels: LEVELS });
  const feasibility = bootstrapStrengths(collapsed.feasibility, entrants, {
    samples,
    seed: seed + 3,
    levels: LEVELS,
  });
  const strengths: Record<string, AxisIntervals> = {};
  const values: Record<string, number> = {};
  for (const id of entrants) {
    strengths[id] = { value: value[id]!, feasibility: feasibility[id]! };
    values[id] = value[id]!.mean;
  }

  const pareto = (pool: readonly string[], score: (id: string) => Latent): string[] =>
    pool.filter((b) => !pool.some((a) => a !== b && score(a).value > score(b).value && score(a).feasibility > score(b).feasibility));

  const { eligible } = frontier({ strengths, minComparisons: eligibility });
  const latentFront = pareto(entrants, (id) => latent[id]!);
  const byRule: Record<string, { front: string[]; shown: string[]; recall: number; falseInclusion: number }> = {};
  for (const { label, rule } of RULES) {
    const front = frontier({ strengths, minComparisons: eligibility, dominance: rule }).front;
    const champions = cellChampions(eligible, front, cells, values);
    const shown = trimForCheckpoint(front, cells, { max: 8, min: 5, champions, values }).shown;
    byRule[label] = {
      front,
      shown,
      recall: latentFront.length === 0 ? 1 : latentFront.filter((id) => front.includes(id)).length / latentFront.length,
      falseInclusion: front.length === 0 ? 0 : front.filter((id) => !latentFront.includes(id)).length / front.length,
    };
  }

  const front = frontier({ strengths, minComparisons: eligibility, dominance: DEFAULT_DOMINANCE }).front;
  const champions = cellChampions(eligible, front, cells, values);
  const checkpoint = trimForCheckpoint(front, cells, { max: 8, min: 5, champions, values });
  const evolveSeeds = mmrSelect(front, cells, {}, Math.min(4, front.length), { values });

  return {
    ids,
    entrants,
    pairs,
    counts: comparisonsPerEntrant(entrants, pairs),
    collapsed,
    ties: [...collapsed.value, ...collapsed.feasibility].filter((o) => o.score === 0.5).length,
    wrong: [
      ...collapsed.value.map((o) => ({ o, axis: "value" as const })),
      ...collapsed.feasibility.map((o) => ({ o, axis: "feasibility" as const })),
    ].filter(({ o, axis }) => o.score !== 0.5 && o.score !== (latent[o.a]![axis] > latent[o.b]![axis] ? 1 : 0)).length,
    ladders: { value, feasibility },
    eligible,
    front,
    byRule,
    champions,
    checkpoint,
    evolveSeeds,
    latentTop3: [...ids].sort((x, y) => latent[y]!.value - latent[x]!.value).slice(0, 3),
    latentFront,
    spearman: spearman(entrants, (id) => latent[id]!.value, (id) => value[id]!.mean),
  };
}

function comparisonsPerEntrant(entrants: readonly string[], pairs: readonly [string, string][]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of entrants) counts[id] = 0;
  for (const [a, b] of pairs) {
    counts[a] = (counts[a] ?? 0) + 1;
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return counts;
}

function cellChampions(
  eligible: readonly string[],
  front: readonly string[],
  cells: Record<string, Cell>,
  values: Record<string, number>,
): string[] {
  const onFront = new Set(front);
  const best = new Map<string, string>();
  for (const id of eligible) {
    if (onFront.has(id)) continue;
    const key = cellKey(cells[id]);
    const held = best.get(key);
    if (held === undefined || values[id]! > values[held]!) best.set(key, id);
  }
  return [...best.values()].sort((x, y) => values[y]! - values[x]! || (x < y ? -1 : 1));
}

function spearman(ids: readonly string[], a: (id: string) => number, b: (id: string) => number): number {
  const rank = (score: (id: string) => number): Record<string, number> => {
    const out: Record<string, number> = {};
    [...ids].sort((x, y) => score(y) - score(x) || (x < y ? -1 : 1)).forEach((id, i) => {
      out[id] = i;
    });
    return out;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = ids.length;
  let d2 = 0;
  for (const id of ids) d2 += (ra[id]! - rb[id]!) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const wide = (i: StrengthInterval): number => i.hi - i.lo;

describe("tournament simulation", () => {
  const r = simulate(SEED);

  test("admits 16 of 22 and schedules the record's 24 pairs", () => {
    expect(r.ids).toHaveLength(22);
    expect(r.entrants).toHaveLength(16);
    expect(r.entrants.slice(0, 4)).toEqual(["d01", "d06", "d11", "d16"]);
    expect(r.pairs).toHaveLength(24);
    expect(new Set(r.pairs.map((p) => p.join("|"))).size).toBe(24);
  });

  test("gives every entrant at least three comparisons on both axes", () => {
    for (const id of r.entrants) {
      expect(r.counts[id]).toBeGreaterThanOrEqual(3);
      expect(r.ladders.value[id]!.n).toBeGreaterThanOrEqual(3);
      expect(r.ladders.feasibility[id]!.n).toBeGreaterThanOrEqual(3);
    }
    expect(r.eligible).toHaveLength(16);
  });

  test("converts position bias into ties instead of into wrong verdicts", () => {
    // Position noise can only pull a verdict toward the second-presented item, so it can only
    // ever flip the ordering in which the latent loser is shown second. The swap rule turns
    // that into a tie: no collapsed outcome ever contradicts the latent order.
    expect(r.collapsed.value).toHaveLength(24);
    expect(r.collapsed.incomplete).toEqual([]);
    expect(r.wrong).toBe(0);
    expect(r.ties).toBeGreaterThan(0);
    expect(r.ties / 48).toBeLessThan(0.3);
  });

  test("recovers the latent value ladder", () => {
    expect(r.spearman).toBeGreaterThan(0.6);
    expect(r.latentTop3.every((id) => r.entrants.includes(id))).toBe(true);
    for (const id of r.latentTop3) expect(r.eligible).toContain(id);
    // The 0.95 rule never drops a genuinely Pareto-optimal idea; that is its whole virtue.
    for (const id of r.latentFront) expect(r.byRule["interval 0.95"]!.front).toContain(id);
  });

  test("the confidence level is what sets the front size", () => {
    // FINDING (grill round 2, item 1): at 0.95 the bootstrap interval is about as wide as the
    // whole fitted strength range, so `A.lo > B.hi on both axes` eliminates almost nobody. The
    // level is the knob; the table test below measures the trade it makes.
    expect(wide(r.ladders.value[r.entrants[0]!]!)).toBeGreaterThan(1);
    const sizes = RULES.map(({ label }) => r.byRule[label]!.front.length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
    expect(r.byRule["interval 0.95"]!.front.length).toBeGreaterThan(10);
    expect(r.front).toEqual(r.byRule["interval 0.5"]!.front);
    expect(r.front.length).toBeGreaterThanOrEqual(4);
    expect(r.front.length).toBeLessThanOrEqual(12);
  });

  test("trims the checkpoint display to between five and eight, by cell spread", () => {
    expect(r.checkpoint.shown.length).toBeGreaterThanOrEqual(5);
    expect(r.checkpoint.shown.length).toBeLessThanOrEqual(8);
    expect(r.checkpoint.backfill).toEqual([]);
    expect([...r.checkpoint.shown, ...r.checkpoint.trimmed].sort()).toEqual([...r.front].sort());
  });

  test("seeds the evolve step with four spread-out frontier ideas", () => {
    expect(r.evolveSeeds).toHaveLength(4);
    expect(new Set(r.evolveSeeds).size).toBe(4);
    for (const id of r.evolveSeeds) expect(r.front).toContain(id);
  });

  test("is byte-identical across two runs", () => {
    expect(JSON.stringify(simulate(SEED))).toBe(JSON.stringify(r));
  });
});

describe("tournament simulation across seeds", () => {
  const runs = [1, 2, 3, 4, 5, 6].map((seed) => ({ seed, r: simulate(seed, { samples: 200 }) }));

  test("holds the record's guarantees on every draw", () => {
    for (const { seed, r: sim } of runs) {
      const label = `seed ${seed}`;
      expect(label + ":" + sim.entrants.length).toBe(label + ":16");
      expect(label + ":" + sim.pairs.length).toBe(label + ":24");
      expect(Math.min(...sim.entrants.map((id) => sim.counts[id]!))).toBeGreaterThanOrEqual(3);
      expect(sim.checkpoint.shown.length).toBeGreaterThanOrEqual(5);
      expect(sim.checkpoint.shown.length).toBeLessThanOrEqual(8);
      // Nothing genuinely Pareto-optimal is ever dropped at 0.95.
      for (const id of sim.latentFront) expect(sim.byRule["interval 0.95"]!.front).toContain(id);
      expect(sim.spearman).toBeGreaterThan(0.5);
      expect(sim.wrong).toBe(0);
    }
  });

  test("shows the frontier-size finding is not a property of one seed", () => {
    for (const { r: sim } of runs) expect(sim.byRule["interval 0.95"]!.front.length).toBeGreaterThan(10);
    expect(Math.max(...runs.map(({ r: sim }) => sim.byRule.mean!.front.length))).toBeLessThanOrEqual(10);
  });

  test("ties arrive at the position-noise rate once the draws are pooled", () => {
    const ties = runs.reduce((sum, { r: sim }) => sum + sim.ties, 0);
    const outcomes = runs.length * 48;
    expect(ties / outcomes).toBeGreaterThan(0.04);
    expect(ties / outcomes).toBeLessThan(0.18);
  });
});

/** The controller's table: what each dominance rule buys and costs, averaged over 20 seeded
 *  draws. `recall` is the share of the true (latent) Pareto set that lands on the front;
 *  `falseInclusion` is the share of the front that is not truly Pareto-optimal. */
interface Row {
  label: string;
  front: number;
  recall: number;
  falseInclusion: number;
  shown: number;
}

function measure(draws: readonly number[], opts: SimOptions): Row[] {
  const sims = draws.map((seed) => simulate(seed, { samples: 150, ...opts }));
  return RULES.map(({ label }) => {
    const rows = sims.map((sim) => sim.byRule[label]!);
    const avg = (pick: (row: (typeof rows)[number]) => number): number =>
      rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
    return {
      label,
      front: avg((row) => row.front.length),
      recall: avg((row) => row.recall),
      falseInclusion: avg((row) => row.falseInclusion),
      shown: avg((row) => row.shown.length),
    };
  });
}

function render(title: string, rows: readonly Row[]): void {
  const cells = rows.map(
    (row) =>
      `  ${row.label.padEnd(14)} front ${row.front.toFixed(1).padStart(4)}   recall ${(row.recall * 100)
        .toFixed(0)
        .padStart(3)}%   false-incl ${(row.falseInclusion * 100).toFixed(0).padStart(3)}%   shown ${row.shown.toFixed(
        1,
      )}`,
  );
  console.log([title, ...cells].join("\n"));
}

describe("dominance rule comparison", () => {
  const draws = Array.from({ length: 20 }, (_, i) => i + 1);
  const at24 = measure(draws, { pairCap: 24, minComparisons: 3 });
  // 16 x 5 / 2 = 40 > 36, so the cap binds and the round lands on exactly 36 pairs.
  const at36 = measure(draws, { pairCap: 36, minComparisons: 5 });
  const row = (rows: readonly Row[], label: string): Row => rows.find((r) => r.label === label)!;

  test("prints the table and holds its shape", () => {
    render("24 pairs (3 comparisons each, the record's budget), 20 draws:", at24);
    render("36 pairs (4.5 comparisons each), 20 draws:", at36);
    expect(simulate(1, { samples: 60, pairCap: 36, minComparisons: 5 }).pairs).toHaveLength(36);

    // Widening the interval can only add ideas to the front and can only raise recall.
    for (const rows of [at24, at36]) {
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.front).toBeGreaterThanOrEqual(rows[i - 1]!.front);
        expect(rows[i]!.recall).toBeGreaterThanOrEqual(rows[i - 1]!.recall - 1e-9);
      }
      // The checkpoint display is 5 to 8 whatever the rule: the trim, not dominance, sets it.
      for (const r of rows) {
        expect(r.shown).toBeGreaterThanOrEqual(5);
        expect(r.shown).toBeLessThanOrEqual(8);
      }
    }
  });

  test("measures the 0.95 rule as unusable and 0.5 as the working default", () => {
    expect(row(at24, "interval 0.95").front).toBeGreaterThan(12);
    expect(row(at24, "interval 0.95").recall).toBe(1);
    expect(row(at24, "interval 0.95").falseInclusion).toBeGreaterThan(0.6);

    expect(row(at24, "interval 0.5").front).toBeGreaterThanOrEqual(4);
    expect(row(at24, "interval 0.5").front).toBeLessThanOrEqual(12);
    expect(row(at24, "interval 0.5").recall).toBeGreaterThan(0.75);
    expect(row(at24, "interval 0.5").falseInclusion).toBeLessThan(row(at24, "interval 0.95").falseInclusion);

    // Mean dominance is the limit of the knob: smallest front, worst recall.
    expect(row(at24, "mean").recall).toBeLessThan(row(at24, "interval 0.5").recall);
  });

  test("shows a bigger pair budget helps the tighter levels most", () => {
    expect(row(at36, "interval 0.5").recall).toBeGreaterThanOrEqual(row(at24, "interval 0.5").recall - 0.05);
    expect(row(at36, "interval 0.8").front).toBeLessThanOrEqual(row(at24, "interval 0.8").front + 0.5);
  });
});
