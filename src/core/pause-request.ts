import { readFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeAtomic } from "./paths";
import type { RunPaths } from "./run";
import { RunControl } from "./run-control";
import { readRunLock, type RunLockInfo } from "./lock";

const REQUEST_FILE = ".pause-request.json";
const DEFAULT_POLL_MS = 100;

interface PauseRequest {
  version: 2;
  requestedAt: string;
  generation: string;
}

function generation(holder: RunLockInfo | undefined): string | undefined {
  if (!holder) return undefined;
  return createHash("sha256").update(JSON.stringify([holder.pid, holder.host, holder.startedAt, holder.token ?? null])).digest("hex");
}

export function pauseRequestPath(run: RunPaths, target = generation(readRunLock(run))): string {
  return join(run.toolOutputDir, target ? `.pause-request-${target}.json` : REQUEST_FILE);
}

/** Writes no operator text: only a fixed schema and timestamp cross the process boundary. */
export function requestRunPause(run: RunPaths, now: () => Date = () => new Date()): boolean {
  const target = generation(readRunLock(run));
  if (!target) return false;
  const request: PauseRequest = { version: 2, requestedAt: now().toISOString(), generation: target };
  writeAtomic(pauseRequestPath(run, target), `${JSON.stringify(request)}\n`);
  return true;
}

function consumeRunPause(run: RunPaths, target: string): boolean {
  const path = pauseRequestPath(run, target);
  const claim = `${path}.claim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    return false;
  }
  try {
    const value = JSON.parse(readFileSync(claim, "utf8")) as Partial<PauseRequest>;
    const keys = value && typeof value === "object" ? Object.keys(value) : [];
    if (value.version !== 2 || value.generation !== target || typeof value.requestedAt !== "string" || keys.length !== 3) return false;
    const parsed = new Date(value.requestedAt);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value.requestedAt;
  } catch {
    return false;
  } finally {
    rmSync(claim, { force: true });
  }
}

/** Watches a cross-process pause marker and translates it into ordinary run cancellation. */
export function watchRunPause(
  run: RunPaths,
  control: RunControl,
  options: { pollMs?: number } = {},
): () => void {
  let disposed = false;
  const target = generation(readRunLock(run));
  let timer: ReturnType<typeof setInterval> | undefined;
  const onAbort = () => dispose();
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearInterval(timer);
    control.signal.removeEventListener("abort", onAbort);
  }
  const poll = () => {
    if (disposed || !target) return;
    if (generation(readRunLock(run)) !== target) { dispose(); return; }
    if (!consumeRunPause(run, target)) return;
    dispose();
    control.cancel("operator pause requested");
  };
  if (control.signal.aborted || !target) {
    dispose();
    return dispose;
  }
  control.signal.addEventListener("abort", onAbort, { once: true });
  timer = setInterval(poll, Math.max(1, options.pollMs ?? DEFAULT_POLL_MS));
  timer.unref?.();
  poll();
  return dispose;
}
