import { expect, test, setSystemTime } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseCommand } from "../../src/cli/commands/pause";
import { controlledCommand, pauseCancelledRun } from "../../src/cli/controlled-command";
import { acquireRunLock } from "../../src/core/lock";
import { initHome } from "../../src/core/home";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { elapsedByPhase } from "../../src/core/budget";
import { loadConfig } from "../../src/core/config";
import { remainingRunWallMs } from "../../src/phases/shared";
import { currentRunControl, RunCancelledError } from "../../src/core/run-control";

test("cancelling closes the active phase once so paused downtime does not consume resume wall budget", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-pause-wall-")); initHome(home);
  const run = createRun(home, "seed"); const lock = acquireRunLock(run);
  const cfg = loadConfig(home); cfg.budgets.wallSeconds = 100;
  const start = Date.parse("2026-09-09T00:00:00Z");
  try {
    setSystemTime(start);
    new RunRecord(run.record).append({ t: "phase.start", phase: "frame" });
    setSystemTime(start + 10_000);
    pauseCancelledRun(run);
    setSystemTime(start + 3_600_000);
    pauseCancelledRun(run);
    const record = new RunRecord(run.record);
    expect(record.read().filter((event) => event.t === "phase.end")).toMatchObject([{ phase: "frame", outcome: "cancelled" }]);
    expect(elapsedByPhase(record.read(), Date.now()).frame).toBe(10);
    expect(remainingRunWallMs(cfg.budgets, record)).toBe(90_000);
    writeStatus(run, { state: "running", pausedReason: undefined });
    record.append({ t: "phase.start", phase: "frame" });
    setSystemTime(start + 3_605_000);
    expect(remainingRunWallMs(cfg.budgets, record)).toBe(85_000);
  } finally { setSystemTime(); lock.release(); }
});

test("cancellation does not duplicate closed phase boundaries or change completed states", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-pause-terminal-")); initHome(home);
  for (const state of ["running", "done", "failed"] as const) {
    const run = createRun(home, "seed"); const lock = acquireRunLock(run);
    try {
      const record = new RunRecord(run.record);
      record.append({ t: "phase.start", phase: "frame" });
      record.append({ t: "phase.end", phase: "frame", outcome: "ok" });
      writeStatus(run, { state });
      pauseCancelledRun(run);
      expect(record.read().filter((event) => event.t === "phase.end")).toMatchObject([{ phase: "frame", outcome: "ok" }]);
      expect(readStatus(run).state).toBe(state === "running" ? "paused" : state);
    } finally { lock.release(); }
  }
});

test("pause requests stop an active command and persist a resumable user pause", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-pause-cli-")); initHome(home);
  const run = createRun(home, "seed");
  const result = controlledCommand({}, async (deps) => {
    const lock = acquireRunLock(run);
    try {
      deps.onRun?.(run);
      expect(pauseCommand(run.id, { home }, { write: () => {} })).toBe(0);
      await new Promise<void>((resolve, reject) => {
        const control = currentRunControl()!;
        const timeout = setTimeout(() => reject(new Error("pause was not consumed")), 1500);
        control.signal.addEventListener("abort", () => { clearTimeout(timeout); reject(new RunCancelledError()); }, { once: true });
      });
      return 0;
    } catch (error) { pauseCancelledRun(run); throw error; }
    finally { lock.release(); }
  });
  expect(await result).toBe(0);
  expect(readStatus(run)).toMatchObject({ state: "paused", pausedReason: "user_cancelled" });
});
