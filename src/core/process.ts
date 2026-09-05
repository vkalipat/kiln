import { spawn } from "node:child_process";
import { currentRunControl } from "./run-control";

export interface ProcessOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** When true, `env` is the child's whole environment instead of an overlay on `process.env`.
   *  Callers that must keep secrets out of a child (see `bash`) rely on this. */
  envReplace?: boolean;
  timeoutMs: number;
  /** default 2000 */
  drainMs?: number;
  shell?: boolean;
  input?: string;
  /** default 1_000_000 */
  maxOutputBytes?: number;
  /** Cancels this process invocation. When omitted, ambient run cancellation applies. */
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when an AbortSignal ended the process; absent on legacy injected fixtures. */
  cancelled?: boolean;
  durationMs: number;
  overrunMs: number;
  truncated: boolean;
}

const TRUNCATION_NOTICE = "\n... [output truncated] ...\n";
const KILL_GRACE_MS = 50;
const DEFAULT_DRAIN_MS = 2000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Accumulates output chunks, keeping memory bounded by compacting down to
 * head+tail halves whenever the buffered size grows past 2x the cap. A
 * final compact happens in text() so output that never crossed the 2x
 * threshold mid-stream is still truncated to the cap on read.
 */
class Collector {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(b: Buffer): void {
    this.size += b.length;
    this.chunks.push(b);
    if (this.size > this.max * 2) {
      this.compact();
    }
  }

  private compact(): void {
    const all = Buffer.concat(this.chunks);
    const half = Math.floor(this.max / 2);
    const notice = Buffer.from(TRUNCATION_NOTICE);
    this.chunks = [all.subarray(0, half), notice, all.subarray(all.length - half)];
    this.size = this.chunks.reduce((s, c) => s + c.length, 0);
    this.truncated = true;
  }

  text(): string {
    if (this.size > this.max) {
      this.compact();
    }
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole process group (requires detached: true
    // at spawn time so the child is the group leader).
    process.kill(-pid, sig);
  } catch {
    // Group already gone (process exited and was reaped) — nothing to do.
  }
}

export function runProcess(o: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const abortSignal = o.signal ?? currentRunControl()?.signal;
  const maxOutputBytes = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const drainMs = o.drainMs ?? DEFAULT_DRAIN_MS;
  const out = new Collector(maxOutputBytes);
  const err = new Collector(maxOutputBytes);

  // A caller that is already cancelled must not create a process which it can
  // never use. Keeping this check ahead of spawn also makes cancellation safe
  // for commands with side effects.
  if (abortSignal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      durationMs: Date.now() - started,
      overrunMs: 0,
      truncated: false,
    });
  }

  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(o.cmd, o.args ?? [], {
      cwd: o.cwd,
      env: o.envReplace === true ? { ...(o.env ?? {}) } : { ...process.env, ...(o.env ?? {}) },
      detached: true,
      shell: o.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let exited = false;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      abortSignal?.removeEventListener("abort", abort);

      // Belt-and-suspenders cleanup: a foregrounded pipeline exits cleanly on
      // its own, but a backgrounded grandchild (e.g. `(sleep 5 &)`) can
      // outlive the child we spawned while still sharing its process group.
      // Reap the whole group unconditionally so no descendant lingers past
      // this call, whether we got here via timeout, drain, or a clean exit.
      if (child.pid) killGroup(child.pid, "SIGKILL");

      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      // Don't let a still-alive (or not-yet-reaped) child keep the event
      // loop alive once we've decided to stop waiting on it.
      child.unref();

      const durationMs = Date.now() - started;
      resolve({
        exitCode,
        signal,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        cancelled,
        durationMs,
        overrunMs: Math.max(0, durationMs - o.timeoutMs),
        truncated: out.truncated || err.truncated,
      });
    };

    const terminate = (cause: "timeout" | "cancelled") => {
      if (settled || timedOut || cancelled) return;
      timedOut = cause === "timeout";
      cancelled = cause === "cancelled";
      clearTimeout(timeoutTimer);
      if (child.pid) killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid) killGroup(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
      // Stop waiting for pipes to drain indefinitely. The normal close event
      // still wins as soon as the terminated process group releases them.
      clearTimeout(drainTimer);
      drainTimer = setTimeout(finish, drainMs);
    };

    function abort(): void {
      terminate("cancelled");
    }

    timeoutTimer = setTimeout(() => {
      // The child may already be gone by the time this fires — e.g. it
      // exited naturally but a grandchild is still holding the pipes open,
      // so we're mid-drain-wait when timeoutMs elapses. Don't retroactively
      // mark an already-finished run as timed out.
      if (exited || settled) return;
      terminate("timeout");
    }, o.timeoutMs);

    abortSignal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));

    child.on("error", (e) => {
      err.push(Buffer.from(String(e)));
      exitCode = null;
      finish();
    });

    child.on("exit", (code, sig) => {
      exited = true;
      exitCode = code;
      signal = sig;
      // The child is gone now, on its own — the timeout callback must never
      // fire after this and retroactively mark a finished run as timed out.
      clearTimeout(timeoutTimer);
      // If we already timed out (this exit is the child dying from our own
      // SIGTERM/SIGKILL), the timeout branch above owns the drain window
      // (started from the moment of the kill, not of this exit) — don't
      // reschedule a second one on top of it.
      if (!timedOut && !cancelled) {
        // Child exited on its own, but a grandchild may still hold the
        // stdout/stderr pipes open (no 'close' event until every holder of
        // the write end closes it). Bound how long we wait for that. Clear
        // any prior drain timer first so we don't leak an untracked handle.
        clearTimeout(drainTimer);
        drainTimer = setTimeout(finish, drainMs);
      }
    });

    // 'close' only fires once every process holding the pipes' write ends
    // has closed them — i.e. no descendant is still holding output open.
    child.on("close", () => {
      if (exited) finish();
    });

    if (o.input !== undefined) {
      child.stdin?.end(o.input);
    } else {
      child.stdin?.end();
    }
  });
}
