import { existsSync, readFileSync } from "node:fs";
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

export function readAudits(paths: RunPaths): Audit[] {
  if (!existsSync(paths.audits)) return [];
  const audits: Audit[] = [];
  for (const line of readFileSync(paths.audits, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const audit = JSON.parse(line) as Audit;
      if (audit && typeof audit.featureId === "string" && typeof audit.sourceEventSeq === "number" && audit.raw) audits.push(audit);
    } catch {
      // Ignore a torn final append; earlier audits remain authoritative.
    }
  }
  return audits;
}

export function appendAudit(paths: RunPaths, input: Audit): Audit {
  const audit = capped(input, AUDIT_CAPS_STORED);
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
