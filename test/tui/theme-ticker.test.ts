import { describe, expect, test } from "bun:test";
import { PHASE_STYLE, ansi } from "../../src/tui/theme";
import { TuiTicker } from "../../src/tui/ticker";

describe("TUI theme and ticker", () => {
  test("base colors use ANSI while the six phase accents use RGB", () => {
    expect(ansi.green("x")).toStartWith("\x1b[32m");
    for (const style of Object.values(PHASE_STYLE)) expect(style("x")).toMatch(/^\x1b\[38;2;/);
  });

  test("one injected 200ms timer drives every subscriber and stops after the last", () => {
    let callback: (() => void) | undefined;
    const intervals: number[] = [];
    const cleared: unknown[] = [];
    const timer = {} as ReturnType<typeof setInterval>;
    const ticker = new TuiTicker({
      setIntervalFn: (fn, ms) => { callback = fn; intervals.push(ms); return timer; },
      clearIntervalFn: (value) => { cleared.push(value); },
    });
    let first = 0; let second = 0;
    const offFirst = ticker.subscribe(() => { first += 1; });
    const offSecond = ticker.subscribe(() => { second += 1; });
    expect(intervals).toEqual([200]);
    callback?.();
    expect([ticker.frame, first, second]).toEqual([1, 1, 1]);
    offFirst(); expect(cleared).toHaveLength(0);
    offSecond(); expect(cleared).toEqual([timer]);
  });

  test("disabled animation is static and allocates no timer", () => {
    let scheduled = false;
    const ticker = new TuiTicker({ animations: false, setIntervalFn: () => { scheduled = true; return {} as ReturnType<typeof setInterval>; } });
    let calls = 0;
    ticker.subscribe(() => { calls += 1; });
    ticker.advance();
    expect({ scheduled, calls, frame: ticker.frame }).toEqual({ scheduled: false, calls: 0, frame: 0 });
  });

  test("NO_ANIMATION disables the default ticker", () => {
    const previous = process.env.NO_ANIMATION;
    process.env.NO_ANIMATION = "1";
    try { expect(new TuiTicker().animations).toBe(false); }
    finally {
      if (previous === undefined) delete process.env.NO_ANIMATION;
      else process.env.NO_ANIMATION = previous;
    }
  });
});
