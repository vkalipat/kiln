import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseInfo, readJsonIfPresent, usageFraction } from "../../src/ideation/runtime";
import { latestSteering } from "../../src/ideation/runtime";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { defaultConfig } from "../../src/core/config";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import type { PhaseDeps } from "../../src/phases/frame";

describe("ideation runtime helpers", () => {
  test("normalizes ratio, percent, and explicit-limit usage reports", () => {
    expect(usageFraction({ used: 0.95 })).toBe(0.95);
    expect(usageFraction({ used: 95 })).toBe(0.95);
    expect(usageFraction({ used: 19, limit: 20 })).toBe(0.95);
  });

  test("reads valid JSON and treats absent or corrupt state as unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-runtime-"));
    const path = join(dir, "frontier.json");
    expect(readJsonIfPresent<{ round: number }>(path)).toBeUndefined();
    writeFileSync(path, "{bad");
    expect(readJsonIfPresent<{ round: number }>(path)).toBeUndefined();
    writeFileSync(path, '{"round":2}');
    expect(readJsonIfPresent<{ round: number }>(path)).toEqual({ round: 2 });
  });

  test("returns the newest durable another-round steering", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-runtime-")); const run = createRun(home, "seed"); const record = new RunRecord(run.record);
    record.append({ t: "checkpoint.decision", kind: "another_round", steering: "first" });
    record.append({ t: "checkpoint.decision", kind: "reject", id: "x", reason: "no" });
    record.append({ t: "checkpoint.decision", kind: "another_round", steering: "latest" });
    expect(latestSteering(record)).toBe("latest");
  });

  test("cancels promptly while a usage poll is still pending", async () => {
    const control = new RunControl();
    let calls = 0;
    const home = mkdtempSync(join(tmpdir(), "kiln-runtime-cancel-"));
    const run = createRun(home, "seed");
    const deps = {
      home,
      run,
      record: new RunRecord(run.record),
      cfg: defaultConfig(),
      models: () => ({ model: { provider: "mock" }, ref: "mock/model" }),
      fetchUsage: async () => { calls += 1; return await new Promise<never>(() => {}); },
    } as unknown as PhaseDeps;
    const pending = withRunControl(control, () => pauseInfo(deps, undefined, true));
    await Promise.resolve();
    control.cancel("test cancellation");
    const outcome = await Promise.race([
      pending.then(() => "resolved", (error) => error instanceof RunCancelledError ? "cancelled" : "wrong-error"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(outcome).toBe("cancelled");
    expect(calls).toBe(1);
  });
});
