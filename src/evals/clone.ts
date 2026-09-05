import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "../core/paths";
import { hashInput, RunRecord } from "../core/record";
import { runPaths, type RunPaths, type RunStatus } from "../core/run";
import { parseFeatures, type FeaturesFile } from "../formation/features";
import { verifyAcceptanceLock } from "../formation/lock";
import { projectPaths, readProjectMarker } from "../formation/paths";

function safeRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") throw new TypeError("run id must be one safe path segment");
}

function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function regular(path: string, label: string): void {
  const held = entry(path);
  if (!held || held.isSymbolicLink() || !held.isFile()) throw new Error(`${label} must be a regular file`);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function physicalMissing(path: string): string {
  let cursor = resolve(path); const tail: string[] = [];
  while (!entry(cursor)) { const parent = dirname(cursor); if (parent === cursor) break; tail.unshift(cursor.slice(parent.length + 1)); cursor = parent; }
  return resolve(realpathSync(cursor), ...tail);
}

/** Relative in-tree links remain in-tree after copying; absolute, escaping, cyclic, and indirect escapes do not. */
function assertSafeSymlinks(root: string): void {
  const lexicalRoot = resolve(root); const physicalRoot = realpathSync(root);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name); const held = lstatSync(path);
      if (held.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (isAbsolute(link)) throw new Error(`clone source contains an unsafe symlink: ${relative(root, path)}`);
        const target = resolve(dirname(path), link);
        if (!inside(lexicalRoot, target) || !inside(physicalRoot, physicalMissing(target))) {
          throw new Error(`clone source contains an unsafe symlink: ${relative(root, path)}`);
        }
      } else if (held.isDirectory()) walk(path);
    }
  };
  walk(root);
}

function assertSameCloneTree(source: string, target: string, relativePath = ""): void {
  const ignored = relativePath === "status.json" || relativePath === join("project", "project.json");
  if (ignored) return;
  const a = entry(source); const b = entry(target);
  const sameKind = a && b && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile() && a.isSymbolicLink() === b.isSymbolicLink();
  if (!sameKind) throw new Error(`published clone differs from source at ${relativePath || "."}`);
  if (a!.isSymbolicLink()) {
    if (readlinkSync(source) !== readlinkSync(target)) throw new Error(`published clone differs from source at ${relativePath}`);
    return;
  }
  if (a!.isFile()) {
    if (!readFileSync(source).equals(readFileSync(target))) throw new Error(`published clone differs from source at ${relativePath}`);
    return;
  }
  if (!a!.isDirectory()) return;
  const sourceNames = readdirSync(source).sort(); const targetNames = readdirSync(target).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) throw new Error(`published clone differs from source at ${relativePath || "."}`);
  for (const name of sourceNames) assertSameCloneTree(join(source, name), join(target, name), relativePath ? join(relativePath, name) : name);
}

function parseStatus(source: RunPaths, fromId: string): RunStatus {
  regular(source.status, `source run ${fromId} status`);
  regular(source.record, `source run ${fromId} record`);
  const status = JSON.parse(readFileSync(source.status, "utf8")) as RunStatus;
  if (status.id !== fromId) throw new Error(`source run identity mismatch: expected ${fromId}, found ${status.id}`);
  if (entry(source.lock)) throw new Error(`source run ${fromId} is still locked`);
  return status;
}

function validateFreeze(source: RunPaths, fromId: string, status: RunStatus): void {
  const heldProject = entry(source.project);
  if (heldProject?.isSymbolicLink()) throw new Error(`clone needs a run-local project; source run ${fromId} project is a symlink`);
  if (!heldProject?.isDirectory() || status.phase !== "build" || status.state !== "running") throw new Error(`source run ${fromId} is not at the freeze boundary`);
  const project = projectPaths(source.project);
  for (const [path, label] of [[project.repo, "repo"], [project.checksDir, "checks"], [project.blockedDir, "blocked"]] as const) {
    const held = entry(path);
    if (!held?.isDirectory() || held.isSymbolicLink()) throw new Error(`source run ${fromId} project ${label} must be a real directory`);
  }
  const marker = readProjectMarker(source.project);
  if (!marker || marker.runId !== fromId) throw new Error(`source run ${fromId} project marker does not match its run identity`);
  if (!status.projectDir || realpathSync(status.projectDir) !== realpathSync(source.project)) throw new Error(`source run ${fromId} projectDir is not its run-local project`);
  for (const [path, label] of [
    [source.features, "features.json"], [source.acceptanceLock, "acceptance.lock"], [source.featureState, "state.jsonl"],
    [project.spec, "project spec"], [project.initSh, "project init.sh"], [project.featuresMirror, "project features mirror"], [project.lockMirror, "project lock mirror"],
  ] as const) regular(path, `source run ${fromId} ${label}`);
  if (readFileSync(source.featureState).length !== 0) throw new Error(`source run ${fromId} has already started building`);
  const specHash = hashInput(readFileSync(project.spec, "utf8"));
  if (!status.specHash || status.specHash !== specHash) throw new Error(`source run ${fromId} spec hash does not match its frozen project`);
  const features = parseFeatures(readFileSync(source.features, "utf8")) as FeaturesFile;
  const lock = JSON.parse(readFileSync(source.acceptanceLock, "utf8"));
  const verified = verifyAcceptanceLock(features, lock, specHash);
  if (!verified.ok || verified.specDrift) throw new Error(`source run ${fromId} acceptance lock is invalid: ${verified.changed.join(", ") || "specHash"}`);
  if (!readFileSync(source.features).equals(readFileSync(project.featuresMirror))) throw new Error(`source run ${fromId} features mirror differs from its freeze`);
  if (!readFileSync(source.acceptanceLock).equals(readFileSync(project.lockMirror))) throw new Error(`source run ${fromId} acceptance lock mirror differs from its freeze`);
  if (!new RunRecord(source.record).read().some((event) => event.t === "freeze" && event.specHash === specHash)) throw new Error(`source run ${fromId} has no matching freeze event`);
}

function boundary(source: RunPaths, fromId: string, status: RunStatus): "checkpoint" | "freeze" {
  const checkpoint = status.phase === "ideate" && status.cursor?.step === "checkpoint";
  if (checkpoint) {
    if (entry(source.project) || status.projectDir !== undefined) throw new Error(`source run ${fromId} checkpoint already has a project`);
    regular(source.frontier, `source run ${fromId} frontier`);
    return "checkpoint";
  }
  validateFreeze(source, fromId, status);
  return "freeze";
}

export interface CloneRunOptions {
  fromHome: string;
  fromId: string;
  toHome: string;
  toId: string;
  boundary?: "checkpoint" | "freeze";
}

interface CloneOwner extends CloneRunOptions { version: 1; pid: number }

function processIsLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function cleanOwnedTemps(parent: string, options: CloneRunOptions): void {
  const prefix = `.clone-${options.toId}-`;
  for (const name of readdirSync(parent).filter((value) => value.startsWith(prefix))) {
    const path = join(parent, name); const held = entry(path);
    if (!held?.isDirectory() || held.isSymbolicLink()) continue;
    try {
      const owner = JSON.parse(readFileSync(join(path, ".kiln-clone-owner.json"), "utf8")) as CloneOwner;
      const ours = owner.version === 1 && owner.fromId === options.fromId && owner.toId === options.toId
        && realpathSync(owner.fromHome) === realpathSync(options.fromHome) && realpathSync(owner.toHome) === realpathSync(options.toHome);
      if (ours && !processIsLive(owner.pid)) rmSync(path, { recursive: true, force: true });
    } catch { /* Unknown directories are user content, never cleanup candidates. */ }
  }
}

/** Return an already-published clone only when it is still the exact validated source snapshot. */
export function findPublishedCloneAcrossHomes(options: CloneRunOptions): RunPaths | undefined {
  const { fromHome, fromId, toHome, toId } = options;
  safeRunId(fromId); safeRunId(toId);
  if (realpathSync(fromHome) === realpathSync(toHome) && fromId === toId) throw new Error("clone destination must differ from its source");
  const source = runPaths(fromHome, fromId); const target = runPaths(toHome, toId);
  const heldTarget = entry(target.dir);
  if (!heldTarget) return undefined;
  if (!heldTarget.isDirectory() || heldTarget.isSymbolicLink()) throw new Error(`published clone destination run ${toId} must be a real directory`);
  const targetParent = entry(dirname(target.dir));
  if (!targetParent?.isDirectory() || targetParent.isSymbolicLink() || !inside(realpathSync(toHome), realpathSync(dirname(target.dir)))) {
    throw new Error("clone destination runs path must be a real directory inside its staged home");
  }
  const sourceDir = entry(source.dir);
  if (!sourceDir?.isDirectory() || sourceDir.isSymbolicLink()) throw new Error(`source run ${fromId} does not exist as a real directory`);
  const sourceStatus = parseStatus(source, fromId); const sourceBoundary = boundary(source, fromId, sourceStatus);
  if (options.boundary && options.boundary !== sourceBoundary) throw new Error(`source run ${fromId} is at ${sourceBoundary}, not ${options.boundary}`);
  const targetStatus = parseStatus(target, toId); const targetBoundary = boundary(target, toId, targetStatus);
  if (targetBoundary !== sourceBoundary) throw new Error(`published clone destination run ${toId} is at ${targetBoundary}, not ${sourceBoundary}`);
  const expectedStatus = sourceBoundary === "freeze" ? { ...sourceStatus, id: toId, projectDir: target.project } : { ...sourceStatus, id: toId };
  if (JSON.stringify(targetStatus) !== JSON.stringify(expectedStatus)) throw new Error(`published clone destination run ${toId} status differs from its source`);
  assertSafeSymlinks(source.dir); assertSafeSymlinks(target.dir); assertSameCloneTree(source.dir, target.dir);
  if (sourceBoundary === "freeze") {
    const sourceMarker = readProjectMarker(source.project)!; const targetMarker = readProjectMarker(target.project)!;
    if (JSON.stringify(targetMarker) !== JSON.stringify({ ...sourceMarker, runId: toId })) throw new Error(`published clone destination run ${toId} project marker differs from its source`);
  }
  return target;
}

/** Clone across staged homes and publish only after validation and the private copy complete. */
export function cloneRunAcrossHomes(options: CloneRunOptions): RunPaths {
  const { fromHome, fromId, toHome, toId } = options;
  safeRunId(fromId); safeRunId(toId);
  if (realpathSync(fromHome) === realpathSync(toHome) && fromId === toId) throw new Error("clone destination must differ from its source");
  const source = runPaths(fromHome, fromId); const target = runPaths(toHome, toId);
  const sourceDir = entry(source.dir);
  if (!sourceDir?.isDirectory() || sourceDir.isSymbolicLink()) throw new Error(`source run ${fromId} does not exist as a real directory`);
  if (entry(source.project)?.isSymbolicLink()) throw new Error(`clone needs a run-local project; source run ${fromId} project is a symlink`);
  const targetParent = entry(dirname(target.dir));
  if (!targetParent?.isDirectory() || targetParent.isSymbolicLink() || !inside(realpathSync(toHome), realpathSync(dirname(target.dir)))) {
    throw new Error("clone destination runs path must be a real directory inside its staged home");
  }
  if (entry(target.dir)) throw new Error(`clone destination run ${toId} already exists`);
  const status = parseStatus(source, fromId);
  const cloneBoundary = boundary(source, fromId, status);
  if (options.boundary && options.boundary !== cloneBoundary) throw new Error(`source run ${fromId} is at ${cloneBoundary}, not ${options.boundary}`);
  assertSafeSymlinks(source.dir);

  cleanOwnedTemps(dirname(target.dir), options);
  const temporary = mkdtempSync(join(dirname(target.dir), `.clone-${toId}-`));
  const payload = join(temporary, "payload");
  try {
    writeAtomic(join(temporary, ".kiln-clone-owner.json"), `${JSON.stringify({ ...options, version: 1, pid: process.pid })}\n`);
    cpSync(source.dir, payload, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });
    const clonedStatus = cloneBoundary === "freeze" ? { ...status, id: toId, projectDir: target.project } : { ...status, id: toId };
    writeAtomic(join(payload, "status.json"), `${JSON.stringify(clonedStatus, null, 2)}\n`);
    if (cloneBoundary === "freeze") {
      const markerPath = join(payload, "project", "project.json");
      const marker = readProjectMarker(join(payload, "project"))!;
      writeAtomic(markerPath, `${JSON.stringify({ ...marker, runId: toId }, null, 2)}\n`);
    }
    if (entry(target.dir)) throw new Error(`clone destination run ${toId} already exists`);
    renameSync(payload, target.dir);
    rmSync(temporary, { recursive: true, force: true });
    return target;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Back-compatible same-home clone used by M2 and direct callers. */
export function cloneFormedRun(home: string, fromId: string, toId: string): RunPaths {
  return cloneRunAcrossHomes({ fromHome: home, fromId, toHome: home, toId });
}
