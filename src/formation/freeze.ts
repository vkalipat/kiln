import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { GitRunner } from "../build/git";
import { writeAtomic } from "../core/paths";
import { hashInput } from "../core/record";
import type { StoredEvent } from "../core/events";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import type { PhaseDeps } from "../phases/frame";
import { parseFeatures, type FeaturesFile } from "./features";
import { verifyAcceptanceLock, writeAcceptanceLock, type AcceptanceLock } from "./lock";
import { projectPaths } from "./paths";

export interface FreezeResult {
  file: FeaturesFile;
  lock: AcceptanceLock;
  needsUnion: string[];
  initialCommit?: string;
  reconciled: boolean;
}

export interface FreezeOptions {
  /** Fault-injection seam called after each of the six durable boundaries. */
  afterStep?: (step: number) => void;
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readFeatures(path: string): FeaturesFile {
  try { return parseFeatures(readFileSync(path, "utf8")) as FeaturesFile; }
  catch (error) { throw new Error(`integrity: cannot read authoritative features: ${(error as Error).message}`); }
}

function readLock(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`integrity: cannot read acceptance lock: ${(error as Error).message}`); }
}

function needs(file: FeaturesFile): string[] {
  const all = [...file.init.needs];
  for (const feature of file.features) if (feature.acceptance.type !== "manual") all.push(...(feature.acceptance.needs ?? []));
  return [...new Set(all)].sort();
}

async function hasHead(git: GitRunner, repo: string): Promise<boolean> {
  try {
    const head = await git.revParseHead(repo);
    throwIfRunCancelled();
    return head.length > 0 && !/^0+$/.test(head);
  } catch (error) {
    rethrowIfRunCancelled(error);
    return false;
  }
}

function matchingFreeze(event: StoredEvent, file: FeaturesFile, lock: AcceptanceLock, needsUnion: string[]): boolean {
  if (event.t !== "freeze") return false;
  const manualCount = file.features.filter((feature) => feature.acceptance.type === "manual").length;
  return event.lockIdsHash === lock.ids
    && event.lockHash === hashInput(lock)
    && event.specHash === lock.specHash
    && event.featureCount === file.features.length
    && event.manualCount === manualCount
    && event.executableCount === file.features.length - manualCount
    && event.needsUnion.length === needsUnion.length
    && event.needsUnion.every((item, index) => item === needsUnion[index]);
}

/** Six durable steps; rerunning completes any missing suffix without trusting either mirror. */
export async function freeze(
  deps: PhaseDeps,
  proposed: FeaturesFile,
  specHash: string,
  git: GitRunner,
  options: FreezeOptions = {},
): Promise<FreezeResult> {
  throwIfRunCancelled();
  let reconciled = false;
  let file = proposed;
  if (existsSync(deps.run.features)) {
    file = readFeatures(deps.run.features);
    if (hashInput(file) !== hashInput(proposed)) throw new Error("integrity: authoritative features differ from the plan being frozen");
    reconciled = true;
  } else writeAtomic(deps.run.features, render(proposed));
  options.afterStep?.(1);
  throwIfRunCancelled();

  let lock = writeAcceptanceLock(file, specHash);
  if (existsSync(deps.run.acceptanceLock)) {
    const held = readLock(deps.run.acceptanceLock);
    let verified;
    try { verified = verifyAcceptanceLock(file, held, specHash); }
    catch (error) { throw new Error(`integrity: cannot verify acceptance lock: ${(error as Error).message}`); }
    if (!verified.ok || verified.specDrift) throw new Error(`integrity: acceptance lock mismatch (${verified.changed.join(", ") || "specHash"})`);
    lock = held as AcceptanceLock;
    reconciled = true;
  } else writeAtomic(deps.run.acceptanceLock, render(lock));
  options.afterStep?.(2);
  throwIfRunCancelled();

  if (!existsSync(deps.run.featureState)) writeAtomic(deps.run.featureState, "");
  else reconciled = true;
  options.afterStep?.(3);
  throwIfRunCancelled();

  const project = projectPaths(deps.run.project);
  mkdirSync(project.repo, { recursive: true });
  mkdirSync(project.checksDir, { recursive: true });
  mkdirSync(project.blockedDir, { recursive: true });
  await git.init(project.repo);
  options.afterStep?.(4);
  throwIfRunCancelled();

  let initialCommit: string | undefined;
  const headExists = await hasHead(git, project.repo);
  const dirty = (await git.statusPorcelain(project.repo)).trim() !== "";
  throwIfRunCancelled();
  if (!headExists || dirty) {
    initialCommit = await git.commit(project.repo, { message: "chore(init): freeze kiln project", trailers: { "Kiln-Run": deps.run.id }, allowEmpty: true });
  } else reconciled = true;
  options.afterStep?.(5);
  throwIfRunCancelled();

  // Mirrors are byte copies of the authoritative run files; neither is re-derived from an
  // existing project-side file or used as input on resume.
  writeAtomic(project.featuresMirror, readFileSync(deps.run.features, "utf8"));
  writeAtomic(project.lockMirror, readFileSync(deps.run.acceptanceLock, "utf8"));
  options.afterStep?.(6);
  throwIfRunCancelled();

  const needsUnion = needs(file);
  if (!deps.record.read().some((event) => matchingFreeze(event, file, lock, needsUnion))) {
    const manualCount = file.features.filter((feature) => feature.acceptance.type === "manual").length;
    deps.record.append({
      t: "freeze",
      featureCount: file.features.length,
      lockIdsHash: lock.ids,
      lockHash: hashInput(lock),
      manualCount,
      executableCount: file.features.length - manualCount,
      needsUnion,
      specHash: lock.specHash,
    });
  }
  return { file, lock, needsUnion, initialCommit, reconciled };
}
