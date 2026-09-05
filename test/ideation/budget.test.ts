import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import type { StoredEvent } from "../../src/core/events";
import { projectedRoundCost, remainingIdeateUsd } from "../../src/ideation/budget";

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
    expect(p.costUsd).toBeGreaterThan(0);
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
