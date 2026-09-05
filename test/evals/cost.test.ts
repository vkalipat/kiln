import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "../../src/core/events";
import { foldCost } from "../../src/core/cost";
import { cacheHealth, foldCostFallback, readCost } from "../../src/evals/cost";

const at = (event: object, seq: number): StoredEvent => ({ seq, ts: `2026-09-05T00:00:0${seq}.000Z`, ...event }) as StoredEvent;
const call = (role: "brain" | "builder", cacheRead: number) => ({
  t: "model.call", role, provider: "test", model: role, inputHash: "h",
  usage: { input: 10, output: 2, cacheRead, cacheWrite: 1 }, costUsd: 0.5, stopReason: "stop", excerpt: "",
});

describe("eval cost consumption", () => {
  test("reads only complete canonical phase blocks", () => {
    const block = foldCost([], "build", 0);
    expect(readCost({ cost: { build: block, ideate: { usd: 1 }, strange: block } })).toEqual({ build: block });
    expect(readCost({})).toEqual({});
  });

  test("fallback is exactly the canonical fold and preserves null zero-success ratios", () => {
    const events = [at({ t: "phase.start", phase: "build" }, 1), at(call("builder", 4), 2)];
    expect(foldCostFallback(events, "build", 0)).toEqual(foldCost(events, "build", 0));
    expect(foldCostFallback(events, "build", 0).usdPerSuccess).toBeNull();
  });

  test("flags later sequential calls without cache and declines concurrent phases", () => {
    const events = [
      at({ t: "phase.start", phase: "build" }, 1),
      at({ t: "turn", role: "builder", phase: "build", n: 1 }, 2), at(call("builder", 0), 3),
      at({ t: "turn", role: "builder", phase: "build", n: 2 }, 4), at(call("builder", 8), 5),
      at({ t: "turn", role: "builder", phase: "build", n: 3 }, 6), at(call("builder", 0), 7),
      at({ t: "phase.start", phase: "ideate" }, 8), at({ t: "turn", role: "brain", phase: "ideate", n: 2 }, 9), at(call("brain", 0), 10),
    ];
    expect(cacheHealth(events, "build")).toEqual({ cacheHealthy: false, unhealthyCallsByRole: { builder: 1 } });
    expect(cacheHealth(events.slice(0, 6), "build")).toEqual({ cacheHealthy: true, unhealthyCallsByRole: {} });
    expect(cacheHealth(events, "ideate")).toEqual({ cacheHealthy: null, unhealthyCallsByRole: {} });
    expect(cacheHealth(events, "discover")).toEqual({ cacheHealthy: null, unhealthyCallsByRole: {} });
  });
});
