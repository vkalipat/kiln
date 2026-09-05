import { acquireRunLock, RunLockedError } from "../../core/lock";
import { kilnHome } from "../../core/paths";
import { requestRunPause } from "../../core/pause-request";
import { readStatus, runExists, runPaths, writeStatus } from "../../core/run";
import type { CliIo } from "../main";
import { printJson } from "../output";

export function pauseCommand(id: string | undefined, flags: Record<string, string | boolean>, io: CliIo, retries = 0): number {
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  if (!id || !runExists(home, id)) { (io.error ?? io.write)(`unknown run ${id ?? ""}\n`); return 2; }
  const run = runPaths(home, id);
  const status = readStatus(run);
  if (status.state === "done" || status.state === "failed") {
    (io.error ?? io.write)(`run ${id} already ended (${status.state})\n`); return 2;
  }
  let requested = false;
  let lock;
  try {
    lock = acquireRunLock(run);
    const current = readStatus(run);
    if (current.state === "done" || current.state === "failed") {
      (io.error ?? io.write)(`run ${id} already ended (${current.state})\n`); return 2;
    }
    writeStatus(run, { state: "paused", pausedReason: "user_cancelled", wakeAt: undefined, outcome: undefined });
  } catch (error) {
    if (!(error instanceof RunLockedError)) throw error;
    if (!requestRunPause(run)) {
      if (retries < 2) return pauseCommand(id, flags, io, retries + 1);
      (io.error ?? io.write)(`run ${id} changed owners during the pause request; retry\n`); return 2;
    }
    requested = true;
  } finally { lock?.release(); }
  if (flags.json) printJson(io, { id, state: requested ? "pause_requested" : "paused" });
  else io.write(`${id}: ${requested ? "pause requested; waiting for active work to stop" : "paused"}\n`);
  return 0;
}
