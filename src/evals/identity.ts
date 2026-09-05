import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalSplit, SeedSplit } from "./seeds";
import { loadSeeds, sha256Bytes } from "./seeds";

export interface SeedIdentity {
  id: string;
  split: SeedSplit;
  sha256: string;
}

/** createRun adds exactly one final newline when argv text has none; identity mirrors those bytes. */
export function seedRunText(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Resolve every seed source, including pasted argv text, by its eventual seed.md byte hash. */
/** Pure split lookup for callers that already loaded and verified split.json. */
export function seedIdentityFromSplit(text: string, split: EvalSplit): SeedIdentity | undefined {
  const hash = sha256Bytes(seedRunText(text));
  const found = split.seeds.find((seed) => seed.sha256 === hash);
  return found ? { id: found.id, split: found.split, sha256: found.sha256 } : undefined;
}

export function seedIdentity(text: string, split: EvalSplit): SeedIdentity | undefined;
export function seedIdentity(home: string, text: string): SeedIdentity | undefined;
/**
 * Resolve identity either from an already verified split or directly from a home. Both forms use
 * the exact bytes createRun will persist, so argv text without its final newline is recognised.
 */
export function seedIdentity(first: string, second: string | EvalSplit): SeedIdentity | undefined {
  if (typeof second !== "string") return seedIdentityFromSplit(first, second);
  const hash = sha256Bytes(seedRunText(second));
  const found = loadSeeds(first).find((seed) => seed.sha256 === hash);
  return found ? { id: found.id, split: found.split, sha256: found.sha256 } : undefined;
}

export class HeldoutSeedError extends Error {
  readonly code = "heldout_seed";
  constructor(readonly seedId: string, message: string) {
    super(message);
    this.name = "HeldoutSeedError";
  }
}

/**
 * Later CLI integration calls this before createRun. A held-out seed is legal only inside an
 * already-created eval work directory; path separators and symlinked directories are refused.
 */
function realFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function evalInProgress(home: string, evalId: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(evalId) || evalId === "." || evalId === "..") return false;
  const work = join(home, "evolution", "work", evalId);
  const report = join(home, "evolution", "reports", evalId, "eval.json");
  if (!realDirectory(work) || !realFile(report)) return false;
  try {
    const value = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
    return value.evalId === evalId && value.verdict === "incomplete";
  } catch {
    return false;
  }
}

export function requireHeldoutEval(home: string, identity: SeedIdentity | undefined, evalId?: string): void {
  if (!identity || identity.split !== "heldout") return;
  if (!evalId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(evalId) || evalId === "." || evalId === "..") {
    throw new HeldoutSeedError(identity.id, `held-out seed ${identity.id} requires --eval <evalId>`);
  }
  if (!evalInProgress(home, evalId)) throw new HeldoutSeedError(identity.id,
    `held-out seed ${identity.id} requires eval ${evalId} to be in progress`);
}

export const assertSeedAllowed = requireHeldoutEval;
