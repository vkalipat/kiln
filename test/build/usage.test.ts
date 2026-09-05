import { describe, expect, test } from "bun:test";
import { isUsageLimit, pauseInfo } from "../../src/build/usage";
import type { PhaseDeps } from "../../src/phases/frame";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";

const deps = (fetchUsage?: PhaseDeps["fetchUsage"]) => ({ fetchUsage }) as unknown as PhaseDeps;
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const HOUR_LATER = "2026-09-04T13:00:00.000Z";

describe("usage-window pause", () => {
  test("does not synthesize a usage pause when cancellation lands during polling", async () => {
    const control = new RunControl();
    const pending = withRunControl(control, () => pauseInfo(deps(async () => {
      control.cancel("pause during usage poll");
      return { used: 100, limit: 100 };
    }), "p", false, NOW));
    await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
  });

  test("isUsageLimit reads the 429 status first and provider wording only as a fallback", () => {
    expect(isUsageLimit(429, undefined)).toBe(true);
    expect(isUsageLimit(500, "usage limit reached")).toBe(true);
    expect(isUsageLimit(undefined, "monthly quota exhausted")).toBe(true);
    expect(isUsageLimit(undefined, "Rate-Limit")).toBe(true);
    expect(isUsageLimit(500, "server exploded")).toBe(false);
    expect(isUsageLimit(undefined, undefined)).toBe(false);
  });

  test("a reactive pause always pauses and wakes at the provider's reset or one hour later", async () => {
    expect(await pauseInfo(deps(), "p", true, NOW)).toEqual({ reason: "usage_limit", wakeAt: HOUR_LATER });
    expect(await pauseInfo(deps(async () => ({ used: 1, limit: 100 })), "p", true, NOW)).toEqual({ reason: "usage_limit", wakeAt: HOUR_LATER });
    expect(await pauseInfo(deps(async () => ({ used: 1, limit: 100, resetAt: "2026-09-05T00:00:00.000Z" })), "p", true, NOW)).toEqual({ reason: "usage_limit", wakeAt: "2026-09-05T00:00:00.000Z" });
  });

  test("a boundary poll pauses only when a known limit is at least 95 percent used", async () => {
    expect(await pauseInfo(deps(), "p", false, NOW)).toBeUndefined();
    expect(await pauseInfo(deps(async () => undefined), "p", false, NOW)).toBeUndefined();
    expect(await pauseInfo(deps(async () => ({ used: 94.9, limit: 100 })), "p", false, NOW)).toBeUndefined();
    expect(await pauseInfo(deps(async () => ({ used: 10 })), "p", false, NOW)).toBeUndefined();
    expect(await pauseInfo(deps(async () => ({ used: 10, limit: 0 })), "p", false, NOW)).toBeUndefined();
    expect(await pauseInfo(deps(async () => ({ used: 95, limit: 100 })), "p", false, NOW)).toEqual({ reason: "usage_limit", wakeAt: HOUR_LATER });
    expect(await pauseInfo(deps(async () => ({ used: 100, limit: 100, resetAt: "2026-09-05T00:00:00.000Z" })), "p", false, NOW)).toEqual({ reason: "usage_limit", wakeAt: "2026-09-05T00:00:00.000Z" });
  });

  test("polls the provider it is asked about", async () => {
    const providers: string[] = [];
    await pauseInfo(deps(async (provider) => { providers.push(provider); return undefined; }), "anthropic", false, NOW);
    expect(providers).toEqual(["anthropic"]);
  });
});
