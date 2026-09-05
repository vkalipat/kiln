import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseCommand } from "../../src/cli/commands/pause";
import { controlledCommand, pauseCancelledRun } from "../../src/cli/controlled-command";
import { acquireRunLock } from "../../src/core/lock";
import { initHome } from "../../src/core/home";
import { createRun, readStatus } from "../../src/core/run";
import { currentRunControl, RunCancelledError } from "../../src/core/run-control";

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
