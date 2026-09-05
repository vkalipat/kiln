import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonIfPresent, usageFraction } from "../../src/ideation/runtime";
import { latestSteering } from "../../src/ideation/runtime";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";

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
});
