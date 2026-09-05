import { describe, expect, test } from "bun:test";
import { printM1Report, printM2Report } from "../../src/cli/evals-output";
import type { M1ArmMetrics, M1Report } from "../../src/evals/m1";
import type { M2Report } from "../../src/evals/m2";

function output(): { io: { write(text: string): void }; text(): string } {
  const lines: string[] = [];
  return { io: { write: (text) => lines.push(text) }, text: () => lines.join("") };
}

function arm(frontier: [number, number, number], values: Partial<M1ArmMetrics> = {}): M1ArmMetrics {
  return {
    frontier: { raw: frontier[0], shown: frontier[1], backfilled: frontier[2] },
    collisionRate: 0.125, probePassRate: 0.75, usdPerSuccess: 1.25, costUsd: 5,
    tokensPerSuccess: 1200, turnsPerSuccess: 3.5, cacheReadRatio: 0.4, ...values,
  };
}

describe("evaluation text reports", () => {
  test("M1 prints every seed row with quality before cost and complete evidence footers", () => {
    const report = {
      evalId: "m1-fixture", status: "incomplete", stoppedReason: "budget", costUsd: 42.5,
      arms: ["A0", "B0"], effortSwept: false, effortSweptByArm: { A0: true, B0: false },
      judgeCalibration: { status: "agent" },
      comparisons: [{
        id: "A0-vs-B0", a: "A0", b: "B0",
        rows: [
          {
            seed: "heldout-research-01", shape: "research", pairCensored: false, pairCensoredBy: [],
            pairs: [{ seedId: "heldout-research-01", score: 1 }, { seedId: "heldout-research-01", score: 0.5 }, { seedId: "heldout-research-01", score: 0 }],
            judgeCostUsd: 0.1, aMetrics: arm([6, 4, 1]), bMetrics: arm([10, 10, 0], { collisionRate: 0.25, probePassRate: null, usdPerSuccess: null }),
          },
          {
            seed: "heldout-product-01", shape: "product", pairCensored: true, pairCensoredBy: ["deadline"], note: "pairCensored:deadline",
            pairs: [], judgeCostUsd: 0, aMetrics: arm([5, 3, 0]), bMetrics: arm([9, 9, 0]),
          },
        ],
        summary: {
          seeds: 2, uncensoredSeeds: 1, pairs: 3, n: 3, wins: 1, ties: 1, rate: 0.5,
          wilson: { lower: 0.2, upper: 0.8 }, requiredWins: 3, evidence: false, seedWins: 0.5,
          pairCensored: 1, honestExits: { B0: 1 }, failed: { verify: 1 }, seedRate: 0.5,
          perShape: { research: 0.5, product: null, creative: null }, prediction: "not evidence", kill: "not evidence",
        },
      }],
    } as unknown as M1Report;
    const captured = output(); printM1Report(captured.io, report); const text = captured.text();

    for (const expected of [
      "heldout-research-01", "heldout-product-01", "6/4/1", "10/10/0", "1/1/1",
      "pairCensored", "deadline", "collisionRate A0/B0", "probePassRate A0/B0",
      "usdPerSuccess A0/B0", "tokensPerSuccess A0/B0", "turnsPerSuccess A0/B0", "cacheReadRatio A0/B0",
      "pairWinRate: 0.5000; interval: [0.2000, 0.8000]", "n: 3; requiredWins: 3; observedWins: 1.5000",
      "seedRate: 0.5000 (0.5000/1; seeds=2; pairCensored=1)",
      "perShape: research=0.5000, product=-, creative=-", "prediction: not evidence; kill: not evidence",
      "judgeCalibration.status: agent", "effortSwept: false (A0=true, B0=false)",
      "total cost: $42.5000", "status: incomplete (budget)",
    ]) expect(text).toContain(expected);
    expect(text.indexOf("collisionRate A0/B0")).toBeLessThan(text.indexOf("usdPerSuccess A0/B0"));
  });

  test("M2 labels paired censorship and prints build quality, cost, pressure, exits and provenance", () => {
    const cost = (usd: number, successes: number) => ({
      usd, tokens: 100, turns: 2, successes, usdPerSuccess: usd / successes,
      tokensPerSuccess: 100 / successes, turnsPerSuccess: 2 / successes,
      cacheReadRatio: 0.5, cacheWrite: 0, reasoningTokens: 0,
    });
    const run = (armName: "fresh" | "single_session", executed: number, usd: number, exit?: "cannot_be_satisfied" | "not_formable") => ({
      arm: armName, outcome: exit ? { kind: "honest_exit", exitKind: exit, reasons: [exit] } : { kind: "success" },
      metrics: {
        featuresPassed: { executed, humanVerified: 0 }, cost: { build: cost(usd, executed) },
        contextPressureByArm: { fresh: armName === "fresh" ? 1 : 0, single_session: armName === "single_session" ? 2 : 0 },
        honestExits: { total: exit ? 1 : 0 },
      },
    });
    const report = {
      evalId: "m2-fixture", status: "complete", costUsd: 19,
      projectsRequested: 1, projection: { perSeedPair: { expectedUsd: 10, ceilingUsd: 20 }, expectedUsd: 10, ceilingUsd: 20 },
      judgeCalibration: { status: "calibrated" }, effortSwept: true, effortSweptByArm: { fresh: true, single_session: true },
      projects: [{
        seedId: "dev-product-01", shape: "product", pairCensored: true, pairCensoredBy: ["stalled"],
        fresh: run("fresh", 3, 4, "cannot_be_satisfied"), singleSession: run("single_session", 2, 5, "not_formable"),
      }],
    } as unknown as M2Report;
    const captured = output(); printM2Report(captured.io, report); const text = captured.text();

    for (const expected of [
      "pairCensored", "pairCensoredBy", "stalled", "featuresPassed.executed fresh/single_session", "3/2",
      "contextPressure fresh/single_session", "1/2", "cannot_be_satisfied/not_formable",
      "cost.build.usdPerSuccess fresh/single_session", "$1.3333/$2.5000", "cost.build.usd fresh/single_session", "$4.0000/$5.0000",
      "projection per project: expected=$10.0000, ceiling=$20.0000", "projection total: expected=$10.0000, ceiling=$20.0000",
      "status: complete", "judgeCalibration.status: calibrated", "effortSwept: true (fresh=true, single_session=true)", "total cost: $19.0000",
    ]) expect(text).toContain(expected);
    expect(text.indexOf("featuresPassed.executed")).toBeLessThan(text.indexOf("cost.build.usdPerSuccess"));
  });
});
