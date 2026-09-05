import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireHeldoutEval, seedIdentityFromSplit, type SeedIdentity } from "../../evals/identity";
import type { ManifestVerification } from "../../evals/manifest";
import { loadSplit, type EvalSplit, type SeedEntry } from "../../evals/seeds";

export interface NewSeedInput { text: string; identity?: SeedIdentity }

function canonicalEntry(entry: SeedEntry | undefined): entry is SeedEntry {
  if (!entry) return false;
  const match = /^(dev|heldout)-(research|product|creative)-\d{2}$/.exec(entry.id);
  return match !== null && entry.split === match[1] && entry.shape === match[2]
    && entry.file === `seeds/${entry.split}/${entry.id}.md` && /^[a-f0-9]{64}$/.test(entry.sha256);
}

function identityFrom(text: string, split: EvalSplit): SeedIdentity | undefined {
  const identity = seedIdentityFromSplit(text, split);
  return identity && canonicalEntry(split.seeds.find((entry) => entry.id === identity.id)) ? identity : undefined;
}

function identityForText(home: string, text: string): SeedIdentity | undefined {
  try { return identityFrom(text, loadSplit(home)); }
  catch { return undefined; }
}

/** Resolve exactly one seed source and enforce held-out admission before any run directory exists. */
export function resolveNewSeed(home: string, words: readonly string[], flags: Record<string, string | boolean>): NewSeedInput {
  const seedId = flags["seed-id"];
  const seedFile = flags["seed-file"];
  const text = words.join(" ");
  const sources = Number(text.length > 0) + Number(seedId !== undefined) + Number(seedFile !== undefined);
  if (sources !== 1) throw new Error("run new requires exactly one of argv seed text, --seed-id ID, or --seed-file PATH");
  if (flags.eval !== undefined && typeof flags.eval !== "string") throw new Error("--eval requires an eval id");

  let input: NewSeedInput;
  if (seedId !== undefined) {
    if (typeof seedId !== "string" || seedId.trim() === "") throw new Error("--seed-id requires a seed id");
    const definition = loadSplit(home);
    const seed = definition.seeds.find((entry) => entry.id === seedId);
    if (!seed) throw new Error(`unknown eval seed ${seedId}`);
    if (!canonicalEntry(seed)) throw new Error(`cannot safely resolve eval seed ${seedId}`);
    const path = join(home, "evals", ...seed.file.split("/"));
    let fileText: string;
    try { fileText = readFileSync(path, "utf8"); }
    catch (error) { throw new Error(`cannot read eval seed ${seedId}: ${error instanceof Error ? error.message : String(error)}`); }
    input = { text: fileText, identity: identityFrom(fileText, definition) };
  } else if (seedFile !== undefined) {
    if (typeof seedFile !== "string" || seedFile.trim() === "") throw new Error("--seed-file requires a path");
    const path = resolve(seedFile);
    let fileText: string;
    try { fileText = readFileSync(path, "utf8"); }
    catch (error) { throw new Error(`cannot read seed file ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    input = { text: fileText, identity: identityForText(home, fileText) };
  } else {
    input = { text, identity: identityForText(home, text) };
  }
  requireHeldoutEval(home, input.identity, typeof flags.eval === "string" ? flags.eval : undefined);
  return input;
}

export function manifestDriftNote(verification: ManifestVerification): string | undefined {
  if (verification.ok) return undefined;
  const parts = [
    ...verification.changed.map((path) => `changed:${path}`),
    ...verification.missing.map((path) => `missing:${path}`),
    ...verification.extra.map((path) => `extra:${path}`),
  ];
  return `eval manifest drift: ${parts.join(", ") || "manifest.json invalid"}`;
}
