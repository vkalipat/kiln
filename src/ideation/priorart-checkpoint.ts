import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hashInput } from "../core/record";
import { writeAtomic } from "../core/paths";
import type { PhaseDeps } from "../phases/frame";
import type { ScoutResult } from "../scouts/scout";

type Owner = Pick<PhaseDeps, "run" | "record">;
const VERSION = 1;
export const priorArtCacheDir = (run: { dir: string }): string => join(run.dir, "prior-art");
const prefix = (id: string) => `prior-art checkpoint ${id}: `;
function validId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("invalid prior-art checkpoint id");
}
function pathFor(deps: Owner, id: string, create: boolean): string | undefined {
  validId(id);
  const root = realpathSync(deps.run.dir);
  const dir = join(root, "prior-art");
  if (!existsSync(dir)) {
    if (!create) return undefined;
    mkdirSync(dir, { mode: 0o700 });
  }
  if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) throw new Error("redirected prior-art checkpoint directory");
  const path = join(dir, `${id}.json`);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (entry.isSymbolicLink() || !entry.isFile())) throw new Error("invalid prior-art checkpoint path");
  return path;
}
function receipt(deps: Owner, id: string): string | undefined {
  const event = deps.record.read().findLast((e) => e.t === "note" && e.text.startsWith(prefix(id)));
  return event?.t === "note" ? event.text.slice(prefix(id).length) : undefined;
}

/** A tombstone supersedes the receipt: old packet bytes cannot resurrect rejected coverage. */
export function retirePriorArtCheckpoint(deps: Owner, id: string): void {
  validId(id);
  deps.record.append({ t: "note", text: `${prefix(id)}retired` });
}

export function readPriorArtCheckpoint(deps: Owner, id: string, fingerprint: string): ScoutResult | undefined {
  const path = pathFor(deps, id, false);
  if (!path || !existsSync(path)) return undefined;
  try {
    const packet = JSON.parse(readFileSync(path, "utf8"));
    if (packet.version !== VERSION || packet.fingerprint !== fingerprint || packet.id !== id) return undefined;
    const { signature, ...body } = packet;
    if (typeof signature !== "string" || signature !== hashInput(body) || receipt(deps, id) !== signature) return undefined;
    const s = packet.scout as ScoutResult;
    if (!s || s.stopped !== "done" || typeof s.findings !== "string" || !s.findings.trim()
      || !Array.isArray(s.observedUrls) || !s.observedUrls.every((u) => typeof u === "string" && /^https?:\/\//.test(u))
      || !Array.isArray(s.searchHealth) || !s.searchHealth.every((v) => ["ok", "blocked", "failed"].includes(v))
      || !(s.searchHealth.includes("ok") || (s.successfulFetches ?? 0) > 0)
      || !Number.isFinite(s.costUsd) || s.costUsd < 0 || !Number.isSafeInteger(s.turns) || s.turns < 0
      || typeof s.contextPressure !== "boolean") return undefined;
    // Original cost and turns remain in the signed file; replay dispatches no new work.
    return { ...s, costUsd: 0, turns: 0 };
  } catch { return undefined; }
}

export function writePriorArtCheckpoint(deps: Owner, id: string, fingerprint: string, scout: ScoutResult): void {
  const path = pathFor(deps, id, true)!;
  const body = JSON.parse(JSON.stringify({ version: VERSION, id, fingerprint, scout }));
  const signature = hashInput(body);
  writeAtomic(path, `${JSON.stringify({ ...body, signature })}\n`, { mode: 0o600 });
  // Only a digest enters the canonical journal: no findings, URLs, credentials or sibling costs.
  deps.record.append({ t: "note", text: `${prefix(id)}${signature}` });
}
