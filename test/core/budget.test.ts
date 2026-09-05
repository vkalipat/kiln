import { describe, expect, test } from "bun:test";
import { attemptCeiling, effectiveReflectReserveUsd, elapsedByPhase, phaseAvailableUsd, phaseAvailableWallSeconds, spentByPhase } from "../../src/core/budget";
import type { RecordEvent, StoredEvent } from "../../src/core/events";
import { defaultConfig } from "../../src/core/config";

describe("phase budget ledgers", () => {
  test("rolls earlier dollar underspend forward and subtracts overspend", () => {
    const cfg = defaultConfig();
    const b = cfg.budgets;
    expect(phaseAvailableUsd(b, "form", { frame: 0, discover: 0, ideate: 8 })).toBeCloseTo(4.875);
    expect(phaseAvailableUsd(b, "build", { frame: 1, discover: 1, ideate: 11, form: 2 })).toBeCloseTo(9.75);
    expect(phaseAvailableUsd(b, "build", { frame: 5, discover: 5, ideate: 20, form: 5 })).toBe(0);
  });

  test("does the same for wall time", () => {
    const b = defaultConfig().budgets;
    expect(phaseAvailableWallSeconds(b, "form", { frame: 0, discover: 0, ideate: 5_000 })).toBeCloseTo(2_416);
    expect(phaseAvailableWallSeconds(b, "build", { frame: 500, discover: 500, ideate: 7_000, form: 1_000 })).toBeCloseTo(5_256);
    expect(phaseAvailableWallSeconds(b, "build", { frame: 20_000 })).toBe(0);
  });

  test("protects reflect minima after prior overshoot", () => {
    const b = defaultConfig().budgets;
    expect(effectiveReflectReserveUsd(b)).toBe(0.25);
    expect(phaseAvailableUsd(b, "reflect", { build: 40 })).toBe(0.25);
    expect(phaseAvailableWallSeconds(b, "reflect", { build: 20_000 })).toBe(144);
  });

  test("clamps the dollar reserve on a smaller run and exposes the attempt floor", () => {
    const cfg = defaultConfig();
    cfg.budgets.usd = 10;
    expect(effectiveReflectReserveUsd(cfg.budgets)).toBeCloseTo(0.1);
    expect(attemptCeiling(cfg)).toBeCloseTo(cfg.build.builderUsdCap + cfg.build.auditorUsdCap);
    expect(attemptCeiling(defaultConfig())).toBeCloseTo(1.9508);
  });
});

describe("phase ledgers from the record", () => {
  const at = (seq: number, ts: string, event: RecordEvent): StoredEvent => ({ seq, ts, ...event } as StoredEvent);
  const call = (costUsd: number): RecordEvent => ({ t: "model.call", role: "brain", provider: "p", model: "m", inputHash: "h", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd, stopReason: "stop", excerpt: "" });

  test("spentByPhase charges each model call to the phase of the last phase.start, frame by default", () => {
    const events = [
      at(1, "2026-01-01T00:00:00.000Z", call(0.5)),
      at(2, "2026-01-01T00:00:01.000Z", { t: "phase.start", phase: "build" }),
      at(3, "2026-01-01T00:00:02.000Z", call(1.25)),
      at(4, "2026-01-01T00:00:03.000Z", call(0.25)),
      at(5, "2026-01-01T00:00:04.000Z", { t: "phase.end", phase: "build", outcome: "stopped" }),
      at(6, "2026-01-01T00:00:05.000Z", { t: "phase.start", phase: "reflect" }),
      at(7, "2026-01-01T00:00:06.000Z", call(0.1)),
    ];
    expect(spentByPhase(events)).toEqual({ frame: 0.5, build: 1.5, reflect: 0.1 });
    expect(spentByPhase([])).toEqual({});
  });

  test("elapsedByPhase closes phases at phase.end, counts an open phase to now, and accumulates a re-opened phase", () => {
    const events = [
      at(1, "2026-01-01T00:00:00.000Z", { t: "phase.start", phase: "form" }),
      at(2, "2026-01-01T00:00:30.000Z", { t: "phase.end", phase: "form", outcome: "ok" }),
      at(3, "2026-01-01T00:01:00.000Z", { t: "phase.start", phase: "build" }),
      at(4, "2026-01-01T00:03:00.000Z", { t: "phase.end", phase: "build", outcome: "stopped" }),
      at(5, "2026-01-01T00:10:00.000Z", { t: "phase.start", phase: "build" }),
      at(6, "2026-01-01T00:10:45.000Z", { t: "phase.end", phase: "build", outcome: "ok" }),
      at(7, "2026-01-01T00:11:00.000Z", { t: "phase.start", phase: "reflect" }),
    ];
    const now = Date.parse("2026-01-01T00:11:20.000Z");
    expect(elapsedByPhase(events, now)).toEqual({ form: 30, build: 165, reflect: 20 });
    expect(elapsedByPhase([at(1, "not-a-date", { t: "phase.start", phase: "frame" })], now)).toEqual({});
  });
});
