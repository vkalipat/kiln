import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { trigramJaccard } from "../ideation/novelty";
import { seedIdentity, type SeedIdentity } from "./identity";
import { verifyEvalsManifest, type ManifestVerification } from "./manifest";
import { loadSeeds, type LoadedSeed } from "./seeds";

export const LEAK_TRIGRAM_THRESHOLD = 0.35;
export const LEAK_SHINGLE_WORDS = 8;

export type LeakKind = "trigram" | "shingle" | "heldout_candidate" | "manifest" | "unsafe_source";
export interface LeakRow {
  kind: LeakKind;
  source: string;
  seedId: string;
  score: number;
}

export interface LeakcheckResult {
  ok: boolean;
  rows: LeakRow[];
  manifest: ManifestVerification;
}

export interface LeakcheckOptions {
  jaccardThreshold?: number;
  shingleWords?: number;
}

interface CorpusText { source: string; text: string }
interface CandidateSources { files: string[]; unsafe: string[] }
interface CandidateSeedResult { identity?: SeedIdentity; unsafe?: string }

function slash(path: string): string {
  return path.split(sep).join("/");
}

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

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function wordShingles(text: string, width = LEAK_SHINGLE_WORDS): Set<string> {
  const tokens = words(text);
  const out = new Set<string>();
  for (let index = 0; index + width <= tokens.length; index += 1) {
    out.add(tokens.slice(index, index + width).join(" "));
  }
  return out;
}

export function sharesWordShingle(a: string, b: string, width = LEAK_SHINGLE_WORDS): boolean {
  const left = wordShingles(a, width);
  const right = wordShingles(b, width);
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const shingle of small) if (large.has(shingle)) return true;
  return false;
}

function playbookCorpus(home: string): CorpusText[] {
  const path = join(home, "playbook", "playbook.md");
  if (!realFile(path)) return [];
  const rows: CorpusText[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    if (!line.startsWith("- ")) continue;
    const match = /^- (\S+) \[helpful:\d+ harmful:\d+\] (.+)$/.exec(line);
    rows.push({ source: `playbook/playbook.md#${match?.[1] ?? `line-${index + 1}`}`, text: match?.[2] ?? line.slice(2) });
  }
  return rows;
}

function promptCorpus(home: string): CorpusText[] {
  const dir = join(home, "prompts");
  if (!realDirectory(dir)) return [];
  const rows: CorpusText[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!name.endsWith(".md") || !realFile(path)) continue;
    const paragraphs = readFileSync(path, "utf8").split(/(?:\r?\n){2,}/).map((part) => part.trim()).filter(Boolean);
    for (const [index, text] of paragraphs.entries()) rows.push({ source: `prompts/${name}#paragraph-${index + 1}`, text });
  }
  return rows;
}

/** Enumerate only record section 8's candidate layouts; archived reports are not candidate text. */
function candidateSources(home: string): CandidateSources {
  const files: string[] = [];
  const unsafe: string[] = [];
  const inspectDirect = (name: "candidates" | "promoted"): void => {
    const root = join(home, "evolution", name);
    try {
      const rootStat = lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        unsafe.push(`evolution/${name}`);
        return;
      }
    } catch {
      return;
    }
    for (const entry of readdirSync(root).sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(root, entry);
      if (realFile(path)) files.push(path);
      else unsafe.push(`evolution/${name}/${entry}`);
    }
  };
  inspectDirect("candidates");
  inspectDirect("promoted");

  const archive = join(home, "evolution", "archive");
  try {
    const stat = lstatSync(archive);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unsafe.push("evolution/archive");
    else {
      for (const candidateId of readdirSync(archive).sort()) {
        const dir = join(archive, candidateId);
        if (!realDirectory(dir)) {
          unsafe.push(`evolution/archive/${candidateId}`);
          continue;
        }
        const candidate = join(dir, "candidate.json");
        if (realFile(candidate)) files.push(candidate);
        else unsafe.push(`evolution/archive/${candidateId}/candidate.json`);
      }
    }
  } catch {
    // An absent archive is valid before the first candidate is archived.
  }
  return { files: files.sort(), unsafe: unsafe.sort() };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function candidateTexts(candidate: Record<string, unknown>, source: string): CorpusText[] {
  const rows: CorpusText[] = [];
  const delta = object(candidate.delta);
  if (typeof delta?.text === "string" && delta.text.trim()) rows.push({ source: `${source}#delta.text`, text: delta.text });
  const prompt = object(candidate.prompt);
  if (typeof prompt?.text === "string" && prompt.text.trim()) rows.push({ source: `${source}#prompt.text`, text: prompt.text });
  // Tolerate the alternate prompt-candidate spelling in record section 8 while the schema settles.
  if (candidate.kind === "prompt" && typeof candidate.text === "string" && candidate.text.trim()) {
    rows.push({ source: `${source}#text`, text: candidate.text });
  }
  return rows;
}

function parsedIdentity(value: unknown): SeedIdentity | undefined {
  const identity = object(value);
  return typeof identity?.id === "string" && (identity.split === "dev" || identity.split === "heldout")
    && typeof identity.sha256 === "string"
    ? { id: identity.id, split: identity.split, sha256: identity.sha256 }
    : undefined;
}

function sameIdentity(a: SeedIdentity, b: SeedIdentity): boolean {
  return a.id === b.id && a.split === b.split && a.sha256 === b.sha256;
}

/** Resolve run status first, seed.md second, and copied candidate identity only as corroboration. */
function candidateSeed(home: string, candidate: Record<string, unknown>): CandidateSeedResult {
  const copied = parsedIdentity(candidate.seed);
  const noRunExpected = candidate.author === "operator" || candidate.kind === "prompt";
  if (candidate.runId === undefined && noRunExpected) return { identity: copied };
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0 || basename(candidate.runId) !== candidate.runId) {
    return { identity: copied, unsafe: "candidate has no safe runId" };
  }
  const runDir = join(home, "runs", candidate.runId);
  const statusPath = join(runDir, "status.json");
  if (realFile(statusPath)) {
    try {
      const status = object(JSON.parse(readFileSync(statusPath, "utf8")) as unknown);
      const identity = parsedIdentity(status?.seed);
      if (identity) return copied && !sameIdentity(identity, copied)
        ? { identity, unsafe: "candidate seed disagrees with run status" }
        : { identity };
    } catch {
      // A malformed status falls through to the exact seed.md hash.
    }
  }
  const seedPath = join(runDir, "seed.md");
  if (realFile(seedPath)) {
    const identity = seedIdentity(home, readFileSync(seedPath, "utf8"));
    if (identity) return copied && !sameIdentity(identity, copied)
      ? { identity, unsafe: "candidate seed disagrees with run seed.md" }
      : { identity };
  }
  return copied ? { identity: copied } : { unsafe: `cannot resolve run ${candidate.runId} to a registered seed` };
}

function manifestRows(manifest: ManifestVerification): LeakRow[] {
  return [
    ...manifest.changed.map((source) => ({ kind: "manifest" as const, source: `changed:${source}`, seedId: "", score: 1 })),
    ...manifest.missing.map((source) => ({ kind: "manifest" as const, source: `missing:${source}`, seedId: "", score: 1 })),
    ...manifest.extra.map((source) => ({ kind: "manifest" as const, source: `extra:${source}`, seedId: "", score: 1 })),
  ];
}

function pushUniqueSorted(rows: LeakRow[]): void {
  const unique = new Map<string, LeakRow>();
  for (const row of rows) unique.set(`${row.kind}\0${row.source}\0${row.seedId}`, row);
  rows.splice(0, rows.length, ...unique.values());
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || a.seedId.localeCompare(b.seedId));
}

/** Run the four unpaid checks against the verified held-out corpus and immutable manifest. */
export function leakcheck(home: string, options: LeakcheckOptions = {}): LeakcheckResult {
  const threshold = options.jaccardThreshold ?? LEAK_TRIGRAM_THRESHOLD;
  const shingleWords = options.shingleWords ?? LEAK_SHINGLE_WORDS;
  if (!(threshold >= 0 && threshold <= 1)) throw new Error("jaccardThreshold must be in [0, 1]");
  if (!Number.isInteger(shingleWords) || shingleWords < 1) throw new Error("shingleWords must be a positive integer");

  const manifest = verifyEvalsManifest(home);
  const rows = manifestRows(manifest);
  let heldout: LoadedSeed[];
  try {
    heldout = loadSeeds(home, "heldout");
  } catch {
    rows.push({ kind: "unsafe_source", source: "evals/split.json", seedId: "", score: 1 });
    pushUniqueSorted(rows);
    return { ok: false, rows, manifest };
  }

  const sources = candidateSources(home);
  for (const source of sources.unsafe) rows.push({ kind: "unsafe_source", source, seedId: "", score: 1 });
  const candidates: Array<{ source: string; value: Record<string, unknown> }> = [];
  for (const file of sources.files) {
    const source = slash(relative(home, file));
    try {
      const value = object(JSON.parse(readFileSync(file, "utf8")) as unknown);
      if (value) candidates.push({ source, value });
      else rows.push({ kind: "unsafe_source", source, seedId: "", score: 1 });
    } catch {
      rows.push({ kind: "unsafe_source", source, seedId: "", score: 1 });
    }
  }

  const corpus = [...playbookCorpus(home), ...promptCorpus(home),
    ...candidates.flatMap(({ source, value }) => candidateTexts(value, source))];
  for (const seed of heldout) {
    for (const item of corpus) {
      const score = trigramJaccard(seed.text, item.text);
      if (score >= threshold) rows.push({ kind: "trigram", source: item.source, seedId: seed.id, score });
      if (sharesWordShingle(seed.text, item.text, shingleWords)) rows.push({ kind: "shingle", source: item.source, seedId: seed.id, score: 1 });
    }
  }
  for (const { source, value } of candidates) {
    const resolved = candidateSeed(home, value);
    if (resolved.unsafe) rows.push({ kind: "unsafe_source", source, seedId: resolved.identity?.id ?? "", score: 1 });
    if (resolved.identity?.split === "heldout") rows.push({ kind: "heldout_candidate", source, seedId: resolved.identity.id, score: 1 });
  }
  pushUniqueSorted(rows);
  return { ok: rows.length === 0, rows, manifest };
}

export const leakCheck = leakcheck;
