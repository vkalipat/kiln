import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import type { StoredEvent } from "../../src/core/events";
import { ADAPTIVE_LATENCY_SECONDS, projectedAdaptiveRound, projectedRoundCost, remainingIdeateUsd } from "../../src/ideation/budget";

const stored = (seq: number, event: object): StoredEvent => ({ seq, ts: "2026-09-04T00:00:00.000Z", ...event }) as StoredEvent;

describe("ideation budgets", () => {
  test("projects every required call class and both tournament orderings", () => {
    const cfg = defaultConfig();
    const model = createMockModel({ id: "priced", cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } } as never);
    const p = projectedRoundCost(cfg, () => ({ model: model as never, ref: "mock/priced" }));
    expect(p.rows.map((row) => row.name)).toEqual([
      "island first batches", "island second batches", "novelty tie-breaks", "prior-art scouts",
      "collision verdicts", "probe decision", "probe writers", "criteria", "tournament orderings", "meta-review",
    ]);
    expect(p.rows.find((row) => row.name === "tournament orderings")?.calls).toBe(cfg.ideation.pairCap * 2);
    expect(p.rows.find((row) => row.name === "prior-art scouts")?.calls).toBe(cfg.ideation.islands * cfg.ideation.ideasPerBatch * 4);
    expect(p.rows.find((row) => row.name === "probe decision")?.calls).toBe(2);
    expect(p.costUsd).toBeGreaterThan(0);
  });

  test("never projects more tournament orderings than the entrant field can contain", () => {
    const cfg = defaultConfig(); cfg.ideation.entrantsCap = 2; cfg.ideation.pairCap = 24;
    const model = createMockModel({ id: "priced", cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } } as never);
    const p = projectedRoundCost(cfg, () => ({ model: model as never, ref: "mock/priced" }));
    expect(p.rows.find((row) => row.name === "tournament orderings")?.calls).toBe(2);
  });

  test("prices the actual mixed island plans instead of one generator proxy", () => {
    const cfg = defaultConfig(); cfg.ideation.islands = 3; cfg.ideation.cheapIsland = false;
    const low = createMockModel({ id: "low", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } as never);
    const high = createMockModel({ id: "high", cost: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 } } as never);
    const proxy = projectedRoundCost(cfg, () => ({ model: low as never, ref: "mock/low" }));
    const actual = projectedRoundCost(cfg, () => ({ model: low as never, ref: "mock/low" }), {
      islandPlans: [{ model: low as never }, { model: high as never }, { model: low as never }],
    });
    expect(actual.rows[0]!.costUsd).toBeGreaterThan(proxy.rows[0]!.costUsd * 10);
  });

  test("adaptive projection includes bounded worker turns, retries, and sequential pair latency", () => {
    const cfg = defaultConfig();
    cfg.ideation.islands = 2;
    cfg.ideation.ideasPerBatch = 2;
    cfg.ideation.entrantsCap = 8;
    cfg.ideation.pairCap = 12;
    cfg.ideation.arbiterCaps = { novelty: 8, collision: 8 };
    const model = createMockModel({ id: "priced", cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } } as never);
    const p = projectedAdaptiveRound(cfg, () => ({ model: model as never, ref: "mock/priced" }));
    expect(p.rows.find((row) => row.name === "prior-art scout turn reserve")?.calls).toBe(8 * cfg.ideation.scoutTurnCap);
    expect(p.rows.find((row) => row.name === "tournament orderings with correction reserve")?.calls).toBe(12 * 2 * 2);
    expect(p.calls).toBe(157);
    expect(p.estimatedWallSeconds).toBe(p.baseWallSeconds * ADAPTIVE_LATENCY_SECONDS.stageSlackMultiplier);
    expect(p.estimatedWallSeconds).toBe(560);

    cfg.ideation.concurrency = 1;
    const serial = projectedAdaptiveRound(cfg, () => ({ model: model as never, ref: "mock/priced" }));
    expect(serial.estimatedWallSeconds).toBeGreaterThan(p.estimatedWallSeconds);
  });

  test("remaining spend uses the ideate share and only calls after ideate first started", () => {
    const cfg = defaultConfig();
    const events = [
      stored(1, { t: "model.call", role: "brain", provider: "p", model: "m", inputHash: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 2, stopReason: "stop", excerpt: "" }),
      stored(2, { t: "phase.start", phase: "ideate" }),
      stored(3, { t: "model.call", role: "brain", provider: "p", model: "m", inputHash: "y", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 1.25, stopReason: "stop", excerpt: "" }),
    ];
    expect(remainingIdeateUsd(cfg, events)).toBe(9.25);
  });
});
