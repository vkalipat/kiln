import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { BUILDER_TOOL_NAMES, PHASE_TOOLS } from "../brain/tools";
import { writeAtomic } from "../core/paths";

export type DeltaOp = "add" | "edit" | "retire";
export type EvidenceKind = "digest" | "file" | "metric";
export interface DeltaEvidence { kind: EvidenceKind; ref: string }

/** Record §13's `playbook_delta` argument shape. */
export interface PlaybookDelta {
  op: DeltaOp;
  section: string;
  id?: string;
  text: string;
  why?: string;
  kind?: string;
  evidence: DeltaEvidence[];
}

export interface DeltaContext {
  digestHeadings: readonly string[];
  runDir: string;
  projectDir?: string;
  metrics: unknown;
  playbook: string;
  /** Optional at legacy reflect call sites; operator/eval preflight supplies both prompt texts. */
  kernel?: string;
  rolePrompt?: string;
  /** Override for unusual seats. Normal sections derive their tools from the canonical allowlists. */
  allowedTools?: readonly string[];
}

export type DeltaValidation = { ok: true } | { ok: false; reason: string };

/** `evolution/candidates/<runId>.json`: never applied by this plan (record §13). */
export interface PlaybookCandidate {
  runId: string;
  digestHash: string;
  playbookHash: string;
  reflectorModelRef: string;
  delta: PlaybookDelta;
  createdAt: string;
}

export const DELTA_OPS: readonly DeltaOp[] = ["add", "edit", "retire"];
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["digest", "file", "metric"];
/** `- <ID> [helpful:n harmful:n] <text>` — `kiln/playbook/playbook.md`. */
const BULLET = /^- (\S+) \[helpful:\d+ harmful:\d+\] /;
const BULLET_TEXT = /^- (\S+) \[helpful:\d+ harmful:\d+\] (.+)$/;
const DELTA_KINDS = ["correction", "confirmed"] as const;
const NEGATIONS = new Set(["not", "no", "never", "without", "cannot", "cant", "dont", "ignore", "disregard", "avoid"]);
const COMMON_VERBS = new Set([
  "accept", "add", "ask", "build", "call", "challenge", "check", "choose", "combine", "compare",
  "confirm", "create", "define", "design", "do", "drop", "edit", "ensure", "execute", "explain",
  "find", "finish", "follow", "generalize", "give", "identify", "include", "invert", "keep", "limit",
  "make", "measure", "move", "name", "omit", "plan", "prefer", "preserve", "probe", "read", "rebuild",
  "record", "refuse", "reject", "require", "resolve", "retire", "reuse", "run", "select", "specialize",
  "state", "stop", "test", "transfer", "treat", "update", "use", "validate", "verify", "write",
  "is", "are", "be", "must", "should", "can", "will",
]);

/** Counters measure evidence; changing them does not change the champion's instructions. */
export function stripCounters(playbook: string): string {
  return playbook.replace(/ \[helpful:\d+ harmful:\d+\]/g, "");
}

export function playbookSections(md: string): string[] {
  return md.split("\n").flatMap((value) => value.startsWith("## ") ? [value.slice(3).trim()] : []);
}

/** Bullet ids under one `## <section>`, or across the whole playbook when no section is named. */
export function playbookBulletIds(md: string, section?: string): string[] {
  const ids: string[] = [];
  let current: string | undefined;
  for (const value of md.split("\n")) {
    if (value.startsWith("## ")) { current = value.slice(3).trim(); continue; }
    const match = BULLET.exec(value);
    if (match && (section === undefined || current === section)) ids.push(match[1]!);
  }
  return ids;
}

/** Shape check only: the tool schema is lenient so a malformed call is rejected and recorded here. */
export function parseDelta(raw: unknown): { delta: PlaybookDelta } | { reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "playbook_delta arguments must be an object" };
  const value = raw as Record<string, unknown>;
  if (!DELTA_OPS.includes(value.op as DeltaOp)) return { reason: `op must be one of ${DELTA_OPS.join(", ")}` };
  if (typeof value.section !== "string" || value.section.trim() === "") return { reason: "section must be a non-empty string naming a playbook section" };
  if (value.id !== undefined && typeof value.id !== "string") return { reason: "id must be a string when present" };
  if (typeof value.text !== "string") return { reason: "text must be a string" };
  if (value.why !== undefined && typeof value.why !== "string") return { reason: "why must be a string when present" };
  if (value.kind !== undefined && typeof value.kind !== "string") return { reason: "kind must be a string when present" };
  if (!Array.isArray(value.evidence)) return { reason: "evidence must be an array of { kind, ref }" };
  const evidence: DeltaEvidence[] = [];
  for (const [index, item] of value.evidence.entries()) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!EVIDENCE_KINDS.includes(entry.kind as EvidenceKind)) return { reason: `evidence[${index}].kind must be one of ${EVIDENCE_KINDS.join(", ")}` };
    if (typeof entry.ref !== "string" || entry.ref.trim() === "") return { reason: `evidence[${index}].ref must be a non-empty string` };
    evidence.push({ kind: entry.kind as EvidenceKind, ref: entry.ref });
  }
  return { delta: { op: value.op as DeltaOp, section: value.section, id: value.id as string | undefined, text: value.text,
    ...(value.why === undefined ? {} : { why: value.why }), ...(value.kind === undefined ? {} : { kind: value.kind }), evidence } };
}

function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function underRepo(projectDir: string | undefined, path: string): boolean {
  if (!projectDir) return false;
  try { return inside(realpathSync(resolve(projectDir, "repo")), realpathSync(path)); } catch { return false; }
}

/** A `file` ref is a relative path under the run dir or the project dir that exists and is not under `repo/`. */
function fileProblem(ref: string, ctx: DeltaContext): string | undefined {
  const segments = normalize(ref).split(sep);
  if (isAbsolute(ref) || ref.trim() === "" || segments.includes("..")) return `file ref "${ref}" must be relative to the run or project dir`;
  if (segments.includes("repo")) return `file ref "${ref}" is under repo/`;
  for (const base of [ctx.runDir, ctx.projectDir]) {
    if (!base) continue;
    const full = resolve(base, ref);
    if (!inside(base, full) || !existsSync(full)) continue;
    return underRepo(ctx.projectDir, full) ? `file ref "${ref}" is under repo/` : undefined;
  }
  return `file ref "${ref}" does not exist under the run or project dir`;
}

/** A `metric` ref is a top-level key or dotted path into metrics.json whose value is defined. */
function metricProblem(ref: string, metrics: unknown): string | undefined {
  let value: unknown = metrics;
  for (const key of ref.split(".")) {
    // Own properties only: `toString`, `constructor.prototype` or `__proto__` are not metrics.
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return `metric ref "${ref}" is not present in metrics.json`;
    value = (value as Record<string, unknown>)[key];
  }
  return value === undefined ? `metric ref "${ref}" is not present in metrics.json` : undefined;
}

function evidenceProblem(item: DeltaEvidence, ctx: DeltaContext): string | undefined {
  if (item.kind === "digest") return ctx.digestHeadings.includes(item.ref) ? undefined : `digest ref "${item.ref}" is not a heading of the digest`;
  if (item.kind === "file") return fileProblem(item.ref, ctx);
  return metricProblem(item.ref, ctx.metrics);
}

function words(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[’']/g, "")
    .match(/[a-z0-9_]+/g) ?? [];
}

function jaccard(a: string, b: string): number {
  const left = new Set(words(a)); const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function trigrams(value: string): Set<string> {
  const tokens = words(value);
  const out = new Set<string>();
  for (let index = 0; index + 2 < tokens.length; index += 1) out.add(tokens.slice(index, index + 3).join(" "));
  return out;
}

function trigramJaccard(a: string, b: string): number {
  const left = trigrams(a); const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function lessonParts(delta: PlaybookDelta): { lesson: string; why?: string; problem?: string } {
  const text = delta.text.trim();
  if (/\r|\n/.test(text) || (delta.why !== undefined && /\r|\n/.test(delta.why))) {
    return { lesson: text, problem: "sentence_shape: lesson and Why clause must fit on one line" };
  }
  const embedded = /^(.*?)\s+Why:\s+(.+)$/.exec(text);
  if (delta.why !== undefined && embedded && embedded[2]!.trim() !== delta.why.trim()) {
    return { lesson: embedded[1]!.trim(), problem: "why_mismatch: text and why carry different Why clauses" };
  }
  return {
    lesson: embedded?.[1]?.trim() ?? text,
    why: (delta.why ?? embedded?.[2])?.trim(),
  };
}

function sentenceProblem(lesson: string): string | undefined {
  if (lesson.length > 240) return "sentence_too_long: lesson must be at most 240 characters";
  if (!/[.!?]$/.test(lesson)) return "sentence_shape: lesson must be one complete sentence";
  const withoutEnd = lesson.slice(0, -1);
  if (/[.!?](?:\s|$)/.test(withoutEnd)) return "sentence_shape: lesson must contain exactly one sentence";
  return undefined;
}

function activeBulletTexts(md: string, section: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  let current: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith("## ")) { current = line.slice(3).trim(); continue; }
    const match = current === section ? BULLET_TEXT.exec(line) : null;
    if (match) out.push({ id: match[1]!, text: lessonParts({ op: "add", section, text: match[2]!, evidence: [] }).lesson });
  }
  return out;
}

function toolsFor(section: string, override?: readonly string[]): readonly string[] {
  if (override) return override;
  if (section === "lenses") return [];
  if (section === "build") return BUILDER_TOOL_NAMES;
  if (section === "frame" || section === "discover" || section === "ideate" || section === "form") return PHASE_TOOLS[section];
  return [];
}

function unavailableTool(lesson: string, section: string, override?: readonly string[]): string | undefined {
  const allowed = new Set(toolsFor(section, override));
  const all = new Set(Object.values(PHASE_TOOLS).flat());
  for (const tool of all) {
    if (!allowed.has(tool) && new RegExp(`(^|[^a-z0-9_])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i").test(lesson)) return tool;
  }
  return undefined;
}

function shingles(value: string, size: number): Set<string> {
  const tokens = words(value).filter((word) => !NEGATIONS.has(word));
  const out = new Set<string>();
  for (let index = 0; index + size <= tokens.length; index += 1) out.add(tokens.slice(index, index + size).join(" "));
  return out;
}

function negatesSource(lesson: string, source: string | undefined): boolean {
  if (!source || !words(lesson).some((word) => NEGATIONS.has(word))) return false;
  const proposed = shingles(lesson, 8);
  if (proposed.size === 0) return false;
  for (const sentence of source.split(/(?<=[.!?])\s+|\r?\n/)) {
    for (const shingle of shingles(sentence, 8)) if (proposed.has(shingle)) return true;
  }
  return false;
}

function metricNames(value: unknown, prefix = "", depth = 0): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(key, path);
    out.push(...metricNames(child, path, depth + 1));
  }
  return out;
}

function hasVerb(lesson: string): boolean {
  return words(lesson).some((word) => COMMON_VERBS.has(word) || /(?:ed|ing|ize|ise|ify|ate|en)$/.test(word));
}

/** Record §13: every evidence ref must resolve, and edits and retirements must name an existing bullet. */
export function validateDelta(delta: PlaybookDelta, ctx: DeltaContext): DeltaValidation {
  const sections = playbookSections(ctx.playbook);
  if (!sections.includes(delta.section)) return { ok: false, reason: `unknown section "${delta.section}"; playbook sections: ${sections.join(", ")}` };
  if (delta.op === "edit" || delta.op === "retire") {
    if (!delta.id) return { ok: false, reason: `${delta.op} requires the id of an existing bullet in section "${delta.section}"` };
    const ids = playbookBulletIds(ctx.playbook, delta.section);
    if (!ids.includes(delta.id)) return { ok: false, reason: `no bullet "${delta.id}" in section "${delta.section}"; ids: ${ids.join(", ") || "none"}` };
  }
  if (delta.op === "add" && delta.id && playbookBulletIds(ctx.playbook).includes(delta.id)) return { ok: false, reason: `id "${delta.id}" collides with an existing bullet` };
  if (delta.op !== "retire" && delta.text.trim() === "") return { ok: false, reason: `${delta.op} requires non-empty text` };
  if (delta.evidence.length === 0) return { ok: false, reason: "evidence must name at least one digest heading, bundled file, or metrics key" };
  for (const item of delta.evidence) {
    const problem = evidenceProblem(item, ctx);
    if (problem) return { ok: false, reason: problem };
  }
  if (delta.kind !== undefined && !(DELTA_KINDS as readonly string[]).includes(delta.kind)) {
    return { ok: false, reason: `invalid_kind: kind must be one of ${DELTA_KINDS.join(", ")}` };
  }
  if (delta.op === "retire") {
    if (!delta.evidence.some((item) => item.kind === "metric")) {
      return { ok: false, reason: "retire_requires_metric: retire must cite at least one metrics.json value" };
    }
    return { ok: true };
  }

  const parts = lessonParts(delta);
  if (parts.problem) return { ok: false, reason: parts.problem };
  if (!parts.why) return { ok: false, reason: "missing_why: add and edit require a Why clause" };
  const sentence = sentenceProblem(parts.lesson);
  if (sentence) return { ok: false, reason: sentence };
  const tool = unavailableTool(parts.lesson, delta.section, ctx.allowedTools);
  if (tool) return { ok: false, reason: `unavailable_tool: section "${delta.section}" cannot use ${tool}` };
  if (negatesSource(parts.lesson, ctx.kernel)) return { ok: false, reason: "kernel_conflict: lesson mechanically negates an eight-word kernel shingle" };
  if (negatesSource(parts.lesson, ctx.rolePrompt)) return { ok: false, reason: "prompt_conflict: lesson mechanically negates an eight-word role-prompt shingle" };

  if (delta.op === "add") {
    const duplicate = activeBulletTexts(ctx.playbook, delta.section)
      .map((bullet) => ({ ...bullet, score: trigramJaccard(parts.lesson, bullet.text) }))
      .sort((a, b) => b.score - a.score)[0];
    if (duplicate && duplicate.score > 0.6) {
      return { ok: false, reason: `duplicate_bullet: add overlaps ${duplicate.id} at ${duplicate.score.toFixed(3)}; edit it instead` };
    }
  }

  if (!hasVerb(parts.lesson)) return { ok: false, reason: "fact_not_lesson: lesson contains no recognizable verb" };
  for (const fact of [...ctx.digestHeadings, ...metricNames(ctx.metrics)]) {
    if (jaccard(parts.lesson, fact) >= 0.5) return { ok: false, reason: `fact_not_lesson: lesson restates "${fact}"` };
  }
  return { ok: true };
}

export function writeCandidate(path: string, candidate: PlaybookCandidate): void {
  writeAtomic(path, `${JSON.stringify(candidate, null, 2)}\n`);
}
