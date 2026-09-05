import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { trigramJaccard } from "../ideation/novelty";

export const SEED_SHAPES = ["research", "product", "creative"] as const;
export const SEED_SPLITS = ["dev", "heldout"] as const;
export type SeedShape = (typeof SEED_SHAPES)[number];
export type SeedSplit = (typeof SEED_SPLITS)[number];

export interface SeedEntry {
  id: string;
  shape: SeedShape;
  split: SeedSplit;
  file: string;
  sha256: string;
  rationale: string;
}

export interface EvalSplit {
  version: 1;
  seeds: SeedEntry[];
}

export interface LoadedSeed extends SeedEntry {
  text: string;
  path: string;
}

export interface SplitVerification {
  ok: boolean;
  errors: string[];
  /** Alias used by integrity renderers; contains the same entries as errors. */
  problems: string[];
  missing: string[];
  extra: string[];
  changed: string[];
  maxPairwiseJaccard: number;
  maxCrossSplitJaccard: number;
}

export class EvalSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalSplitError";
  }
}

const ID = /^(dev|heldout)-(research|product|creative)-(\d{2})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const URL = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|edu|gov)\b)/i;

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evalsPath(home: string): string {
  return join(home, "evals");
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSplitValue(home: string): unknown {
  return JSON.parse(readFileSync(join(evalsPath(home), "split.json"), "utf8")) as unknown;
}

/** Parse split.json without reading seed text. Structural cross-checking belongs to verifySplit. */
export function loadSplit(home: string): EvalSplit {
  let value: unknown;
  try {
    value = readSplitValue(home);
  } catch (error) {
    throw new EvalSplitError(`cannot read evals/split.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.seeds)) {
    throw new EvalSplitError("evals/split.json must be { version: 1, seeds: [...] }");
  }
  return value as unknown as EvalSplit;
}

export const readSplit = loadSplit;

function listedSeedFiles(home: string, errors: string[]): string[] {
  const root = evalsPath(home);
  const files: string[] = [];
  for (const split of SEED_SPLITS) {
    const dir = join(root, "seeds", split);
    if (!existsSync(dir)) {
      errors.push(`missing seed directory evals/seeds/${split}`);
      continue;
    }
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
      errors.push(`seed directory evals/seeds/${split} must be a real directory`);
      continue;
    }
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = `seeds/${split}/${name}`;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        errors.push(`seed file evals/${rel} must not be a symlink`);
        files.push(rel);
      } else if (!stat.isFile()) {
        errors.push(`seed path evals/${rel} must be a regular file`);
        files.push(rel);
      } else if (!name.endsWith(".md")) {
        files.push(rel);
      } else {
        files.push(rel);
      }
    }
  }
  return files;
}

function seedTextProblems(entry: SeedEntry, text: string): string[] {
  const problems: string[] = [];
  const trimmed = text.trim();
  const chars = [...trimmed].length;
  const sentences = trimmed.match(/[.!?](?=\s|$)/g)?.length ?? 0;
  if (chars < 200 || chars > 900) problems.push(`must contain 200-900 characters (found ${chars})`);
  if (sentences < 2 || sentences > 6) problems.push(`must contain 2-6 sentences (found ${sentences})`);
  if (!text.endsWith("\n")) problems.push("must end with a newline");
  if (!new RegExp(`(?:^|\\n)Shape:\\s*${entry.shape}\\s*[.!?](?:\\s|$)`, "i").test(trimmed)) {
    problems.push(`must declare "Shape: ${entry.shape}."`);
  }
  if (URL.test(trimmed)) problems.push("must not contain a URL");
  if (trimmed.includes("`")) problems.push("must not contain a backticked identifier");
  return problems;
}

/**
 * Verify split.json against the directory that runners actually read. The report is deliberately
 * data-only so CLI callers can choose their own rendering and integrity failure class.
 */
export function verifySplit(home: string): SplitVerification {
  const errors: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  const changed: string[] = [];
  let value: unknown;
  try {
    value = readSplitValue(home);
  } catch (error) {
    errors.push(`cannot read evals/split.json: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, errors, problems: errors, missing, extra, changed, maxPairwiseJaccard: 0, maxCrossSplitJaccard: 0 };
  }
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.seeds)) {
    errors.push("evals/split.json must be { version: 1, seeds: [...] }");
    return { ok: false, errors, problems: errors, missing, extra, changed, maxPairwiseJaccard: 0, maxCrossSplitJaccard: 0 };
  }

  const rawSeeds = value.seeds;
  if (rawSeeds.length !== 24) errors.push(`split must contain 24 seeds (found ${rawSeeds.length})`);
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const seenHashes = new Map<string, string>();
  const entries: SeedEntry[] = [];
  const texts = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const [index, raw] of rawSeeds.entries()) {
    const where = `seeds[${index}]`;
    if (!isObject(raw)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    const { id, shape, split, file, sha256, rationale } = raw;
    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`${where}.id must match ${ID.source}`);
      continue;
    }
    const match = ID.exec(id)!;
    if (!SEED_SHAPES.includes(shape as SeedShape)) errors.push(`${where}.shape is invalid`);
    if (!SEED_SPLITS.includes(split as SeedSplit)) errors.push(`${where}.split is invalid`);
    if (shape !== match[2]) errors.push(`${where}.shape does not match id ${id}`);
    if (split !== match[1]) errors.push(`${where}.split does not match id ${id}`);
    const expectedFile = `seeds/${match[1]}/${id}.md`;
    const canonicalFile = typeof file === "string" && file === expectedFile && posix.normalize(file) === file;
    if (!canonicalFile) {
      errors.push(`${where}.file must be ${expectedFile}`);
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) errors.push(`${where}.sha256 must be lowercase SHA-256 hex`);
    if (typeof rationale !== "string" || rationale.trim().length === 0) errors.push(`${where}.rationale must be non-empty`);
    if (seenIds.has(id)) errors.push(`duplicate seed id ${id}`);
    if (typeof file === "string" && seenFiles.has(file)) errors.push(`duplicate seed file ${file}`);
    seenIds.add(id);
    if (typeof file === "string") seenFiles.add(file);

    if (SEED_SHAPES.includes(shape as SeedShape) && SEED_SPLITS.includes(split as SeedSplit)
      && canonicalFile && typeof sha256 === "string" && typeof rationale === "string") {
      const entry = { id, shape: shape as SeedShape, split: split as SeedSplit, file, sha256, rationale };
      entries.push(entry);
      const key = `${entry.split}/${entry.shape}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const full = join(evalsPath(home), ...file.split("/"));
      if (!existsSync(full)) {
        missing.push(file);
      } else {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          changed.push(file);
          errors.push(`evals/${file} must be a regular non-symlink file`);
        } else {
          const bytes = readFileSync(full);
          const text = bytes.toString("utf8");
          texts.set(id, text);
          if (sha256Bytes(bytes) !== sha256) changed.push(file);
          const previous = seenHashes.get(sha256Bytes(bytes));
          if (previous) errors.push(`${id} duplicates the exact text of ${previous}`);
          else seenHashes.set(sha256Bytes(bytes), id);
          for (const problem of seedTextProblems(entry, text)) errors.push(`${id}: ${problem}`);
        }
      }
    }
  }

  for (const split of SEED_SPLITS) {
    for (const shape of SEED_SHAPES) {
      const count = counts.get(`${split}/${shape}`) ?? 0;
      if (count !== 4) errors.push(`${split}/${shape} must contain 4 seeds (found ${count})`);
    }
  }

  const actualFiles = listedSeedFiles(home, errors);
  for (const file of actualFiles) if (!seenFiles.has(file)) extra.push(file);
  for (const file of seenFiles) if (!actualFiles.includes(file) && !missing.includes(file)) missing.push(file);

  let maxPairwiseJaccard = 0;
  let maxCrossSplitJaccard = 0;
  for (let left = 0; left < entries.length; left += 1) {
    const a = entries[left]!;
    const aText = texts.get(a.id);
    if (aText === undefined) continue;
    for (let right = left + 1; right < entries.length; right += 1) {
      const b = entries[right]!;
      const bText = texts.get(b.id);
      if (bText === undefined) continue;
      const score = trigramJaccard(aText, bText);
      maxPairwiseJaccard = Math.max(maxPairwiseJaccard, score);
      if (a.split !== b.split) maxCrossSplitJaccard = Math.max(maxCrossSplitJaccard, score);
      if (score >= 0.3) errors.push(`${a.id} and ${b.id} have trigram Jaccard ${score.toFixed(4)} (must be < 0.30)`);
      if (a.split !== b.split && score >= 0.25) errors.push(`${a.id} and ${b.id} have cross-split trigram Jaccard ${score.toFixed(4)} (must be < 0.25)`);
    }
  }

  const sorted = (items: string[]) => [...new Set(items)].sort();
  const result = {
    ok: errors.length === 0 && missing.length === 0 && extra.length === 0 && changed.length === 0,
    errors: sorted(errors),
    problems: sorted(errors),
    missing: sorted(missing),
    extra: sorted(extra),
    changed: sorted(changed),
    maxPairwiseJaccard,
    maxCrossSplitJaccard,
  };
  return result;
}

/** Load the verified seed set in split.json order, which is the runners' pre-registered order. */
export function loadSeeds(home: string, split?: SeedSplit): LoadedSeed[] {
  const verification = verifySplit(home);
  if (!verification.ok) {
    const details = [...verification.errors, ...verification.missing.map((p) => `missing evals/${p}`),
      ...verification.extra.map((p) => `extra evals/${p}`), ...verification.changed.map((p) => `changed evals/${p}`)];
    throw new EvalSplitError(`invalid eval seed split: ${details.join("; ")}`);
  }
  const definition = loadSplit(home);
  return definition.seeds
    .filter((entry) => split === undefined || entry.split === split)
    .map((entry) => {
      const path = join(evalsPath(home), ...entry.file.split("/"));
      return { ...entry, path, text: readFileSync(path, "utf8") };
    });
}

/** Relative evals path for diagnostics; exported for callers that need stable source labels. */
export function seedRelativePath(home: string, path: string): string {
  return slash(relative(evalsPath(home), path));
}
