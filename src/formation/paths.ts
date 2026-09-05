import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";

export interface ProjectPaths {
  dir: string;
  projectJson: string;
  spec: string;
  initSh: string;
  progress: string;
  audit: string;
  checksDir: string;
  blockedDir: string;
  repo: string;
  featuresMirror: string;
  lockMirror: string;
}

export interface ProjectMarker {
  runId: string;
  ideaId: string;
  kilnVersion: string;
  createdAt: string;
}

export function projectPaths(dir: string): ProjectPaths {
  return {
    dir,
    projectJson: join(dir, "project.json"),
    spec: join(dir, "spec.md"),
    initSh: join(dir, "init.sh"),
    progress: join(dir, "progress.md"),
    audit: join(dir, "audit.md"),
    checksDir: join(dir, "checks"),
    blockedDir: join(dir, "blocked"),
    repo: join(dir, "repo"),
    featuresMirror: join(dir, "features.json"),
    lockMirror: join(dir, "acceptance.lock"),
  };
}

function validMarker(value: unknown): value is ProjectMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return ["runId", "ideaId", "kilnVersion", "createdAt"].every((key) => typeof marker[key] === "string" && marker[key] !== "");
}

export function readProjectMarker(dir: string): ProjectMarker | undefined {
  const path = projectPaths(dir).projectJson;
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validMarker(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeProjectMarker(dir: string, marker: ProjectMarker): void {
  writeAtomic(projectPaths(dir).projectJson, `${JSON.stringify(marker, null, 2)}\n`);
}

function emptyDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/** Decide without mutating: force authorizes adoption but never deletion. */
export function adoptDecision(
  dir: string,
  runId: string,
  ideaId: string,
  opts: { force?: boolean } = {},
): "adopt" | `refuse:${string}` {
  // existsSync follows links and returns false for a dangling symlink. Adoption must inspect the
  // directory entry itself or a dangling link would be mistaken for an unused path.
  if (!existsEntry(dir)) return "adopt";
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    return `refuse:cannot inspect project directory: ${(error as Error).message}`;
  }
  if (!stat.isDirectory()) return "refuse:project path is not a directory";
  if (opts.force) return "adopt";

  const entries = readdirSync(dir);
  if (entries.length === 0) return "adopt";
  const markerPath = projectPaths(dir).projectJson;
  const marker = readProjectMarker(dir);
  if (marker) {
    if (marker.runId !== runId) return `refuse:project.json belongs to run ${marker.runId}`;
    if (marker.ideaId !== ideaId) return `refuse:project.json belongs to idea ${marker.ideaId}`;
    return "adopt";
  }
  if (existsSync(markerPath)) return "refuse:project.json is invalid";

  const allowed = new Set(["project.json", "checks", "blocked"]);
  const onlyReserved = entries.every((entry) => allowed.has(entry));
  const emptyReserved = ["checks", "blocked"].every((entry) => !entries.includes(entry) || emptyDirectory(join(dir, entry)));
  if (onlyReserved && emptyReserved && entries.includes("project.json")) return "refuse:project.json is invalid";
  return `refuse:non-empty unmarked project directory (${entries.sort().join(", ")})`;
}

function resolvedLink(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

/** Resolve the longest existing ancestor and append any missing tail; only link traversal is capped. */
function physicalPath(path: string, linkHops = 0): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (linkHops >= 16) throw new Error(`refuse:too many symbolic links while resolving ${path}`);
        return resolve(physicalPath(resolvedLink(current), linkHops + 1), ...missing);
      }
      return resolve(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertExternal(run: RunPaths, candidate: string): void {
  const physicalRun = physicalPath(run.dir);
  // Do not follow an already-installed project symlink when identifying the entry itself: its
  // physical location is the `project` name under the physical run directory.
  const physicalEntry = join(physicalRun, basename(run.project));
  const physicalCandidate = physicalPath(candidate);
  if (inside(physicalRun, physicalCandidate) || physicalCandidate === physicalEntry) {
    throw new Error(`refuse:--out must resolve outside the run directory (${physicalCandidate})`);
  }

  // A run is always `<home>/runs/<id>`. The rest of the home contains evaluator material and
  // harness state; making one of those trees the form brain's writable root would bypass their
  // file-level protections. Other run projects remain valid clone/eval targets.
  const physicalRuns = physicalPath(dirname(physicalRun));
  const physicalHome = physicalPath(dirname(physicalRuns));
  if (inside(physicalHome, physicalCandidate) && !inside(physicalRuns, physicalCandidate)) {
    throw new Error(`refuse:--out must not resolve inside the kiln home outside runs/ (${physicalCandidate})`);
  }
}

function installSymlink(entry: string, target: string, force: boolean): void {
  if (existsEntry(entry)) {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) {
      let matches = resolvedLink(entry) === target;
      try { matches ||= realpathSync(entry) === realpathSync(target); } catch { /* dangling link */ }
      if (matches) return;
      if (!force) throw new Error(`refuse:project link points to ${resolvedLink(entry)}, expected ${target}`);
    } else if (stat.isDirectory() && readdirSync(entry).length === 0 && force) {
      rmSync(entry, { recursive: false });
    } else {
      throw new Error("refuse:run project entry already exists and is not the requested link");
    }
  }
  const temp = `${entry}.${process.pid}.${randomUUID()}.tmp`;
  symlinkSync(target, temp, "dir");
  try {
    renameSync(temp, entry);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function installDirectory(entry: string, force: boolean): void {
  try {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) return;
    if (!stat.isSymbolicLink() || !force) throw new Error("refuse:run project entry is not a directory");
    rmSync(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${entry}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(temp, { recursive: false });
  try {
    renameSync(temp, entry);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Materialize the stable run-side project entry. `ideaId` is explicit because an explicit form
 * selection is authoritative over a stale status choice.
 */
export function materializeProjectPath(
  run: RunPaths,
  out: string | undefined,
  opts: { force?: boolean; ideaId: string; kilnVersion?: string; createdAt?: string; deferMarker?: boolean },
): ProjectPaths {
  const force = opts.force === true;
  const entry = resolve(run.project);
  if (out === undefined) {
    installDirectory(entry, force);
    const decision = adoptDecision(entry, run.id, opts.ideaId, { force });
    if (decision !== "adopt") throw new Error(decision);
  } else {
    const requested = resolve(out);
    // Physical comparison must follow aliases, but the stable entry itself remains reserved even
    // after it is a symlink whose realpath is a legitimate external target.
    if (requested === entry) throw new Error(`refuse:--out cannot be the run project entry (${entry})`);
    // Check before mkdir/adoption so a missing child beneath a symlinked parent cannot write into
    // the run, then check the final realpath again immediately before adoption and marker writes.
    assertExternal(run, requested);
    try {
      // Follow a valid user-supplied directory symlink; adoption and the run-side link both use
      // the resolved directory. A dangling symlink reaches the ENOENT branch below and is refused.
      const stat = statSync(requested);
      if (!stat.isDirectory()) throw new Error(`refuse:project target is not a directory: ${requested}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsEntry(requested)) mkdirSync(requested, { recursive: true });
      else throw error;
    }
    const target = realpathSync(requested);
    assertExternal(run, target);
    const decision = adoptDecision(target, run.id, opts.ideaId, { force });
    if (decision !== "adopt") throw new Error(decision);
    installSymlink(entry, target, force);
  }

  const paths = projectPaths(entry);
  if (opts.deferMarker) return paths;
  const existing = readProjectMarker(paths.dir);
  if (!existing || existing.runId !== run.id || existing.ideaId !== opts.ideaId) {
    writeProjectMarker(paths.dir, {
      runId: run.id,
      ideaId: opts.ideaId,
      kilnVersion: opts.kilnVersion ?? "0.1.0",
      createdAt: opts.createdAt ?? new Date().toISOString(),
    });
  }
  return paths;
}

function existsEntry(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
