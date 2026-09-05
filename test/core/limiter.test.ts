import { describe, expect, test } from "bun:test";
import { Limiter } from "../../src/core/limiter";

const tick = (n = 1) => new Promise<void>((r) => setTimeout(r, n));

describe("Limiter", () => {
  test("never runs more than N at once", async () => {
    const lim = new Limiter(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(2);
      active -= 1;
    };
    await Promise.all(Array.from({ length: 20 }, () => lim.run(task)));
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(lim.active).toBe(0);
    expect(lim.pending).toBe(0);
  });

  test("starts tasks in call order", async () => {
    const lim = new Limiter(2);
    const started: number[] = [];
    const jobs = Array.from({ length: 8 }, (_, i) => lim.run(async () => { started.push(i); await tick(1); return i; }));
    const out = await Promise.all(jobs);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("pending and active report the queue while it drains", async () => {
    const lim = new Limiter(1);
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const first = lim.run(async () => { await gate; });
    const second = lim.run(async () => {});
    await tick();
    expect(lim.active).toBe(1);
    expect(lim.pending).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(lim.active).toBe(0);
    expect(lim.pending).toBe(0);
  });

  test("a rejecting task releases its slot and the rejection reaches the caller", async () => {
    const lim = new Limiter(1);
    const boom = lim.run(async () => { throw new Error("boom"); });
    await expect(boom).rejects.toThrow("boom");
    expect(lim.active).toBe(0);
    expect(await lim.run(async () => "ok")).toBe("ok");
  });

  test("rejects a nonsense concurrency", () => {
    expect(() => new Limiter(0)).toThrow();
    expect(() => new Limiter(-1)).toThrow();
  });
});
