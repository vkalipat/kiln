import { describe, expect, test } from "bun:test";
import { schedulePairs, selectEntrants } from "../../src/ideation/pairing";

const countsOf = (pairs: [string, string][]): Record<string, number> => {
  const c: Record<string, number> = {};
  for (const [a, b] of pairs) {
    c[a] = (c[a] ?? 0) + 1;
    c[b] = (c[b] ?? 0) + 1;
  }
  return c;
};

describe("selectEntrants", () => {
  const archive = {
    "m=cli": ["c1", "c2", "c3", "c4"],
    "m=web": ["w1", "w2"],
    "m=api": ["a1", "a2", "a3"],
  };
  test("seats anchors first, in the given order, up to anchorsCap", () => {
    const picked = selectEntrants({ archive, anchors: ["w2", "c4", "a3", "c1", "a1"], entrantsCap: 6, anchorsCap: 3 });
    expect(picked.slice(0, 3)).toEqual(["w2", "c4", "a3"]);
    expect(picked).toHaveLength(6);
  });
  test("fills with new ideas round-robin across cells in sorted cell order", () => {
    const picked = selectEntrants({ archive, anchors: [], entrantsCap: 6, anchorsCap: 4 });
    expect(picked).toEqual(["a1", "c1", "w1", "a2", "c2", "w2"]);
  });
  test("never seats an anchor twice", () => {
    const picked = selectEntrants({ archive, anchors: ["c1"], entrantsCap: 4, anchorsCap: 4 });
    expect(picked).toEqual(["c1", "a1", "c2", "w1"]);
    expect(new Set(picked).size).toBe(picked.length);
  });
  test("stops at entrantsCap and tolerates a cap larger than the archive", () => {
    expect(selectEntrants({ archive, anchors: [], entrantsCap: 2, anchorsCap: 4 })).toEqual(["a1", "c1"]);
    expect(selectEntrants({ archive, anchors: [], entrantsCap: 99, anchorsCap: 4 })).toHaveLength(9);
  });
  test("accepts an entry list with axis-map cells", () => {
    const picked = selectEntrants({
      archive: [
        { id: "x1", cell: { m: "cli", b: "solo" } },
        { id: "y1", cell: { b: "solo", m: "web" } },
        { id: "x2", cell: { m: "cli", b: "solo" } },
      ],
      anchors: [],
      entrantsCap: 3,
      anchorsCap: 4,
    });
    expect(picked).toEqual(["x1", "y1", "x2"]);
  });
  test("is deterministic", () => {
    const one = selectEntrants({ archive, anchors: ["w2"], entrantsCap: 5, anchorsCap: 4 });
    const two = selectEntrants({ archive, anchors: ["w2"], entrantsCap: 5, anchorsCap: 4 });
    expect(one).toEqual(two);
  });
});

describe("schedulePairs", () => {
  test("plays a full round robin for a small field", () => {
    const entrants = ["a", "b", "c", "d"];
    const pairs = schedulePairs({ entrants, pairCap: 24, minComparisons: 3 });
    expect(pairs).toHaveLength(6);
    expect(new Set(pairs.map((p) => p.join("|"))).size).toBe(6);
    for (const id of entrants) expect(countsOf(pairs)[id]).toBe(3);
  });
  test("emits each pair with its ids in canonical order", () => {
    const pairs = schedulePairs({ entrants: ["z", "a", "m"], pairCap: 24, minComparisons: 2 });
    for (const [a, b] of pairs) expect(a < b).toBe(true);
  });
  test("switches to Swiss above six entrants and fills the record's 16 x 3 / 2 budget", () => {
    const entrants = Array.from({ length: 16 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    const pairs = schedulePairs({ entrants, pairCap: 24, minComparisons: 3 });
    expect(pairs).toHaveLength(24);
    expect(new Set(pairs.map((p) => p.join("|"))).size).toBe(24);
    const counts = countsOf(pairs);
    for (const id of entrants) expect(counts[id]).toBe(3);
  });
  test("guarantees minComparisons whenever pairCap >= ceil(n * min / 2)", () => {
    for (let n = 2; n <= 24; n++) {
      for (const min of [2, 3, 4]) {
        const entrants = Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, "0")}`);
        const pairCap = Math.ceil((n * min) / 2);
        const pairs = schedulePairs({ entrants, pairCap, minComparisons: min });
        const counts = countsOf(pairs);
        expect(pairs.length).toBeLessThanOrEqual(pairCap);
        const reachable = n > min; // a field of n can give each idea at most n-1 distinct partners
        if (reachable) {
          for (const id of entrants) expect(counts[id] ?? 0).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });
  test("never repeats a pair already in the log", () => {
    const entrants = Array.from({ length: 8 }, (_, i) => `e${i}`);
    const existing: [string, string][] = [
      ["e0", "e1"],
      ["e2", "e3"],
    ];
    const pairs = schedulePairs({ entrants, existing, pairCap: 12, minComparisons: 3 });
    const seen = new Set(pairs.map((p) => p.join("|")));
    expect(seen.has("e0|e1")).toBe(false);
    expect(seen.has("e2|e3")).toBe(false);
    expect(seen.size).toBe(pairs.length);
  });
  test("counts existing comparisons toward the minimum", () => {
    const entrants = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const existing = [
      { a: "a", b: "b" },
      { a: "a", b: "c" },
      { a: "a", b: "d" },
    ];
    const pairs = schedulePairs({ entrants, existing, pairCap: 24, minComparisons: 1 });
    expect(countsOf(pairs).a ?? 0).toBe(0);
  });
  test("pairs by strength proximity in the opening round", () => {
    const entrants = ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7"];
    const strengths = { e0: 8, e1: 7, e2: 6, e3: 5, e4: 4, e5: 3, e6: 2, e7: 1 };
    const pairs = schedulePairs({ entrants, strengths, pairCap: 4, minComparisons: 3 });
    expect(pairs).toEqual([
      ["e0", "e1"],
      ["e2", "e3"],
      ["e4", "e5"],
      ["e6", "e7"],
    ]);
  });
  test("prefers a mixed pair over pitting two anchors against each other", () => {
    const entrants = ["a1", "a2", "n1", "n2", "n3", "n4", "n5", "n6"];
    const strengths = { a1: 1, a2: 1, n1: 1, n2: 1, n3: 1, n4: 1, n5: 1, n6: 1 };
    const pairs = schedulePairs({
      entrants,
      anchors: ["a1", "a2"],
      strengths,
      pairCap: 12,
      minComparisons: 3,
    });
    const anchorOnly = pairs.filter(([x, y]) => x.startsWith("a") && y.startsWith("a"));
    expect(anchorOnly).toEqual([]);
  });
  test("stops at the cap and returns nothing when there is nothing to schedule", () => {
    const entrants = Array.from({ length: 10 }, (_, i) => `e${i}`);
    expect(schedulePairs({ entrants, pairCap: 5, minComparisons: 3 })).toHaveLength(5);
    expect(schedulePairs({ entrants, pairCap: 0, minComparisons: 3 })).toEqual([]);
    expect(schedulePairs({ entrants: ["only"], pairCap: 10, minComparisons: 3 })).toEqual([]);
    expect(schedulePairs({ entrants: [], pairCap: 10, minComparisons: 3 })).toEqual([]);
  });
  test("is byte-identical across runs and independent of the entrant array order", () => {
    const entrants = Array.from({ length: 16 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    const strengths = Object.fromEntries(entrants.map((id, i) => [id, (i % 5) - 2]));
    const input = { entrants, strengths, pairCap: 24, minComparisons: 3 };
    expect(JSON.stringify(schedulePairs(input))).toBe(JSON.stringify(schedulePairs(input)));
    const shuffled = { ...input, entrants: [...entrants].reverse() };
    expect(JSON.stringify(schedulePairs(shuffled))).toBe(JSON.stringify(schedulePairs(input)));
  });
});
