import { randomUUID } from "node:crypto";
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
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir } from "../core/paths";

export interface EvolveLockInfo {
  pid: number;
  host: string;
  startedAt: string;
  /** Unique even when a force replacement is acquired by the same process. */
  owner?: string;
}

export interface EvolveLock {
  info: EvolveLockInfo & { owner: string };
  path: string;
  /** Idempotent; an owner mismatch left by an ordinary force replacement is preserved. */
  release(): void;
}

export class EvolveLockedError extends Error {
  constructor(message: string) { super(message); this.name = "EvolveLockedError"; }
}

/** The one global mutation lock for a kiln home. */
export function evolveLockPath(home: string): string {
  return join(home, "evolution", "evolve.lock");
}

export function readEvolveLock(home: string): EvolveLockInfo | undefined {
  const path = evolveLockPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<EvolveLockInfo>;
    if (typeof value.pid !== "number") return undefined;
    return {
      pid: value.pid,
      host: typeof value.host === "string" ? value.host : "unknown",
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "unknown",
      ...(typeof value.owner === "string" && value.owner ? { owner: value.owner } : {}),
    };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeComplete(path: string, info: EvolveLockInfo & { owner: string }): void {
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

function ignoredLockWorkDir(home: string): string {
  return join(home, "evolution", "work", ".locks");
}

function transitionPath(home: string): string {
  return join(ignoredLockWorkDir(home), "evolve.transition");
}

function ownerFile(dir: string, owner: string): string {
  return join(dir, `${owner}.json`);
}

function validOwner(owner: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner);
}

interface TransitionObservation {
  owner?: string;
  info?: EvolveLockInfo & { owner: string };
  unknown: boolean;
}

/** A prepared nonempty directory makes transition ownership visible atomically. */
function prepareTransition(home: string, info: EvolveLockInfo & { owner: string }): string {
  const work = ignoredLockWorkDir(home);
  ensureDir(work);
  const stage = join(work, `evolve.transition.${info.owner}.tmp`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    writeComplete(ownerFile(stage, info.owner), info);
    return stage;
  } catch (error) {
    try { remove(ownerFile(stage, info.owner)); } catch {}
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
  const owner = entries[0]!.slice(0, -5);
  if (!validOwner(owner)) return { unknown: true };
  try {
    const value = JSON.parse(readFileSync(ownerFile(path, owner), "utf8")) as Partial<EvolveLockInfo>;
    if (value.owner !== owner || typeof value.pid !== "number") return { owner, unknown: false };
    return {
      owner,
      unknown: false,
      info: {
        pid: value.pid,
        host: typeof value.host === "string" ? value.host : "unknown",
        startedAt: typeof value.startedAt === "string" ? value.startedAt : "unknown",
        owner,
      },
    };
  } catch {
    return { owner, unknown: false };
  }
}

/** Owner-specific unlink + non-recursive rmdir cannot remove a replacement's nonempty directory. */
function clearTransition(path: string, observed: TransitionObservation): boolean {
  if (observed.unknown) return false;
  if (observed.owner) {
    try { remove(ownerFile(path, observed.owner)); } catch { return false; }
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

function acquireTransition(home: string): EvolveLockInfo & { owner: string } {
  const info = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), owner: randomUUID() };
  const target = transitionPath(home);
  const stage = prepareTransition(home, info);
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
    throw new EvolveLockedError(`evolution lock transition remained busy: ${target}`);
  } catch (error) {
    try { remove(ownerFile(stage, info.owner)); } catch {}
    try { rmdirSync(stage); } catch {}
    throw error;
  }
}

function releaseTransition(home: string, owner: string): void {
  clearTransition(transitionPath(home), { owner, unknown: false });
}

function withTransition<T>(home: string, operation: () => T): T {
  const transition = acquireTransition(home);
  try {
    return operation();
  } finally {
    releaseTransition(home, transition.owner);
  }
}

/** Publish only after the complete, fsynced JSON exists; hard-link creation is exclusive. */
function publish(home: string, path: string, info: EvolveLockInfo & { owner: string }): void {
  const stage = join(ignoredLockWorkDir(home), `${info.owner}.lock.tmp`);
  writeComplete(stage, info);
  try {
    linkSync(stage, path);
  } finally {
    remove(stage);
  }
}

/**
 * Acquire `<home>/evolution/evolve.lock` with run-lock semantics: exclusive creation, live-pid
 * refusal, stale replacement, and an explicit force override. Publication and state transitions
 * are atomic, and the owner token prevents stale handles from deleting a replacement.
 */
export function acquireEvolveLock(home: string, options: { force?: boolean } = {}): EvolveLock {
  const path = evolveLockPath(home);
  const info = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), owner: randomUUID() };
  withTransition(home, () => {
    if (existsSync(path)) {
      const held = readEvolveLock(home);
      if (!options.force && held && isAlive(held.pid)) {
        throw new EvolveLockedError(
          `evolution is locked by pid ${held.pid} on ${held.host} since ${held.startedAt}; ` +
            "wait for it to finish or re-run with --force",
        );
      }
      remove(path);
    }
    publish(home, path, info);
  });
  return { info, path, release: () => releaseEvolveLock(home, info.owner) };
}

/** Release a matching acquisition; an owner-less lock or replacement is preserved. */
export function releaseEvolveLock(home: string, owner: string): void {
  withTransition(home, () => {
    const held = readEvolveLock(home);
    if (!held || held.owner !== owner) return;
    remove(evolveLockPath(home));
  });
}
