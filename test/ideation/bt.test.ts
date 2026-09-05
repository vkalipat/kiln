import { describe, expect, test } from "bun:test";
import {
  bootstrapStrengths,
  collapsePairs,
  comparisonCounts,
  fitBradleyTerry,
  mulberry32,
  normalQuantile,
  priorInterval,
  type TournamentLine,
} from "../../src/ideation/bt";

const line = (over: Partial<TournamentLine> & Pick<TournamentLine, "a" | "b" | "order">): TournamentLine => ({
  round: 1,
  valueWinner: "a",
  feasibilityWinner: "a",
  ...over,
});

describe("normalQuantile", () => {
  test("matches the standard normal quantiles the prior interval needs", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963985, 7);
    expect(normalQuantile(0.9)).toBeCloseTo(1.281551566, 7);
    expect(normalQuantile(0.75)).toBeCloseTo(0.674489750, 7);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963985, 7);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232306, 6);
  });
});

describe("mulberry32", () => {
  test("is deterministic for a seed and stays in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 20 }, () => a());
    const second = Array.from({ length: 20 }, () => b());
    expect(first).toEqual(second);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  test("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("fitBradleyTerry", () => {
  test("ranks a consistent winner above the loser, symmetrically around zero", () => {
    const theta = fitBradleyTerry(
      [
        { a: "x", b: "y", score: 1 },
        { a: "x", b: "y", score: 1 },
        { a: "x", b: "y", score: 1 },
      ],
      ["x", "y"],
      {},
    );
    expect(theta.x).toBeGreaterThan(0);
    expect(theta.y).toBeLessThan(0);
    expect(theta.x! + theta.y!).toBeCloseTo(0, 9);
  });
  test("puts everything at zero when every outcome is a tie", () => {
    const theta = fitBradleyTerry(
      [
        { a: "x", b: "y", score: 0.5 },
        { a: "y", b: "z", score: 0.5 },
      ],
      ["x", "y", "z"],
      {},
    );
    for (const id of ["x", "y", "z"]) expect(theta[id]).toBeCloseTo(0, 9);
  });
  test("leaves an uncompared id at the prior of zero", () => {
    const theta = fitBradleyTerry([{ a: "x", b: "y", score: 1 }], ["x", "y", "lonely"], {});
    expect(theta.lonely).toBe(0);
  });
  test("orders a transitive chain", () => {
    const theta = fitBradleyTerry(
      [
        { a: "a", b: "b", score: 1 },
        { a: "b", b: "c", score: 1 },
        { a: "a", b: "c", score: 1 },
      ],
      ["a", "b", "c"],
      {},
    );
    expect(theta.a).toBeGreaterThan(theta.b!);
    expect(theta.b).toBeGreaterThan(theta.c!);
  });
  test("shrinks harder with a larger lambda", () => {
    const outcomes = [
      { a: "x", b: "y", score: 1 as const },
      { a: "x", b: "y", score: 1 as const },
    ];
    const weak = fitBradleyTerry(outcomes, ["x", "y"], { lambda: 0.01 });
    const strong = fitBradleyTerry(outcomes, ["x", "y"], { lambda: 2 });
    expect(weak.x).toBeGreaterThan(strong.x!);
  });
  test("honors outcome weights", () => {
    const plain = fitBradleyTerry([{ a: "x", b: "y", score: 1 }], ["x", "y"], {});
    const heavy = fitBradleyTerry([{ a: "x", b: "y", score: 1, weight: 3 }], ["x", "y"], {});
    expect(heavy.x).toBeGreaterThan(plain.x!);
  });
  test("ignores outcomes whose endpoints are not being fit", () => {
    const theta = fitBradleyTerry(
      [
        { a: "x", b: "y", score: 1 },
        { a: "x", b: "ghost", score: 0 },
      ],
      ["x", "y"],
      {},
    );
    expect(theta.x).toBeGreaterThan(0);
    expect(Object.keys(theta)).toEqual(["x", "y"]);
  });
  test("is byte-identical across repeat calls", () => {
    const outcomes = [
      { a: "a", b: "b", score: 1 as const },
      { a: "b", b: "c", score: 0.5 as const },
      { a: "a", b: "c", score: 0 as const },
    ];
    const one = JSON.stringify(fitBradleyTerry(outcomes, ["a", "b", "c"], {}));
    const two = JSON.stringify(fitBradleyTerry(outcomes, ["a", "b", "c"], {}));
    expect(one).toBe(two);
  });
});

describe("collapsePairs", () => {
  test("collapses agreeing orderings into a decisive outcome", () => {
    const out = collapsePairs([
      line({ a: "x", b: "y", order: "ab", valueWinner: "a", feasibilityWinner: "b" }),
      line({ a: "x", b: "y", order: "ba", valueWinner: "a", feasibilityWinner: "b" }),
    ]);
    expect(out.value).toEqual([{ a: "x", b: "y", score: 1, weight: 1 }]);
    expect(out.feasibility).toEqual([{ a: "x", b: "y", score: 0, weight: 1 }]);
    expect(out.incomplete).toEqual([]);
  });
  test("collapses a swap disagreement into a tie", () => {
    const out = collapsePairs([
      line({ a: "x", b: "y", order: "ab", valueWinner: "a" }),
      line({ a: "x", b: "y", order: "ba", valueWinner: "b" }),
    ]);
    expect(out.value[0]!.score).toBe(0.5);
  });
  test("drops a pair that has only one ordering and reports it", () => {
    const out = collapsePairs([line({ a: "x", b: "y", order: "ab" })]);
    expect(out.value).toEqual([]);
    expect(out.incomplete).toEqual([{ round: 1, a: "x", b: "y" }]);
  });
  test("weights human lines above judge lines", () => {
    const out = collapsePairs([
      line({ a: "x", b: "y", order: "ab", source: "human" }),
      line({ a: "x", b: "y", order: "ba", source: "human" }),
    ]);
    expect(out.value[0]!.weight).toBe(3);
  });
  test("keeps separate rounds separate and sorts outcomes by (round, a, b)", () => {
    const lines: TournamentLine[] = [
      line({ round: 2, a: "m", b: "n", order: "ab" }),
      line({ round: 2, a: "m", b: "n", order: "ba" }),
      line({ round: 1, a: "x", b: "y", order: "ba" }),
      line({ round: 1, a: "x", b: "y", order: "ab" }),
      line({ round: 1, a: "a", b: "b", order: "ab" }),
      line({ round: 1, a: "a", b: "b", order: "ba" }),
    ];
    const out = collapsePairs(lines);
    expect(out.value.map((o) => `${o.a}-${o.b}`)).toEqual(["a-b", "x-y", "m-n"]);
    const shuffled = collapsePairs([...lines].reverse());
    expect(JSON.stringify(shuffled.value)).toBe(JSON.stringify(out.value));
  });
  test("collapses each axis on its own: a tie on one axis leaves the other decisive", () => {
    // The regression this locks: a line tied on feasibility used to delete the pair's value
    // comparison too, and pushed its sibling ordering into `incomplete`.
    const out = collapsePairs([
      line({ a: "p", b: "q", order: "ab", valueWinner: "a", feasibilityWinner: "tie" }),
      line({ a: "p", b: "q", order: "ba", valueWinner: "a", feasibilityWinner: "b" }),
    ]);
    expect(out.incomplete).toEqual([]);
    expect(out.value).toEqual([{ a: "p", b: "q", score: 1, weight: 1 }]);
    expect(out.feasibility[0]!.score).toBe(0.5);
  });
  test("a tie on both orderings of an axis is half a win, not a dropped pair", () => {
    const out = collapsePairs([
      line({ a: "x", b: "y", order: "ab", valueWinner: "tie", feasibilityWinner: "tie" }),
      line({ a: "x", b: "y", order: "ba", valueWinner: "tie", feasibilityWinner: "tie" }),
    ]);
    expect(out.value).toEqual([{ a: "x", b: "y", score: 0.5, weight: 1 }]);
    expect(out.feasibility[0]!.score).toBe(0.5);
    expect(out.incomplete).toEqual([]);
  });
  test("a human best-worst line keeps its decisive axis at the human weight", () => {
    // §0: checkpoint best-worst answers are appended with source "human" and refit at 3x. Such an
    // answer is decisive on one axis and silent on the other; the silent axis must not eat it.
    const out = collapsePairs([
      line({ a: "p", b: "q", order: "ab", valueWinner: "b", feasibilityWinner: "tie", source: "human" }),
      line({ a: "p", b: "q", order: "ba", valueWinner: "b", feasibilityWinner: "tie", source: "human" }),
    ]);
    expect(out.value).toEqual([{ a: "p", b: "q", score: 0, weight: 3 }]);
    expect(out.feasibility).toEqual([{ a: "p", b: "q", score: 0.5, weight: 3 }]);
  });
  test("ignores a duplicated log line", () => {
    const out = collapsePairs([
      line({ a: "x", b: "y", order: "ab" }),
      line({ a: "x", b: "y", order: "ab" }),
      line({ a: "x", b: "y", order: "ba" }),
    ]);
    expect(out.value).toHaveLength(1);
  });
});

describe("comparisonCounts", () => {
  test("counts collapsed comparisons per id, not weight", () => {
    const counts = comparisonCounts(
      [
        { a: "x", b: "y", score: 1, weight: 3 },
        { a: "x", b: "z", score: 0 },
      ],
      ["x", "y", "z", "idle"],
    );
    expect(counts).toEqual({ x: 2, y: 1, z: 1, idle: 0 });
  });
});

describe("bootstrapStrengths", () => {
  const outcomes = [
    { a: "a", b: "b", score: 1 as const },
    { a: "a", b: "c", score: 1 as const },
    { a: "b", b: "c", score: 1 as const },
    { a: "a", b: "d", score: 1 as const },
    { a: "b", b: "d", score: 1 as const },
    { a: "c", b: "d", score: 1 as const },
  ];
  test("brackets the mean and orders the ladder", () => {
    const r = bootstrapStrengths(outcomes, ["a", "b", "c", "d"], { samples: 200, seed: 7 });
    for (const id of ["a", "b", "c", "d"]) {
      expect(r[id]!.lo).toBeLessThanOrEqual(r[id]!.mean);
      expect(r[id]!.mean).toBeLessThanOrEqual(r[id]!.hi);
      expect(r[id]!.n).toBe(3);
    }
    expect(r.a!.mean).toBeGreaterThan(r.d!.mean);
  });
  test("gives an uncompared idea n 0 and the prior interval, at every level asked for", () => {
    const r = bootstrapStrengths(outcomes, ["a", "b", "c", "d", "ghost"], {
      samples: 50,
      seed: 7,
      lambda: 0.1,
      levels: [0.5],
    });
    const wide = priorInterval(0.1);
    const narrow = priorInterval(0.1, 0.5);
    expect(r.ghost).toEqual({
      mean: 0,
      lo: -wide,
      hi: wide,
      n: 0,
      intervals: { "0.5": { lo: -narrow, hi: narrow }, "0.95": { lo: -wide, hi: wide } },
    });
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(wide);
  });
  test("reports every level asked for, always including 0.95, nested inside the wider ones", () => {
    const r = bootstrapStrengths(outcomes, ["a", "b", "c", "d"], { samples: 300, seed: 7, levels: [0.8, 0.5] });
    const a = r.a!;
    expect(Object.keys(a.intervals!)).toEqual(["0.5", "0.8", "0.95"]);
    expect(a.lo).toBe(a.intervals!["0.95"]!.lo);
    expect(a.hi).toBe(a.intervals!["0.95"]!.hi);
    expect(a.intervals!["0.5"]!.lo).toBeGreaterThan(a.intervals!["0.8"]!.lo);
    expect(a.intervals!["0.8"]!.lo).toBeGreaterThan(a.intervals!["0.95"]!.lo);
    expect(a.intervals!["0.5"]!.hi).toBeLessThan(a.intervals!["0.8"]!.hi);
    expect(a.intervals!["0.8"]!.hi).toBeLessThan(a.intervals!["0.95"]!.hi);
    expect(a.intervals!["0.5"]!.lo).toBeLessThanOrEqual(a.mean);
    expect(a.intervals!["0.5"]!.hi).toBeGreaterThanOrEqual(a.mean);
  });
  test("defaults to reporting the frontier's 0.5 level and the compatibility 0.95 pair", () => {
    const r = bootstrapStrengths(outcomes, ["a", "b"], { samples: 20, seed: 1 });
    expect(Object.keys(r.a!.intervals!)).toEqual(["0.5", "0.95"]);
  });
  test("is byte-identical for the same seed and differs for another", () => {
    const one = JSON.stringify(bootstrapStrengths(outcomes, ["a", "b", "c", "d"], { samples: 64, seed: 11 }));
    const two = JSON.stringify(bootstrapStrengths(outcomes, ["a", "b", "c", "d"], { samples: 64, seed: 11 }));
    const other = JSON.stringify(bootstrapStrengths(outcomes, ["a", "b", "c", "d"], { samples: 64, seed: 12 }));
    expect(one).toBe(two);
    expect(one).not.toBe(other);
  });
  test("narrows the interval as evidence accumulates", () => {
    const thin = bootstrapStrengths([{ a: "a", b: "b", score: 1 }], ["a", "b"], { samples: 200, seed: 3 });
    const thick = bootstrapStrengths(
      Array.from({ length: 12 }, () => ({ a: "a", b: "b", score: 1 as const })),
      ["a", "b"],
      { samples: 200, seed: 3 },
    );
    expect(thick.a!.mean).toBeGreaterThan(thin.a!.mean);
  });
  test("conditions an idea's interval on replicates that actually drew it", () => {
    // Sixteen ideas, twenty-four comparisons, three per idea: the record's own tournament
    // geometry (16 x 3 / 2 = 24) at the minComparisons floor. A replicate then draws none of a
    // given idea's comparisons (1 - 3/24)^24 = 4.1% of the time, above the 2.5% tail. Counting
    // those replicates pins lo at exactly 0 for the strongest idea and hi at exactly 0 for the
    // weakest, so `A.lo > B.hi` can never hold: interval dominance degenerates to "everything
    // is on the frontier".
    const ring = Array.from({ length: 16 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    const sparse = [
      ...Array.from({ length: 16 }, (_, i) => [i, (i + 1) % 16] as const),
      ...Array.from({ length: 8 }, (_, i) => [i, i + 8] as const),
    ].map(([x, y]) => ({ a: ring[Math.min(x, y)]!, b: ring[Math.max(x, y)]!, score: 1 }));
    const conditioned = bootstrapStrengths(sparse, ring, { samples: 400, seed: 5 });
    const naive = bootstrapStrengths(sparse, ring, { samples: 400, seed: 5, conditionOnObserved: false });
    expect(conditioned.e00!.n).toBe(3);
    expect(conditioned.e00!.lo).toBeGreaterThan(0);
    expect(conditioned.e15!.hi).toBeLessThan(0);
    expect(naive.e00!.lo).toBe(0);
    expect(naive.e15!.hi).toBe(0);
  });
  test("honors weights in the resampled fit", () => {
    const plain = bootstrapStrengths([{ a: "a", b: "b", score: 1 }], ["a", "b"], { samples: 100, seed: 9 });
    const heavy = bootstrapStrengths([{ a: "a", b: "b", score: 1, weight: 3 }], ["a", "b"], {
      samples: 100,
      seed: 9,
    });
    expect(heavy.a!.mean).toBeGreaterThan(plain.a!.mean);
    expect(heavy.a!.n).toBe(1);
  });
});
