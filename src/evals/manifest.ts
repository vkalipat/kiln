import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, sep } from "node:path";
import packageJson from "../../package.json";
import { writeAtomic } from "../core/paths";
import { evalsPath, sha256Bytes } from "./seeds";

export interface EvalsManifest {
  version: 1;
  kilnVersion: string;
  generatedAt: string;
  files: Record<string, string>;
}

export interface ManifestVerification {
  ok: boolean;
  changed: string[];
  missing: string[];
  extra: string[];
}

export interface BuildManifestOptions {
  generatedAt?: string | Date;
  kilnVersion?: string;
}

const HASH = /^[a-f0-9]{64}$/;

function slash(path: string): string {
  return path.split(sep).join("/");
}

export function manifestExcluded(path: string): boolean {
  return path === "manifest.json" || path === "calibration.json" || path === "effort.json"
    || path === "calibration" || path.startsWith("calibration/");
}

interface WalkResult {
  files: Map<string, string>;
  symlinks: string[];
}

function walkMaterial(home: string): WalkResult {
  const root = evalsPath(home);
  const files = new Map<string, string>();
  const symlinks: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (manifestExcluded(rel)) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        symlinks.push(rel);
      } else if (stat.isDirectory()) {
        visit(path, rel);
      } else if (stat.isFile()) {
        files.set(rel, sha256Bytes(readFileSync(path)));
      } else {
        symlinks.push(rel);
      }
    }
  };
  visit(root, "");
  return { files, symlinks };
}

/** Build the content object; writing it is deliberately kept in the build-time script. */
export function buildEvalsManifest(home: string, options: BuildManifestOptions = {}): EvalsManifest {
  const material = walkMaterial(home);
  if (material.symlinks.length > 0) throw new Error(`eval material must not contain symlinks: ${material.symlinks.join(", ")}`);
  const generatedAt = options.generatedAt instanceof Date
    ? options.generatedAt.toISOString()
    : options.generatedAt ?? new Date().toISOString();
  if (Number.isNaN(new Date(generatedAt).valueOf())) throw new Error("generatedAt must be a valid date");
  return {
    version: 1,
    kilnVersion: options.kilnVersion ?? packageJson.version,
    generatedAt,
    files: Object.fromEntries([...material.files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Build and atomically write the bundled manifest. Runtime code never calls this. */
export function writeEvalsManifest(home: string, options: BuildManifestOptions = {}): EvalsManifest {
  const manifest = buildEvalsManifest(home, options);
  writeAtomic(join(evalsPath(home), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function invalidManifest(): ManifestVerification {
  return { ok: false, changed: ["manifest.json"], missing: [], extra: [] };
}

function parseManifest(home: string): EvalsManifest | undefined {
  const path = join(evalsPath(home), "manifest.json");
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const manifest = value as Partial<EvalsManifest>;
    if (manifest.version !== 1 || manifest.kilnVersion !== packageJson.version
      || typeof manifest.generatedAt !== "string" || Number.isNaN(new Date(manifest.generatedAt).valueOf())
      || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) return undefined;
    for (const [file, hash] of Object.entries(manifest.files)) {
      if (file === "" || file.startsWith("/") || file.includes("\\") || posix.normalize(file) !== file
        || file.startsWith("../") || manifestExcluded(file) || typeof hash !== "string" || !HASH.test(hash)) return undefined;
    }
    return manifest as EvalsManifest;
  } catch {
    return undefined;
  }
}

/** Verify exact covered membership and byte hashes. Symlinks never satisfy a manifest entry. */
export function verifyEvalsManifest(home: string): ManifestVerification {
  const manifest = parseManifest(home);
  if (!manifest) return invalidManifest();
  let material: WalkResult;
  try {
    material = walkMaterial(home);
  } catch {
    return invalidManifest();
  }
  const changed: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  const expected = new Map(Object.entries(manifest.files));
  for (const [file, hash] of expected) {
    if (material.symlinks.includes(file)) changed.push(file);
    else if (!material.files.has(file)) missing.push(file);
    else if (material.files.get(file) !== hash) changed.push(file);
  }
  for (const file of material.files.keys()) if (!expected.has(file)) extra.push(file);
  for (const file of material.symlinks) {
    if (!expected.has(file)) extra.push(file);
  }
  const sorted = (items: string[]) => [...new Set(items.map(slash))].sort();
  const result = { changed: sorted(changed), missing: sorted(missing), extra: sorted(extra) };
  return { ok: result.changed.length === 0 && result.missing.length === 0 && result.extra.length === 0, ...result };
}
