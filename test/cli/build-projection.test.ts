import { describe, expect, test } from "bun:test";
import { buildProjectionRows } from "../../src/cli/build-projection";
import { defaultConfig } from "../../src/core/config";
import { phaseAvailableUsd, spentByPhase } from "../../src/core/budget";
import { derivedCaps } from "../../src/formation/features";

describe("buildProjectionRows", () => {
  test("derives every projected build row from config and authoritative spend", () => {
    const cfg = defaultConfig();
    const events = [{ t: "model.call", role: "brain", provider: "p", model: "m", inputHash: "h", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 2, stopReason: "stop", excerpt: "" }] as never;
    const caps = derivedCaps(cfg);
    const rows = Object.fromEntries(buildProjectionRows(cfg, events).map((row) => [row.name, row.value]));
    expect(rows["features (derived max)"]).toBe(String(caps.maxFeatures));
    expect(rows["expected attempts"]).toBe(String(cfg.build.expectedAttempts));
    expect(rows["expected attempt usd"]).toBe(`$${cfg.build.expectedAttemptUsd.toFixed(3)}`);
    expect(rows["attempt ceiling"]).toBe(`$${caps.attemptCeiling.toFixed(3)}`);
    expect(rows["feature ceiling"]).toBe(`$${caps.featureCeilingBase.toFixed(3)}`);
    expect(rows["projected build usd"]).toBe(`$${(caps.maxFeatures * cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd).toFixed(3)}`);
    expect(rows["projected usd per success"]).toBe(`$${(cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd).toFixed(3)}`);
    expect(rows["available build usd"]).toBe(`$${phaseAvailableUsd(cfg.budgets, "build", spentByPhase(events)).toFixed(3)}`);
  });
});
