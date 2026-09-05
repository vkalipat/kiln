import { acquireRunLock, RunLockedError } from "../core/lock";
import { RunRecord } from "../core/record";
import { readStatus, writeStatus, type RunPaths, type RunStatus } from "../core/run";

export type CancelPersistence = "existing_pause" | "preserved_terminal" | "written" | "contended" | "stale";

/**
 * Fallback for injected CLI implementations which do not persist cancellation under their own
 * run lock. The production CLI normally leaves `existing`; every write here owns the same lock.
 */
export function settleCancelledRunFallback(
  run: RunPaths,
  options: { preserveTerminal: boolean; statusAtCancel?: RunStatus; isCurrent(): boolean },
): CancelPersistence {
  if (!options.isCurrent()) return "stale";
  let lock;
  try { lock = acquireRunLock(run); }
  catch (error) {
    if (error instanceof RunLockedError) return "contended";
    throw error;
  }
  try {
    if (!options.isCurrent()) return "stale";
    const status = readStatus(run);
    if (status.state === "paused" && status.pausedReason === "user_cancelled") return "existing_pause";
    if (options.preserveTerminal) return "preserved_terminal";
    // A status mutation after cancel belongs to the unwinding CLI or a newer lock generation.
    if (options.statusAtCancel === undefined || JSON.stringify(status) !== JSON.stringify(options.statusAtCancel)) return "stale";
    writeStatus(run, {
      phase: status.phase,
      state: "paused",
      outcome: undefined,
      pausedReason: "user_cancelled",
      wakeAt: undefined,
      cursor: status.cursor ?? { step: "user_cancelled" },
      usdSpent: new RunRecord(run.record).costUsd(),
    });
    return "written";
  } finally { lock.release(); }
}
