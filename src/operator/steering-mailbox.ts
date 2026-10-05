import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { readRunLock } from "../core/lock";
import { runControlGeneration } from "../core/pause-request";
import { writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";

/** Requests target one lock generation; a later owner can never replay an old direction. */
export function requestOperatorSteering(run: RunPaths, text: string) {
  if (!text.trim() || Buffer.byteLength(text) > 65536) throw new Error("Steering text must be 1..65536 bytes");
  const holder = readRunLock(run);
  let alive = false;
  if (holder?.host === hostname() && Number.isSafeInteger(holder.pid) && holder.pid > 0) {
    try { process.kill(holder.pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  const generation = runControlGeneration(run);
  if (!alive || !generation) throw new Error("No active operator owns this run; use task resume with a follow-up");
  const prefix = `.steer-${generation}-`;
  if (readdirSync(run.toolOutputDir).filter(name => name.startsWith(prefix) && name.endsWith(".json")).length >= 32) throw new Error("Steering queue is full; wait for the active turn to consume it");
  const id = `${Date.now()}-${randomUUID()}`;
  writeAtomic(join(run.toolOutputDir, `${prefix}${id}.json`), JSON.stringify({ version: 1, generation, id, text }), { mode: 0o600 });
  return { runId: run.id, id, status: "queued" as const, generation };
}

export function watchOperatorSteering(run: RunPaths, deliver: (text: string) => Promise<unknown>, onError: (error: Error) => void, signal: AbortSignal) {
  const generation = runControlGeneration(run), prefix = `.steer-${generation}-`;
  let disposed = false, pending: Promise<void> | undefined;
  const poll = async () => {
    if (disposed || pending || !generation || signal.aborted || runControlGeneration(run) !== generation) return;
    const work = async () => {
      for (const name of readdirSync(run.toolOutputDir).filter(name => name.startsWith(prefix) && /^\.steer-[a-f0-9]{64}-\d+-[a-f0-9-]{36}\.json$/.test(name)).sort()) {
        if (disposed || signal.aborted || runControlGeneration(run) !== generation) return;
        const path = join(run.toolOutputDir, name), claim = `${path}.claim-${randomUUID()}`;
        try { renameSync(path, claim); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        try {
          const fd = openSync(claim, constants.O_RDONLY | constants.O_NOFOLLOW);
          let raw: unknown;
          try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 70000) throw new Error("Invalid steering request"); raw = JSON.parse(readFileSync(fd, "utf8")); }
          finally { closeSync(fd); }
          const request = raw as { version?: number; generation?: string; id?: string; text?: string };
          if (request.version !== 1 || request.generation !== generation || `${prefix}${request.id}.json` !== name
            || typeof request.text !== "string" || !request.text.trim() || Buffer.byteLength(request.text) > 65536) throw new Error("Invalid steering request");
          await deliver(request.text);
        } catch (error) { onError(error instanceof Error ? error : new Error("Steering delivery failed")); }
        finally { rmSync(claim, { force: true }); }
      }
    };
    pending = work().catch(error => onError(error instanceof Error ? error : new Error("Steering mailbox failed"))).finally(() => { pending = undefined; });
    await pending;
  };
  const timer = setInterval(() => { void poll(); }, 100); timer.unref();
  return async () => { disposed = true; clearInterval(timer); await pending; };
}
