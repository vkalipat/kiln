import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";
import { projectPaths } from "../formation/paths";
import { renderAudit, type Audit } from "./audit-contract";

export interface BlockedSources {
  check?: { path: string; eventSeq: number };
  audit?: Audit;
}

export interface ArchivedEvidence {
  present: boolean;
  sourcePath: string | null;
  sourceEventSeq: number | null;
  archivedPath: string | null;
  sha256: string | null;
}

export interface BlockedManifest {
  version: 1;
  featureId: string;
  createdAt: string;
  check: ArchivedEvidence;
  audit: ArchivedEvidence;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyAtomic(source: string, destination: string): void {
  ensureDir(dirname(destination));
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  copyFileSync(source, temp);
  try { renameSync(temp, destination); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

function missing(sourcePath: string | null = null, sourceEventSeq: number | null = null): ArchivedEvidence {
  return { present: false, sourcePath, sourceEventSeq, archivedPath: null, sha256: null };
}

/** Preserve the last machine evidence at stored caps for later human adjudication. */
export function archiveBlocked(paths: RunPaths, featureId: string, sources: BlockedSources = {}): BlockedManifest {
  if (!SAFE_ID.test(featureId)) throw new Error(`invalid blocked feature id ${featureId}`);
  const dir = join(projectPaths(paths.project).blockedDir, featureId);
  ensureDir(dir);

  let check = missing(sources.check?.path ?? null, sources.check?.eventSeq ?? null);
  if (sources.check && existsSync(sources.check.path)) {
    const destination = join(dir, `check-${basename(sources.check.path)}`);
    copyAtomic(sources.check.path, destination);
    check = { present: true, sourcePath: sources.check.path, sourceEventSeq: sources.check.eventSeq, archivedPath: destination, sha256: sha256(destination) };
  }

  let audit = missing(paths.audits, sources.audit?.sourceEventSeq ?? null);
  if (sources.audit) {
    const destination = join(dir, "audit.md");
    writeAtomic(destination, renderAudit(sources.audit));
    audit = { present: true, sourcePath: paths.audits, sourceEventSeq: sources.audit.sourceEventSeq, archivedPath: destination, sha256: sha256(destination) };
  }

  const manifest: BlockedManifest = { version: 1, featureId, createdAt: new Date().toISOString(), check, audit };
  writeAtomic(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
