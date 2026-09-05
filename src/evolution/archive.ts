import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidatePath, writeAtomic } from "../core/paths";
import { assertCandidateId } from "./candidate";

export const ARCHIVE_REASONS = [
  "lost_dev",
  "lost_heldout",
  "not_evidence",
  "censored",
  "stale_champion",
  "invalid",
  "playbook_overflow",
  "heldout_seed",
  "leak",
  "conflicting_bullet",
  "conflicting_prompt",
  "duplicate_bullet",
  "unswept_effort",
  "rolled_back",
  "operator",
  "superseded",
] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export interface ArchiveReasonRecord {
  reason: ArchiveReason;
  detail: string;
  at: string;
}

export interface ArchiveCandidateOptions {
  reason: ArchiveReason;
  detail: string;
  at?: string | Date;
  /** Override the normal `evolution/reports/<id>/eval.json` lookup. */
  evalPath?: string;
}

export interface ArchivedCandidate {
  id: string;
  dir: string;
  candidatePath: string;
  evalPath?: string;
  reasonPath: string;
  reason: ArchiveReasonRecord;
}

export class ArchiveError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ArchiveError";
  }
}

export function isArchiveReason(value: unknown): value is ArchiveReason {
  return typeof value === "string" && (ARCHIVE_REASONS as readonly string[]).includes(value);
}

export function archiveDir(home: string, id: string): string {
  assertCandidateId(id);
  return join(home, "evolution", "archive", id);
}

function iso(value: string | Date | undefined): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ArchiveError("invalid", "archive timestamp must be a valid date");
  return date.toISOString();
}

function validateOptions(options: ArchiveCandidateOptions): ArchiveReasonRecord {
  if (!isArchiveReason(options.reason)) {
    throw new ArchiveError("invalid_archive_reason", `expected one of ${ARCHIVE_REASONS.join(", ")}`);
  }
  if (typeof options.detail !== "string" || !options.detail.trim() || /\r|\n/.test(options.detail)) {
    throw new ArchiveError("invalid", "archive detail must be one non-empty line");
  }
  return { reason: options.reason, detail: options.detail.trim(), at: iso(options.at) };
}

/**
 * Terminally move one pending candidate into its immutable archive layout.
 * The complete directory is published before the pending source is removed; callers hold evolve.lock.
 */
export function archiveCandidate(home: string, id: string, options: ArchiveCandidateOptions): ArchivedCandidate {
  assertCandidateId(id);
  const reason = validateOptions(options);
  const source = candidatePath(home, id);
  const target = archiveDir(home, id);
  if (existsSync(target)) throw new ArchiveError("archive_terminal", `${id} is already archived`);
  if (!existsSync(source)) throw new ArchiveError("candidate_not_found", id);

  const candidateBytes = readFileSync(source, "utf8");
  const report = options.evalPath ?? join(home, "evolution", "reports", id, "eval.json");
  const evalBytes = existsSync(report) ? readFileSync(report, "utf8") : undefined;
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${id}.${randomUUID()}.tmp`);
  mkdirSync(temporary);
  try {
    writeAtomic(join(temporary, "candidate.json"), candidateBytes);
    if (evalBytes !== undefined) writeAtomic(join(temporary, "eval.json"), evalBytes);
    writeAtomic(join(temporary, "reason.json"), `${JSON.stringify(reason, null, 2)}\n`);
    renameSync(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  try {
    unlinkSync(source);
  } catch (error) {
    // Do not leave two apparent states. The pending file is authoritative until its removal succeeds.
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return {
    id,
    dir: target,
    candidatePath: join(target, "candidate.json"),
    ...(evalBytes === undefined ? {} : { evalPath: join(target, "eval.json") }),
    reasonPath: join(target, "reason.json"),
    reason,
  };
}

export function readArchiveReason(home: string, id: string): ArchiveReasonRecord | undefined {
  const path = join(archiveDir(home, id), "reason.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!isArchiveReason(raw.reason) || typeof raw.detail !== "string" || !raw.detail.trim() || /\r|\n/.test(raw.detail) || typeof raw.at !== "string") return undefined;
    const at = new Date(raw.at);
    if (Number.isNaN(at.valueOf()) || at.toISOString() !== raw.at) return undefined;
    return { reason: raw.reason, detail: raw.detail, at: raw.at };
  } catch {
    return undefined;
  }
}
