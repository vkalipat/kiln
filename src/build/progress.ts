import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "../core/paths";
import type { AuditVerdict } from "../core/events";
import type { RunPaths } from "../core/run";
import { projectPaths } from "../formation/paths";

export const PROGRESS_STORED_CHARS = 1_200;
export const PROGRESS_PINNED_CHARS = 500;

export interface ProgressIteration {
  featureId: string;
  attempt: number;
  kind?: "attempt" | "state" | "regression";
  entryId?: string;
  iso?: string;
  check: {
    checkId: string;
    ok: boolean;
    kind: "shell" | "file" | "manual";
    exitCode?: number;
    durationMs: number;
    notRunReason?: string;
    excerpt: string;
  };
  audit?: { rawVerdict: AuditVerdict; effectiveVerdict: AuditVerdict; evidenceUsable: boolean };
  commit?: { sha?: string; empty?: boolean; error?: string };
  discardStat?: string;
}

export interface ProgressEntry {
  key: string;
  featureId: string;
  attempt: number;
  kind?: "attempt" | "state" | "regression";
  entryId?: string;
  iso: string;
  text: string;
}

function oneLine(value: string, cap: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 1))}…`;
}

function escapeFenceLines(text: string): string {
  return text.split("\n").map((line) => /^ {0,3}`{3,}/.test(line) ? `\\${line}` : line).join("\n");
}

export function renderProgressEntry(iteration: ProgressIteration): string {
  const iso = oneLine(iteration.iso ?? new Date().toISOString(), 40);
  const featureId = oneLine(iteration.featureId, 64);
  const check = `${iteration.check.ok ? "pass" : "fail"} ${iteration.check.kind} ${iteration.check.checkId}; exit=${iteration.check.exitCode ?? "n/a"}; duration=${iteration.check.durationMs}ms${iteration.check.notRunReason ? `; ${iteration.check.notRunReason}` : ""}`;
  const audit = iteration.audit
    ? `raw=${iteration.audit.rawVerdict}; effective=${iteration.audit.effectiveVerdict}; evidence=${iteration.audit.evidenceUsable ? "usable" : "unusable"}`
    : "not run";
  const commit = iteration.commit?.sha
    ? `${iteration.commit.sha}${iteration.commit.empty ? " (allow-empty)" : ""}`
    : iteration.commit?.error ? `failed: ${oneLine(iteration.commit.error, 180)}` : "none";
  const lines = [
    `## ${featureId} attempt ${iteration.attempt} — ${iso}`,
    `check: ${oneLine(check, 120)}`,
    `audit: ${oneLine(audit, 100)}`,
    `commit: ${oneLine(commit, 100)}`,
  ];
  if (iteration.entryId) lines.splice(1, 0, `entry: ${iteration.kind ?? "attempt"} ${oneLine(iteration.entryId, 96)}`);
  if (iteration.discardStat) lines.push(`discard: ${oneLine(iteration.discardStat, 80)}`);
  const excerpt = escapeFenceLines(iteration.check.excerpt);
  const fence = "```";
  const prefix = `${lines.join("\n")}\n${fence}\n`;
  const suffix = `\n${fence}`;
  const room = Math.max(0, PROGRESS_STORED_CHARS - prefix.length - suffix.length);
  const body = excerpt.length <= room ? excerpt : `${excerpt.slice(0, Math.max(0, room - 1))}…`;
  return `${prefix}${body}${suffix}`;
}

/** Parse harness entries while ignoring heading-looking check output inside fenced blocks. */
export function parseProgress(markdown: string): ProgressEntry[] {
  const entries: ProgressEntry[] = [];
  let current: { featureId: string; attempt: number; iso: string; lines: string[] } | undefined;
  let fence: string | undefined;
  const finish = () => {
    if (!current) return;
    const marker = current.lines.find((line) => line.startsWith("entry: "))?.match(/^entry: (attempt|state|regression) (.+)$/);
    const kind = marker?.[1] as ProgressEntry["kind"];
    const entryId = marker?.[2];
    entries.push({ key: entryId ? `${current.featureId}:${current.attempt}:${kind}:${entryId}` : `${current.featureId}:${current.attempt}`, featureId: current.featureId, attempt: current.attempt, iso: current.iso, text: current.lines.join("\n").trimEnd(), kind, entryId });
  };
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) fence = fence ? (line.startsWith(fence) ? undefined : fence) : fenceMatch[1];
    const header = fence ? undefined : /^## (\S+) attempt (\d+) — (\S+)\s*$/.exec(line);
    if (header) {
      finish();
      current = { featureId: header[1]!, attempt: Number(header[2]), iso: header[3]!, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  finish();
  return entries;
}

/** Replace an existing feature/attempt entry on resume instead of duplicating it. */
export function appendProgress(paths: RunPaths, iteration: ProgressIteration): ProgressEntry[] {
  const path = projectPaths(paths.project).progress;
  const entries = parseProgress(existsSync(path) ? readFileSync(path, "utf8") : "");
  const text = renderProgressEntry(iteration);
  const parsed = parseProgress(text)[0]!;
  const index = entries.findIndex((entry) => entry.key === parsed.key);
  if (index === -1) entries.push(parsed); else entries[index] = parsed;
  writeAtomic(path, entries.length === 0 ? "" : `${entries.map((entry) => entry.text).join("\n\n")}\n`);
  return entries;
}

export function pinProgress(entry: string | ProgressEntry): string {
  const text = typeof entry === "string" ? entry : entry.text;
  const lines = text.split("\n");
  const opening = lines.findIndex((line) => /^(`{3,}|~{3,})$/.test(line));
  let closing = -1;
  for (let index = lines.length - 1; index > opening; index -= 1) {
    if (/^(`{3,}|~{3,})$/.test(lines[index]!)) { closing = index; break; }
  }
  const parsed = parseProgress(text)[0];
  const featureId = oneLine(parsed?.featureId ?? "unknown", 32);
  const attempt = Number.isInteger(parsed?.attempt) ? parsed!.attempt : 0;
  const iso = oneLine(parsed?.iso ?? "unknown", 32);
  const fixed = (label: string, fallback: string, cap: number) => oneLine(lines.find((line) => line.startsWith(label)) ?? fallback, cap);
  const facts = [
    `## ${featureId} attempt ${attempt} — ${iso}`,
    fixed("check:", "check: unavailable", 105),
    fixed("audit:", "audit: unavailable", 85),
    fixed("commit:", "commit: unavailable", 85),
  ];
  const discard = lines.find((line) => line.startsWith("discard:"));
  if (discard) facts.push(oneLine(discard, 65));
  const excerpt = escapeFenceLines(opening >= 0 && closing > opening ? lines.slice(opening + 1, closing).join("\n") : "");
  const prefix = `${facts.join("\n")}\n\`\`\`\n`;
  const suffix = "\n```";
  const room = Math.max(0, PROGRESS_PINNED_CHARS - prefix.length - suffix.length);
  const body = excerpt.length <= room ? excerpt : `${excerpt.slice(0, Math.max(0, room - 1))}…`;
  return `${prefix}${body}${suffix}`;
}
