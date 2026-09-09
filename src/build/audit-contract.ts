import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { AuditVerdict } from "../core/events";
import { appendLine, writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";
import { projectPaths } from "../formation/paths";

export interface AuditPayload {
  verified: string[];
  claimedUnverified: string[];
  regressions: string[];
  nextSessionNotes: string;
  checkQuality: { adequate: boolean; reason: string };
  verdict: AuditVerdict;
}

export interface Audit {
  featureId: string;
  attempt: number;
  checkId: string;
  sourceEventSeq: number;
  createdAt: string;
  shape: "full" | "short";
  raw: AuditPayload;
  model: { provider: string; model: string; ref: string; effort?: string };
}

export interface AuditCaps {
  items: number;
  itemChars: number;
  notesChars: number;
  reasonChars: number;
}

export const AUDIT_CAPS_STORED: Readonly<AuditCaps> = { items: 8, itemChars: 200, notesChars: 1_200, reasonChars: 200 };
export const AUDIT_CAPS_PINNED: Readonly<AuditCaps> = { items: 4, itemChars: 120, notesChars: 900, reasonChars: 150 };

function prefix(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

function capPayload(payload: AuditPayload, caps: Readonly<AuditCaps>): AuditPayload {
  const list = (values: readonly string[]) => values.slice(0, caps.items).map((value) => prefix(String(value), caps.itemChars));
  return {
    verified: list(payload.verified),
    claimedUnverified: list(payload.claimedUnverified),
    regressions: list(payload.regressions),
    nextSessionNotes: prefix(payload.nextSessionNotes, caps.notesChars),
    checkQuality: { adequate: payload.checkQuality.adequate, reason: prefix(payload.checkQuality.reason, caps.reasonChars) },
    verdict: payload.verdict,
  };
}

function capped(audit: Audit, caps: Readonly<AuditCaps>): Audit {
  return { ...audit, raw: capPayload(audit.raw, caps), model: { ...audit.model } };
}

/** Pure, idempotent field-wise projection for a later builder's pinned context. */
export function pinAudit(audit: Audit): Audit {
  return capped(audit, AUDIT_CAPS_PINNED);
}

function bullets(values: readonly string[]): string {
  return values.length === 0 ? "- (none)" : values.map((value) => `- ${value}`).join("\n");
}

/** Render the stored-cap form; audit.md is always the latest audit only. */
export function renderAudit(input: Audit): string {
  const audit = capped(input, AUDIT_CAPS_STORED);
  return [
    `# Audit ${audit.featureId} attempt ${audit.attempt}`,
    `check: ${audit.checkId}`,
    `source event: ${audit.sourceEventSeq}`,
    `model: ${audit.model.ref} (${audit.model.provider}/${audit.model.model})`,
    `shape: ${audit.shape}`,
    `verdict: ${audit.raw.verdict}`,
    "", "## Verified", bullets(audit.raw.verified),
    "", "## Claimed but unverified", bullets(audit.raw.claimedUnverified),
    "", "## Regressions", bullets(audit.raw.regressions),
    "", "## Next session notes", audit.raw.nextSessionNotes || "(none)",
    "", "## Check quality", `adequate: ${audit.raw.checkQuality.adequate}`, audit.raw.checkQuality.reason || "(none)",
    "",
  ].join("\n");
}

function validAudit(value: unknown): value is Audit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const audit = value as Partial<Audit>;
  const raw = audit.raw as Partial<AuditPayload> | undefined;
  const quality = raw?.checkQuality as Partial<AuditPayload["checkQuality"]> | undefined;
  const model = audit.model as Partial<Audit["model"]> | undefined;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === "string");
  return typeof audit.featureId === "string" && audit.featureId !== ""
    && Number.isInteger(audit.attempt) && (audit.attempt ?? -1) >= 0
    && typeof audit.checkId === "string" && audit.checkId !== ""
    && Number.isInteger(audit.sourceEventSeq) && (audit.sourceEventSeq ?? 0) > 0
    && typeof audit.createdAt === "string"
    && (audit.shape === "full" || audit.shape === "short")
    && !!raw && strings(raw.verified) && strings(raw.claimedUnverified) && strings(raw.regressions)
    && typeof raw.nextSessionNotes === "string" && !!quality && typeof quality.adequate === "boolean" && typeof quality.reason === "string"
    && (raw.verdict === "agree" || raw.verdict === "disagree")
    && !!model && typeof model.provider === "string" && typeof model.model === "string" && typeof model.ref === "string"
    && (model.effort === undefined || typeof model.effort === "string");
}

function invalidJson(line: string): boolean {
  try { JSON.parse(line); return false; } catch { return true; }
}

function requireRegularFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error("integrity: audits.jsonl must be a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function repairTornTail(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  if (text === "" || text.endsWith("\n")) return;
  const start = text.lastIndexOf("\n") + 1;
  if (invalidJson(text.slice(start))) writeAtomic(path, text.slice(0, start));
}

export function readAudits(paths: RunPaths): Audit[] {
  if (!requireRegularFile(paths.audits)) return [];
  const text = readFileSync(paths.audits, "utf8");
  const lines = text.split("\n");
  const audits: Audit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const audit: unknown = JSON.parse(line);
      if (!validAudit(audit)) throw new Error("invalid audit shape");
      audits.push(audit);
    } catch (error) {
      // appendLine always terminates durable entries. Only a malformed unterminated tail is a
      // recoverable interrupted append; corruption before it must not silently disappear.
      if (index === lines.length - 1 && !text.endsWith("\n") && invalidJson(line)) break;
      throw new Error(`integrity: malformed audits.jsonl line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return audits;
}

export function appendAudit(paths: RunPaths, input: Audit): Audit {
  const audit = capped(input, AUDIT_CAPS_STORED);
  requireRegularFile(paths.audits);
  repairTornTail(paths.audits);
  const held = readAudits(paths);
  const duplicate = held.some((entry) => entry.sourceEventSeq === audit.sourceEventSeq && entry.checkId === audit.checkId);
  if (!duplicate) {
    appendLine(paths.audits, JSON.stringify(audit));
    held.push(audit);
  }
  const latest = held.at(-1) ?? audit;
  writeAtomic(projectPaths(paths.project).audit, renderAudit(latest));
  return latest;
}
