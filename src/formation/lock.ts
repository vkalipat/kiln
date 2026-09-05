import { existsSync, readFileSync } from "node:fs";
import { hashInput, type RunRecord } from "../core/record";
import { writeAtomic } from "../core/paths";
import { writeStatus, type RunPaths } from "../core/run";
import type { FeaturesFile } from "./features";
import { projectPaths } from "./paths";

export interface AcceptanceLock {
  version: 1;
  ids: string;
  init: string;
  features: Record<string, string>;
  specHash: string;
}

/** Construct the deterministic lock. Persistence belongs to freeze or explicit relock. */
export function writeAcceptanceLock(file: FeaturesFile, specHash: string): AcceptanceLock {
  return {
    version: 1,
    ids: hashInput(file.features.map((feature) => feature.id)),
    init: hashInput(file.init),
    features: Object.fromEntries(file.features.map((feature) => [feature.id, hashInput(feature.acceptance)])),
    specHash,
  };
}

export function verifyAcceptanceLock(
  file: FeaturesFile,
  lock: unknown,
  currentSpecHash: string,
): { ok: boolean; changed: string[]; specDrift: boolean } {
  const changed: string[] = [];
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    return { ok: false, changed: ["lock"], specDrift: false };
  }
  const value = lock as Record<string, unknown>;
  const specHash = typeof value.specHash === "string" ? value.specHash : undefined;
  const expected = writeAcceptanceLock(file, specHash ?? "");
  if (value.version !== 1) changed.push("version");
  if (typeof value.ids !== "string" || value.ids !== expected.ids) changed.push("ids");
  if (typeof value.init !== "string" || value.init !== expected.init) changed.push("init");
  const hashes = value.features;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    changed.push("features");
  } else {
    const actual = hashes as Record<string, unknown>;
    for (const id of [...new Set([...Object.keys(expected.features), ...Object.keys(actual)])].sort()) {
      if (typeof actual[id] !== "string" || actual[id] !== expected.features[id]) changed.push(`features.${id}`);
    }
  }
  if (specHash === undefined) changed.push("specHash");
  return { ok: changed.length === 0, changed, specDrift: specHash !== undefined && currentSpecHash !== specHash };
}

function previousHash(path: string): string {
  if (!existsSync(path)) return hashInput(null);
  const text = readFileSync(path, "utf8");
  try { return hashInput(JSON.parse(text)); } catch { return hashInput(text); }
}

export function relock(paths: RunPaths, file: FeaturesFile, currentSpecHash: string, record: RunRecord): AcceptanceLock {
  const before = previousHash(paths.acceptanceLock);
  const lock = writeAcceptanceLock(file, currentSpecHash);
  const rendered = `${JSON.stringify(lock, null, 2)}\n`;
  writeAtomic(paths.acceptanceLock, rendered);
  writeAtomic(projectPaths(paths.project).lockMirror, rendered);
  const after = hashInput(lock);
  record.append({ t: "relock", before, after, confirmed: true });
  writeStatus(paths, { specHash: currentSpecHash, relocked: true });
  return lock;
}
