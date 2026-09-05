import { RunControl, withRunControl } from "../core/run-control";
import type { AuditSnapshot, GitRunner } from "./git";

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

/** Runs Git cleanup outside an aborted run context while retaining its own hard deadline. */
export async function cleanupAuditSnapshot(
  git: GitRunner,
  snapshot: AuditSnapshot,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const control = new RunControl();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      control.cancel("auditor cleanup deadline");
      reject(new Error("auditor snapshot cleanup timed out"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([withRunControl(control, () => git.removeAuditSnapshot(snapshot)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
