import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { CONTEXT_THRESHOLD_PERCENT, KEEP_RECENT_TOKENS, compactionSettings, contextPressure } from "../../src/brain/context";

const usage = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total }) as never;

describe("compactionSettings", () => {
  test("supplies the two fields the library requires", () => {
    const s = compactionSettings();
    expect(s.enabled).toBe(true);
    expect(s.keepRecentTokens).toBe(KEEP_RECENT_TOKENS);
    expect(s.thresholdPercent).toBe(CONTEXT_THRESHOLD_PERCENT);
  });
});

describe("contextPressure", () => {
  const model = createMockModel({ id: "m", contextWindow: 1000 }) as unknown as Model;

  test("false below the threshold, true above it", () => {
    expect(contextPressure(model, usage(699))).toBe(false);
    expect(contextPressure(model, usage(701))).toBe(true);
  });

  test("a null context window disables the trigger", () => {
    const noWindow = { ...model, contextWindow: null } as unknown as Model;
    expect(contextPressure(noWindow, usage(10_000_000))).toBeUndefined();
  });

  test("an explicit threshold overrides the default", () => {
    expect(contextPressure(model, usage(500), { thresholdPercent: 40 })).toBe(true);
  });
});
