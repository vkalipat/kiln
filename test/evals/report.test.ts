import { describe, expect, test } from "bun:test";
import {
  COST_REPORT_COLUMNS,
  QUALITY_REPORT_COLUMNS,
  REPORT_COLUMNS,
  REPORT_STAMP_COLUMNS,
  costWarning,
  evidenceStamp,
  passReport,
} from "../../src/evals/report";

describe("REPORT_COLUMNS", () => {
  test("keeps quality before cost and keeps report-level evidence stamps separate", () => {
    expect(QUALITY_REPORT_COLUMNS).toEqual([
      "pairWinRate",
      "wilson",
      "seedWins",
      "honestExits",
      "featuresPassed.executed",
      "collisionRate",
      "probes.passRate",
    ]);
    expect(COST_REPORT_COLUMNS).toEqual([
      "usdPerSuccess",
      "costUsd",
      "tokensPerSuccess",
      "turnsPerSuccess",
      "cacheReadRatio",
    ]);
    expect(REPORT_STAMP_COLUMNS).toEqual([
      "judgeCalibration.status",
      "n",
      "requiredWins",
      "observedWins",
    ]);
    expect(REPORT_COLUMNS).toEqual([...QUALITY_REPORT_COLUMNS, ...COST_REPORT_COLUMNS]);
  });
});

describe("report evidence primitives", () => {
  test("maps the internal gate names to the binding report fields", () => {
    const judgeCalibration = {
      status: "calibrated" as const,
      agreement: 0.8,
      labelSource: "human" as const,
      hash: { judgePrompt: "jp", kernelPrompt: "kp", judgeModel: "m", renderVersion: 1, effort: "medium" as const },
    };
    expect(evidenceStamp({ n: 48, wins: 31, required: 31 }, judgeCalibration)).toEqual({
      judgeCalibration,
      n: 48,
      requiredWins: 31,
      observedWins: 31,
    });
  });

  test("cost only warns above the cap and never manufactures infinity", () => {
    expect(costWarning(1.5, 1, 1.5)).toEqual({ ratio: 1.5, flagged: false });
    expect(costWarning(1.5001, 1, 1.5).flagged).toBe(true);
    expect(costWarning(null, 1, 1.5)).toEqual({ ratio: null, flagged: false });
    expect(costWarning(1, 0, 1.5)).toEqual({ ratio: null, flagged: true });
    expect(costWarning(Number.MAX_VALUE, Number.MIN_VALUE, 1.5)).toEqual({ ratio: null, flagged: true });
  });

  test("constructs the binding pass fields without confusing decisive and effective wins", () => {
    const lines = Array.from({ length: 32 }, (_, index) => ({
      seedId: `seed-${index % 8}`,
      score: index < 21 ? 1 : index < 23 ? 0.5 : 0,
    }));
    expect(passReport(lines, { seeds: 10, uncensoredSeeds: 8, seedWins: 6 })).toEqual({
      seeds: 10,
      uncensoredSeeds: 8,
      pairs: 32,
      wins: 21,
      ties: 2,
      rate: 22 / 32,
      wilson: { lower: 0.5143332168494361, upper: 0.8204745837470517 },
      requiredWins: 22,
      evidence: true,
      seedWins: 6,
    });
  });
});
