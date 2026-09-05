import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function kilnHome(): string {
  return process.env.KILN_HOME && process.env.KILN_HOME.length > 0 ? process.env.KILN_HOME : join(homedir(), ".kiln");
}

export function runsDir(home: string): string {
  return join(home, "runs");
}

/** The reflector's playbook-delta candidate for one run; the directory is created by `initHome`. */
export function candidatePath(home: string, runId: string): string {
  return join(home, "evolution", "candidates", `${runId}.json`);
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

export interface WriteAtomicOptions {
  /** Permission bits for the file, applied to the temp file before it is ever named `path`,
   *  so a credential file is never world-readable even transiently. `chmod` follows the write
   *  because `writeFileSync`'s mode is masked by the process umask. */
  mode?: number;
}

export function writeAtomic(path: string, text: string, opts: WriteAtomicOptions = {}): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, opts.mode !== undefined ? { mode: opts.mode } : undefined);
  if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
  try {
    renameSync(tmp, path);
  } catch (e) {
    // The temp file still holds the full contents; leaving it behind would strand a
    // readable copy next to the target (and, for auth.json, a second credential file).
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone — nothing to clean up.
    }
    throw e;
  }
}

export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  // A crash mid-append can leave the file without a trailing newline; gluing the next line onto
  // that torn one would make both unparseable, so start on a fresh line when needed.
  const needsBreak = existsSync(path) && !endsWithNewline(path);
  appendFileSync(path, `${needsBreak ? "\n" : ""}${line.endsWith("\n") ? line : `${line}\n`}`);
}

function endsWithNewline(path: string): boolean {
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
