import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ensureDir } from "./paths";
import type { RunPaths } from "./run";
import { dirname, join } from "node:path";

export interface RunLockInfo {
  pid: number;
  host: string;
  startedAt: string;
  token?: string;
}

export interface RunLock {
  info: RunLockInfo;
  /** Removes the lock file, but only while this process still holds it. Idempotent. */
  release(): void;
}

export class RunLockedError extends Error {
  constructor(message: string) { super(message); this.name = "RunLockedError"; }
}

/** Reads the current holder, or `undefined` when there is no lock or its contents never parsed. */
export function readRunLock(paths: RunPaths): RunLockInfo | undefined {
  if (!existsSync(paths.lock)) return undefined;
  try {
    const v = JSON.parse(readFileSync(paths.lock, "utf8")) as Partial<RunLockInfo>;
    if (typeof v.pid !== "number") return undefined;
    return { pid: v.pid, host: typeof v.host === "string" ? v.host : "unknown", startedAt: typeof v.startedAt === "string" ? v.startedAt : "unknown", ...(typeof v.token === "string" ? { token: v.token } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * `kill(pid, 0)` sends nothing; it only asks whether the pid can be signalled. `EPERM` means the
 * process exists but belongs to another user — very much alive. A non-positive pid is never a real
 * process here (0 and -1 address process groups), so it is rejected before it reaches `kill`.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeComplete(path: string, info: RunLockInfo): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function transitionPath(lock: string): string {
  return `${lock}.transition`;
}

function tokenFile(dir: string, token: string): string {
  return join(dir, `${token}.json`);
}

function validToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token);
}

interface TransitionObservation {
  token?: string;
  info?: RunLockInfo & { token: string };
  unknown: boolean;
}

function prepareTransition(lock: string, info: RunLockInfo & { token: string }): string {
  ensureDir(dirname(lock));
  const stage = `${lock}.transition.${info.token}.tmp`;
  mkdirSync(stage, { mode: 0o700 });
  try {
    writeComplete(tokenFile(stage, info.token), info);
    return stage;
  } catch (error) {
    try { remove(tokenFile(stage, info.token)); } catch {}
    try { rmdirSync(stage); } catch {}
    throw error;
  }
}

function observeTransition(path: string): TransitionObservation | undefined {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (entries.length === 0) return { unknown: false };
  if (entries.length !== 1 || !entries[0]!.endsWith(".json")) return { unknown: true };
  const token = entries[0]!.slice(0, -5);
  if (!validToken(token)) return { unknown: true };
  try {
    const value = JSON.parse(readFileSync(tokenFile(path, token), "utf8")) as Partial<RunLockInfo>;
    if (value.token !== token || typeof value.pid !== "number") return { token, unknown: false };
    return {
      token,
      unknown: false,
      info: {
        pid: value.pid,
        host: typeof value.host === "string" ? value.host : "unknown",
        startedAt: typeof value.startedAt === "string" ? value.startedAt : "unknown",
        token,
      },
    };
  } catch {
    return { token, unknown: false };
  }
}

/** Token-specific removal cannot empty a replacement's nonempty transition directory. */
function clearTransition(path: string, observed: TransitionObservation): boolean {
  if (observed.unknown) return false;
  if (observed.token) {
    try { remove(tokenFile(path, observed.token)); } catch { return false; }
  }
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

const WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));

function acquireTransition(lock: string): RunLockInfo & { token: string } {
  const info = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: randomUUID() };
  const target = transitionPath(lock);
  const stage = prepareTransition(lock, info);
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      try {
        renameSync(stage, target);
        return info;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }
      const held = observeTransition(target);
      if (!held) continue;
      if (!held.info || !isAlive(held.info.pid)) {
        if (!clearTransition(target, held)) Atomics.wait(WAIT_WORD, 0, 0, 2);
        continue;
      }
      Atomics.wait(WAIT_WORD, 0, 0, 2);
    }
    throw new RunLockedError(`run lock transition remained busy: ${target}`);
  } catch (error) {
    try { remove(tokenFile(stage, info.token)); } catch {}
    try { rmdirSync(stage); } catch {}
    throw error;
  }
}

function releaseTransition(lock: string, token: string): void {
  clearTransition(transitionPath(lock), { token, unknown: false });
}

function withTransition<T>(lock: string, operation: () => T): T {
  const transition = acquireTransition(lock);
  try {
    return operation();
  } finally {
    releaseTransition(lock, transition.token);
  }
}

/** Publish a complete fsynced inode through one exclusive hard-link operation. */
function publish(path: string, info: RunLockInfo & { token: string }): void {
  const temporary = `${path}.owner-${info.token}`;
  writeComplete(temporary, info);
  try {
    linkSync(temporary, path);
  } finally {
    remove(temporary);
  }
}

/**
 * Takes `run.lock` for this process. A lock whose holder is dead — or whose contents cannot be read,
 * which can never be validated against a live pid — is stale and gets replaced. A live holder throws
 * a `RunLockedError` naming it; `force` removes it anyway.
 */
export function acquireRunLock(paths: RunPaths, opts: { force?: boolean } = {}): RunLock {
  const info = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: randomUUID() };
  withTransition(paths.lock, () => {
    if (existsSync(paths.lock)) {
      const held = readRunLock(paths);
      if (!opts.force && held && isAlive(held.pid)) {
        throw new RunLockedError(
          `run ${paths.id} is locked by pid ${held.pid} on ${held.host} since ${held.startedAt}; ` +
            "wait for it to finish or re-run with --force",
        );
      }
      remove(paths.lock);
    }
    publish(paths.lock, info);
  });
  return { info, release: () => releaseRunLock(paths, info.pid, info.token) };
}

/** Releases the exact tokenized acquisition, or a legacy owner-less lock held by `pid`. */
export function releaseRunLock(paths: RunPaths, pid: number = process.pid, token?: string): void {
  withTransition(paths.lock, () => {
    const held = readRunLock(paths);
    if (!held || held.pid !== pid) return;
    if (held.token !== undefined ? held.token !== token : token !== undefined) return;
    remove(paths.lock);
  });
}
