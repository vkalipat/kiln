import { readStatus, writeStatus, type RunPaths } from "../core/run";
import { RunRecord } from "../core/record";
import { RunControl, RunCancelledError, currentRunControl, throwIfRunCancelled, withRunControl } from "../core/run-control";
import { watchRunPause } from "../core/pause-request";
import type { CliDeps } from "./main";

/** Called by a phase command while its run lock is still held. */
export function pauseCancelledRun(run: RunPaths): void {
  const status = readStatus(run);
  if (status.state === "done" || status.state === "failed" || (status.state === "paused" && status.pausedReason === "user_cancelled")) return;
  const record = new RunRecord(run.record);
  record.append({ t: "note", text: "operator cancelled the active step; resume from the saved boundary" });
  writeStatus(run, { state: "paused", outcome: undefined, pausedReason: "user_cancelled", wakeAt: undefined, usdSpent: record.costUsd() });
}

/** Own the control for CLI runs; embedded TUI invocations inherit their caller's control. */
export async function controlledCommand(deps: CliDeps, execute: (deps: CliDeps) => Promise<number>): Promise<number> {
  const inherited = currentRunControl();
  const control = inherited ?? new RunControl();
  let run: RunPaths | undefined;
  let unwatch: (() => void) | undefined;
  try {
    return await withRunControl(control, async () => {
      const result = await execute({ ...deps, onRun: (paths) => {
        if (run?.dir !== paths.dir) { unwatch?.(); run = paths; unwatch = watchRunPause(paths, control); }
        deps.onRun?.(paths);
      } });
      throwIfRunCancelled(control.signal);
      return result;
    });
  } catch (error) {
    if (!(error instanceof RunCancelledError) && !control.signal.aborted) throw error;
    if (inherited) throw error;
    return 0;
  } finally { unwatch?.(); }
}
