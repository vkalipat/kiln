import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EVAL_STATISTICS,
  admissible,
  gate,
  incumbentSweepStatus,
  requiredWins,
  selectSweepWinner,
  wilson,
  type CollapsedJudgedPair,
} from "../../src/evals/wilson";

function pairs(wins: number, n: number, ties = 0, seeds = 12): CollapsedJudgedPair[] {
  return Array.from({ length: n }, (_, index) => ({
    seedId: `seed-${index % seeds}`,
    score: index < wins ? 1 : index < wins + ties ? 0.5 : 0,
  }));
}

function binomialTail(n: number, p: number, accepted: (wins: number) => boolean): number {
  let probability = (1 - p) ** n;
  let total = accepted(0) ? probability : 0;
  for (let wins = 0; wins < n; wins += 1) {
    probability *= ((n - wins) / (wins + 1)) * (p / (1 - p));
    if (accepted(wins + 1)) total += probability;
  }
  return total;
}

describe("wilson", () => {
  test("matches the pre-registered 95 percent boundaries", () => {
    expect(wilson(31, 48, 0.95).lower).toBeCloseTo(0.50439057, 7);
    expect(wilson(30, 48, 0.95).lower).toBeCloseTo(0.48362764, 7);
    expect(wilson(22, 32, 0.95).lower).toBeCloseTo(0.51433322, 7);
    expect(wilson(17, 24, 0.95).lower).toBeCloseTo(0.50832306, 7);
    expect(wilson(58, 96, 0.95).lower).toBeCloseTo(0.50415112, 7);
  });

  test("uses a neutral interval for an empty sample and rejects invalid inputs", () => {
    expect(wilson(0, 0, 0.95)).toEqual({ lower: 0, upper: 1 });
    expect(() => wilson(-1, 10, 0.95)).toThrow();
    expect(() => wilson(11, 10, 0.95)).toThrow();
    expect(() => wilson(1, 1.5, 0.95)).toThrow();
    expect(() => wilson(1, 2, 1)).toThrow();
  });

  test("prints the exact integer win bars for each pre-registered n", () => {
    expect([24, 32, 48, 96].map((n) => requiredWins(n))).toEqual([17, 22, 31, 58]);
  });
});

describe("gate", () => {
  test("requires 31 of 48, with the configured pair and seed floors", () => {
    const loss = gate(pairs(30, 48), { uncensoredSeeds: 12 });
    const win = gate(pairs(31, 48), { uncensoredSeeds: 12 });
    expect(loss).toEqual({
      n: 48,
      wins: 30,
      required: 31,
      lower: wilson(30, 48, 0.95).lower,
      upper: wilson(30, 48, 0.95).upper,
      verdict: "lose",
    });
    expect(win.verdict).toBe("win");
    expect(win.required).toBe(31);
  });

  test("counts each collapsed tie as half a win", () => {
    const tied = gate(pairs(21, 32, 2, 8), { uncensoredSeeds: 8 });
    expect(tied.wins).toBe(22);
    expect(tied.lower).toBeCloseTo(wilson(22, 32, 0.95).lower, 12);
    expect(tied.verdict).toBe("win");
  });

  test("returns not_evidence whenever either floor is missed", () => {
    const withHonestExits = gate(pairs(17, 24, 0, 6), { uncensoredSeeds: 8 });
    expect(withHonestExits.lower).toBeGreaterThan(0.5);
    expect(withHonestExits).toMatchObject({ n: 24, required: 17, verdict: "not_evidence" });

    const tooFewSeeds = gate(pairs(31, 48, 0, 7), { uncensoredSeeds: 7 });
    expect(tooFewSeeds.verdict).toBe("not_evidence");
  });

  test("derives uncensored seeds from records only when no explicit count is supplied", () => {
    expect(gate(pairs(22, 32, 0, 8)).verdict).toBe("win");
    expect(gate(pairs(22, 32, 0, 7)).verdict).toBe("not_evidence");
  });

  test("requires explicit seed evidence when legacy collapsed outcomes omit seed ids", () => {
    expect(() => gate([{ score: 1 }])).toThrow("uncensoredSeeds is required");
    expect(gate([{ score: 1 }], { uncensoredSeeds: 1 }).verdict).toBe("not_evidence");
  });

  test("uses the pre-registered defaults", () => {
    expect(DEFAULT_EVAL_STATISTICS).toEqual({
      level: 0.95,
      minPairs: 32,
      minUncensoredSeeds: 8,
      noninferiorityMargin: 0.1,
    });
  });
});

describe("effort sweep rule", () => {
  test("uses an inclusive non-inferiority bound and the exact-binomial admission rates", () => {
    const accepts = (wins: number) => admissible(pairs(wins, 96, 0, 12), 0.1);
    expect(accepts(47)).toBe(false);
    expect(accepts(48)).toBe(true);
    expect(binomialTail(96, 0.45, accepts)).toBeCloseTo(0.1886843, 6);
    expect(binomialTail(96, 0.4, accepts)).toBeCloseTo(0.0298864, 6);

    const oldRule = (wins: number) => wins / 48 >= 0.5;
    expect(binomialTail(48, 0.45, oldRule)).toBeCloseTo(0.2898025, 6);
  });

  test("rejects an incumbent A/A cell whose interval excludes parity", () => {
    expect(incumbentSweepStatus(pairs(48, 96))).toBe("ok");
    expect(incumbentSweepStatus(pairs(58, 96))).toBe("judging_biased");
  });

  test("adopts a quality win regardless of cost", () => {
    const result = selectSweepWinner([
      { level: "medium", incumbent: true, lower: 0.45, usdPerSuccess: 1 },
      { level: "low", lower: 0.51, usdPerSuccess: 100 },
      { level: "high", lower: 0.49, usdPerSuccess: 0.1 },
    ]);
    expect(result).toEqual({ winner: "low", reason: "quality_win" });
  });

  test("otherwise chooses the cheapest admissible level and keeps incumbent on ties", () => {
    expect(selectSweepWinner([
      { level: "medium", incumbent: true, lower: 0.45, usdPerSuccess: 2 },
      { level: "low", lower: 0.41, usdPerSuccess: 1 },
      { level: "high", lower: 0.3, usdPerSuccess: 0.5 },
    ])).toEqual({ winner: "low", reason: "cheapest_admissible" });

    expect(selectSweepWinner([
      { level: "medium", incumbent: true, lower: 0.45, usdPerSuccess: 1 },
      { level: "low", lower: 0.41, usdPerSuccess: 1 },
    ])).toEqual({ winner: "medium", reason: "incumbent" });
  });
});
