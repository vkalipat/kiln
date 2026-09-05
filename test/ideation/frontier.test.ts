import { describe, expect, test } from "bun:test";
import type { StrengthInterval } from "../../src/ideation/bt";
import {
  type AxisIntervals,
  type Cell,
  cellDistance,
  cellKey,
  frontier,
  mmrSelect,
  trimForCheckpoint,
} from "../../src/ideation/frontier";

// Level-agnostic: every level gets the same bounds, so a test says what it means about
// dominance without also picking a confidence level.
const iv = (mean: number, spread: number, n = 3): StrengthInterval => ({
  mean,
  lo: mean - spread,
  hi: mean + spread,
  n,
  intervals: Object.fromEntries([0.5, 0.8, 0.95].map((l) => [String(l), { lo: mean - spread, hi: mean + spread }])),
});
const both = (value: StrengthInterval, feasibility: StrengthInterval): AxisIntervals => ({ value, feasibility });

describe("cellKey and cellDistance", () => {
  test("cellKey is axis-order independent", () => {
    expect(cellKey({ b: "2", a: "1" })).toBe(cellKey({ a: "1", b: "2" }));
    expect(cellKey({ a: "1", b: "2" })).toBe("a=1|b=2");
  });
  test("cellKey passes a string key through and maps a missing cell to the empty key", () => {
    expect(cellKey("already-a-key")).toBe("already-a-key");
    expect(cellKey(undefined)).toBe("");
  });
  test("cellDistance counts axes whose values differ, over the union of axes", () => {
    const a: Cell = { medium: "web", buyer: "solo", horizon: "weeks", risk: "low" };
    expect(cellDistance(a, a)).toBe(0);
    expect(cellDistance(a, { ...a, risk: "high" })).toBe(1);
    expect(cellDistance(a, { medium: "cli", buyer: "team", horizon: "weeks", risk: "low" })).toBe(2);
    expect(cellDistance(a, { medium: "web" })).toBe(3);
    expect(cellDistance(undefined, undefined)).toBe(0);
  });
});

describe("frontier", () => {
  test("keeps only ideas with enough comparisons on both axes", () => {
    const r = frontier({
      strengths: {
        ok: both(iv(1, 0.2, 3), iv(1, 0.2, 4)),
        thinValue: both(iv(1, 0.2, 2), iv(1, 0.2, 5)),
        thinFeas: both(iv(1, 0.2, 9), iv(1, 0.2, 1)),
        never: both(iv(0, 6, 0), iv(0, 6, 0)),
      },
      minComparisons: 3,
    });
    expect(r.eligible).toEqual(["ok"]);
    expect(r.front).toEqual(["ok"]);
  });
  test("drops an idea dominated on both axes and keeps one dominated on a single axis", () => {
    const r = frontier({
      strengths: {
        strong: both(iv(3, 0.5), iv(3, 0.5)),
        weak: both(iv(-3, 0.5), iv(-3, 0.5)),
        lopsided: both(iv(-3, 0.5), iv(4, 0.5)),
      },
      minComparisons: 3,
    });
    expect(r.eligible.sort()).toEqual(["lopsided", "strong", "weak"]);
    expect(r.front).toEqual(["lopsided", "strong"].sort((x, y) => (x === "strong" ? -1 : 1)));
    expect(r.front).not.toContain("weak");
  });
  test("requires strict separation: overlapping intervals dominate nothing", () => {
    const r = frontier({
      strengths: {
        hi: both(iv(1, 2), iv(1, 2)),
        lo: both(iv(-1, 2), iv(-1, 2)),
      },
      minComparisons: 3,
    });
    expect(r.front.sort()).toEqual(["hi", "lo"]);
  });
  test("an ineligible idea neither dominates nor is dominated", () => {
    const r = frontier({
      strengths: {
        good: both(iv(3, 0.2), iv(3, 0.2)),
        unmeasured: both(iv(0, 6, 0), iv(0, 6, 0)),
        beaten: both(iv(-3, 0.2), iv(-3, 0.2)),
      },
      minComparisons: 3,
    });
    expect(r.eligible).toEqual(["good", "beaten"]);
    expect(r.front).toEqual(["good"]);
  });
  test("a narrower confidence level dominates more, and mean dominance is the limit", () => {
    const spread = (level: number, half: number) => ({ [String(level)]: { lo: -half, hi: half } });
    const at = (mean: number, wide: number, narrow: number, n = 3): StrengthInterval => ({
      mean,
      lo: mean - wide,
      hi: mean + wide,
      n,
      intervals: {
        "0.95": { lo: mean - wide, hi: mean + wide },
        "0.5": { lo: mean - narrow, hi: mean + narrow },
      },
    });
    const strengths = { hi: both(at(1, 2, 0.2), at(1, 2, 0.2)), lo: both(at(-1, 2, 0.2), at(-1, 2, 0.2)) };
    expect(frontier({ strengths, minComparisons: 3, dominance: { kind: "interval", level: 0.95 } }).front.sort()).toEqual(["hi", "lo"]);
    expect(frontier({ strengths, minComparisons: 3, dominance: { kind: "interval", level: 0.5 } }).front).toEqual(["hi"]);
    expect(frontier({ strengths, minComparisons: 3, dominance: { kind: "mean" } }).front).toEqual(["hi"]);
    expect(spread(0.5, 1)["0.5"]!.hi).toBe(1);
  });
  test("defaults to the 0.5 interval rule", () => {
    const at = (mean: number): StrengthInterval => ({
      mean,
      lo: mean - 3,
      hi: mean + 3,
      n: 3,
      intervals: { "0.95": { lo: mean - 3, hi: mean + 3 }, "0.5": { lo: mean - 0.1, hi: mean + 0.1 } },
    });
    const strengths = { hi: both(at(1), at(1)), lo: both(at(-1), at(-1)) };
    expect(frontier({ strengths, minComparisons: 3 }).front).toEqual(["hi"]);
  });
  test("refuses to answer at a level the strengths do not carry", () => {
    const strengths = { a: both(iv(1, 1), iv(1, 1)) };
    expect(() => frontier({ strengths, minComparisons: 3, dominance: { kind: "interval", level: 0.9 } })).toThrow(
      /no 0.9 interval/,
    );
    // The flat lo/hi pair still answers a 0.95 request from a hand-built interval.
    const flat: StrengthInterval = { mean: 0, lo: -1, hi: 1, n: 3 };
    expect(
      frontier({ strengths: { a: both(flat, flat) }, minComparisons: 3, dominance: { kind: "interval", level: 0.95 } })
        .front,
    ).toEqual(["a"]);
  });
  test("orders eligible and front by value mean, then id", () => {
    const r = frontier({
      strengths: {
        b: both(iv(1, 3), iv(0, 3)),
        a: both(iv(1, 3), iv(0, 3)),
        c: both(iv(2, 3), iv(0, 3)),
      },
      minComparisons: 3,
    });
    expect(r.front).toEqual(["c", "a", "b"]);
  });
});

const cells: Record<string, Cell> = {
  a1: { m: "web", b: "solo" },
  a2: { m: "web", b: "solo" },
  a3: { m: "web", b: "solo" },
  b1: { m: "cli", b: "solo" },
  b2: { m: "cli", b: "solo" },
  c1: { m: "web", b: "team" },
  d1: { m: "cli", b: "team" },
  e1: { m: "cli", b: "solo" },
};

describe("trimForCheckpoint", () => {
  test("passes a front that is already in range straight through", () => {
    const r = trimForCheckpoint(["a1", "b1", "c1", "d1", "a2"], cells, { max: 8, min: 5 });
    expect(r.shown).toEqual(["a1", "b1", "c1", "d1", "a2"]);
    expect(r.backfill).toEqual([]);
    expect(r.trimmed).toEqual([]);
  });
  test("trims to max by cell spread, one per cell before a second from any cell", () => {
    const front = ["a1", "a2", "a3", "b1", "b2", "c1", "d1"];
    const r = trimForCheckpoint(front, cells, { max: 4, min: 3 });
    expect(r.shown).toHaveLength(4);
    expect(new Set(r.shown.map((id) => cellKey(cells[id]))).size).toBe(4);
    expect(r.shown).toEqual(["a1", "b1", "c1", "d1"]);
    expect(r.trimmed).toEqual(["a2", "a3", "b2"]);
    expect([...r.shown, ...r.trimmed].sort()).toEqual([...front].sort());
  });
  test("takes a second from a cell only once every cell has one", () => {
    const r = trimForCheckpoint(["a1", "a2", "a3", "b1"], cells, { max: 3, min: 3 });
    expect(r.shown).toEqual(["a1", "b1", "a2"]);
  });
  test("backfills from champions, marked separately, when the front is under min", () => {
    const r = trimForCheckpoint(["a1", "b1"], cells, { max: 8, min: 5, champions: ["c1", "a1", "d1", "b2", "a2"] });
    expect(r.shown).toEqual(["a1", "b1", "c1", "d1", "b2"]);
    expect(r.backfill).toEqual(["c1", "d1", "b2"]);
    expect(r.trimmed).toEqual([]);
  });
  test("backfills only as far as the champions reach", () => {
    const r = trimForCheckpoint(["a1"], cells, { max: 8, min: 5, champions: ["b1"] });
    expect(r.shown).toEqual(["a1", "b1"]);
    expect(r.backfill).toEqual(["b1"]);
  });
  test("is deterministic", () => {
    const front = ["a1", "a2", "a3", "b1", "b2", "c1", "d1"];
    const one = JSON.stringify(trimForCheckpoint(front, cells, { max: 5, min: 5 }));
    const two = JSON.stringify(trimForCheckpoint(front, cells, { max: 5, min: 5 }));
    expect(one).toBe(two);
  });
});

describe("mmrSelect", () => {
  const values = { a1: 1, a2: 0.9, a3: 0.8, b1: 0.5, c1: 0.4, d1: 0.3 };
  test("takes the most valuable idea first, then trades value against cell distance", () => {
    // Same cell as the leader: a2 has to be clearly better to beat a candidate from another cell.
    const close = { a1: 1, a2: 0.55, b1: 0.5 };
    expect(mmrSelect(["a1", "a2", "b1"], cells, {}, 2, { values: close })).toEqual(["a1", "b1"]);
    const wide = { a1: 1, a2: 0.9, b1: 0 };
    expect(mmrSelect(["a1", "a2", "b1"], cells, {}, 2, { values: wide })).toEqual(["a1", "a2"]);
  });
  test("respects k and never returns more than the front holds", () => {
    expect(mmrSelect(["a1", "b1"], cells, {}, 4, { values })).toHaveLength(2);
    expect(mmrSelect(["a1", "a2", "b1", "c1"], cells, {}, 3, { values })).toHaveLength(3);
  });
  test("breaks a cell-distance tie by lower trigram Jaccard similarity", () => {
    // c1 and e1 are both one axis away from a1, so only the Jaccard tie-break separates them.
    const flat = { a1: 1, c1: 0.5, e1: 0.5 };
    expect(cellDistance(cells.a1, cells.c1)).toBe(cellDistance(cells.a1, cells.e1));
    expect(mmrSelect(["a1", "c1", "e1"], cells, { a1: { c1: 0.9, e1: 0.1 } }, 2, { values: flat })).toEqual([
      "a1",
      "e1",
    ]);
    expect(mmrSelect(["a1", "c1", "e1"], cells, { a1: { c1: 0.1, e1: 0.9 } }, 2, { values: flat })).toEqual([
      "a1",
      "c1",
    ]);
  });
  test("accepts a similarity function as well as a table", () => {
    const picks = mmrSelect(["a1", "c1", "e1"], cells, (x, y) => (x === "c1" || y === "c1" ? 0.9 : 0.1), 2, {
      values: { a1: 1, c1: 0.5, e1: 0.5 },
    });
    expect(picks).toEqual(["a1", "e1"]);
  });
  test("falls back to front order when no values are supplied", () => {
    expect(mmrSelect(["b1", "a1", "a2"], cells, {}, 2)).toEqual(["b1", "a1"]);
  });
  test("is deterministic and handles an empty front", () => {
    expect(mmrSelect([], cells, {}, 4)).toEqual([]);
    const one = mmrSelect(["a1", "a2", "b1", "c1", "d1"], cells, {}, 4, { values });
    const two = mmrSelect(["a1", "a2", "b1", "c1", "d1"], cells, {}, 4, { values });
    expect(one).toEqual(two);
  });
});
