import { describe, expect, test } from "bun:test";
import { foldCost, survivingIdeaCount } from "../../src/core/cost";
import type { RecordEvent, StoredEvent } from "../../src/core/events";

function stored(events: RecordEvent[]): StoredEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1, ts: "2026-09-05T00:00:00.000Z" }));
}
const call: RecordEvent = { t: "model.call", role: "builder", provider: "mock", model: "model", inputHash: "hash",
  usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 20 }, costUsd: 2, stopReason: "stop", excerpt: "" };

describe("cost per success", () => {
  test("attributes interleaved roles to their phase and preserves token categories", () => {
    const events = stored([
      { t: "phase.start", phase: "discover" }, { ...call, role: "scout", costUsd: 10 },
      { t: "phase.start", phase: "build" }, { t: "turn", phase: "build", role: "builder", n: 1 }, call,
      { t: "turn", phase: "build", role: "auditor", n: 1 }, { ...call, role: "auditor" },
      { t: "phase.end", phase: "build", outcome: "ok" },
    ]);
    expect(foldCost(events, "build", 2)).toEqual({ usd: 4, tokens: 440, turns: 2, successes: 2,
      usdPerSuccess: 2, tokensPerSuccess: 220, turnsPerSuccess: 1, cacheReadRatio: .4, cacheWrite: 40, reasoningTokens: null });
    expect(foldCost(events, "discover", 1).usd).toBe(10);
  });
  test("no successes or usage yields null ratios, never Infinity", () => {
    expect(foldCost([], "build", 0)).toMatchObject({ usdPerSuccess: null, tokensPerSuccess: null,
      turnsPerSuccess: null, cacheReadRatio: null, reasoningTokens: null });
    expect(() => foldCost([], "build", -1)).toThrow();
  });
  test("survivors are keyed by id, independent of repeated insert/reject events", () => {
    const insert = (id: string): RecordEvent => ({ t: "idea.insert", id, cell: "x", similarity: 0, parents: [] });
    expect(survivingIdeaCount(stored([insert("a"), insert("b"), insert("c"), insert("a"),
      { t: "idea.reject", id: "a", reason: "collided" }, { t: "idea.reject", id: "a", reason: "restatement" },
      { t: "idea.reject", id: "b", reason: "lost_cell" }, { t: "idea.reject", id: "absent", reason: "collided" }]))).toBe(2);
  });
});
