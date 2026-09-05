import { createHash } from "node:crypto";
import { bullets, sections } from "../phases/contracts";

/**
 * The dossier model and its renderer.
 *
 * `renderDossier` is the single normalization point between an island's markdown and everything
 * downstream: identical content renders identically however the model formatted it, the
 * verbalized-sampling probability and every provenance field are stripped from the judge's view,
 * and the Prior art line and Probe block are always present so their absence is never ambiguous.
 *
 * RENDER_VERSION must be bumped by any change to `renderDossier`'s output — byte for byte,
 * including headings, ordering, spacing and the evidence lines. Rendered dossiers are hashed into
 * `tournament.jsonl` (`aRenderHash`/`bRenderHash`) and the version is part of the calibration hash,
 * so an unversioned change silently invalidates every stored comparison.
 */
export const RENDER_VERSION = 1;

export interface Dossier {
  id: string;
  title: string;
  mechanism: string;
  draws: string;
  axisValues: Record<string, string>;
  testableClaim: string;
  cheapestTest: string;
  failureReason: string;
  vsProbability?: number;
  lens?: string;
  operator?: string;
  parents: string[];
}

export interface Evidence {
  priorArt?: { status: "collided" | "not_falsified" | "search_failed"; artifact?: { title: string; url: string }; distance?: string };
  probe?: { status: "pass" | "fail" | "timeout" | "error" | "not_run"; reason?: string; exitCode?: number; stdoutTail?: string; durationMs?: number };
  strengths?: Record<"value" | "feasibility", { mean: number; lo: number; hi: number; n: number }>;
  cell?: string;
  /** The ideas this one was mutated from, `[]` for a fresh island idea (record §10). The archive
   *  always writes it, so a sidecar without it was written before the field existed. */
  parents?: string[];
  status: "active" | "rejected" | "unranked";
  rejectReason?: string;
  similarity?: number;
  vsBound?: boolean;
  truncated?: string[];
}

/** One brief axis and its closed value vocabulary (`name: v1 | v2 | v3`). */
export interface Axis { name: string; values: string[] }

export const DOSSIER_SECTIONS = ["Title", "Mechanism", "Draws on", "Axes", "Testable claim", "Cheapest test", "Strongest failure reason", "Probability"] as const;
/** Probability is deliberately not required: a dossier without one is renderable, and a missing or
 * malformed probability is reported to the caller as `vsProbability === undefined` so it can degrade
 * to `vsBound: false` (record §4) instead of costing the island all five ideas. */
export const REQUIRED_SECTIONS = DOSSIER_SECTIONS.slice(0, 7);

/** Per-field character caps (record round-1 B3), applied at render and reported by `validateDossier`. */
export const CAPS = { title: 80, mechanism: 900, draws: 200, axisValue: 120, testableClaim: 200, cheapestTest: 200, failureReason: 200, stdoutTail: 600 } as const;

const TEXT_FIELDS = [
  ["title", "Title", CAPS.title],
  ["mechanism", "Mechanism", CAPS.mechanism],
  ["draws", "Draws on", CAPS.draws],
  ["testableClaim", "Testable claim", CAPS.testableClaim],
  ["cheapestTest", "Cheapest test", CAPS.cheapestTest],
  ["failureReason", "Strongest failure reason", CAPS.failureReason],
] as const;

const IDEA_HEADING = /^#[ \t]*Idea[ \t]+\d+[^\n]*$/im;

/**
 * The `# Idea <n>` blocks of an island batch, in order, without their headings. Any preamble before
 * the first heading is dropped and empty blocks are kept, so the result length is exactly the number
 * of headings the model wrote — that count is what the "exactly five per batch" check validates.
 */
export function splitIdeas(md: string): string[] {
  const parts = md.split(IDEA_HEADING);
  return parts.length <= 1 ? [] : parts.slice(1).map((b) => b.trim());
}

/** Collapses a section to one normalized line: bullets joined with `; `, all whitespace runs squeezed. */
function normalizeText(text: string): string {
  const b = bullets(text);
  return (b.length > 0 ? b.join("; ") : text).replace(/\s+/g, " ").trim();
}

function parseProbability(text: string): number | undefined {
  const m = /(-?\d+(?:\.\d+)?)\s*(%?)/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? (m[2] === "%" ? n / 100 : n) : undefined;
}

function parseAxes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of bullets(text)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).replace(/\s+/g, " ").trim();
    if (name.length > 0) out[name] = line.slice(i + 1).replace(/\s+/g, " ").trim();
  }
  return out;
}

/** Parses one `# Idea <n>` block body into a partial dossier plus the required sections it lacks. */
export function parseDossier(block: string): { dossier: Partial<Dossier>; missing: string[] } {
  const s = sections(block);
  const missing = REQUIRED_SECTIONS.filter((h) => (s[h] ?? "").trim().length === 0);
  const dossier: Partial<Dossier> = {};
  for (const [field, heading] of TEXT_FIELDS) {
    const v = normalizeText(s[heading] ?? "");
    if (v.length > 0) dossier[field] = v;
  }
  if (s["Axes"] !== undefined) dossier.axisValues = parseAxes(s["Axes"]);
  const p = s["Probability"] === undefined ? undefined : parseProbability(s["Probability"]);
  if (p !== undefined) dossier.vsProbability = p;
  return { dossier, missing: [...missing] };
}

export interface AxisMapping {
  /** Canonical `briefAxisName -> briefValue`, for the axes that resolved. */
  axisValues: Record<string, string>;
  mapped: { axis: string; from: string; to: string }[];
  unknown: { axis: string; value: string; allowed: string[] }[];
  missing: string[];
  extra: string[];
}

const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Maps a dossier's axis names and values onto the brief's closed vocabulary, case- and
 * whitespace-insensitively (record §4). Everything it cannot resolve is reported rather than
 * guessed: `unknown` is what the caller escalates to one arbiter call, `mapped` is what it records.
 */
export function normalizeAxes(d: { axisValues?: Record<string, string> }, axes: readonly Axis[]): AxisMapping {
  const given = d.axisValues ?? {};
  const byName = new Map(Object.keys(given).map((k) => [fold(k), k]));
  const out: AxisMapping = { axisValues: {}, mapped: [], unknown: [], missing: [], extra: [] };
  const used = new Set<string>();
  for (const axis of axes) {
    const key = byName.get(fold(axis.name));
    if (key === undefined) { out.missing.push(axis.name); continue; }
    used.add(key);
    const raw = given[key] ?? "";
    const hit = axis.values.find((v) => fold(v) === fold(raw));
    if (hit === undefined) { out.unknown.push({ axis: axis.name, value: raw, allowed: axis.values }); continue; }
    out.axisValues[axis.name] = hit;
    if (key !== axis.name || raw !== hit) out.mapped.push({ axis: axis.name, from: raw, to: hit });
  }
  out.extra = Object.keys(given).filter((k) => !used.has(k));
  return out;
}

function overCap(value: string, limit: number): string | undefined {
  return value.length > limit ? `${value.length} characters (cap ${limit})` : undefined;
}

/**
 * Everything wrong with a parsed dossier, as one message per problem, in a fixed order: empty
 * required fields, over-cap fields, then axis vocabulary problems. An empty array means the dossier
 * can be stored as is; anything else is what the single re-ask quotes back to the island.
 */
export function validateDossier(d: Partial<Dossier>, axes: readonly Axis[]): string[] {
  const errs: string[] = [];
  for (const [field, , limit] of TEXT_FIELDS) {
    const v = d[field] ?? "";
    if (v.trim().length === 0) { errs.push(`${field} is empty`); continue; }
    const over = overCap(v, limit);
    if (over !== undefined) errs.push(`${field} is ${over}`);
  }
  const m = normalizeAxes(d, axes);
  for (const name of m.missing) errs.push(`axis "${name}" is missing`);
  for (const u of m.unknown) errs.push(`axis "${u.axis}" value "${u.value}" is not in the vocabulary (${u.allowed.join(" | ")})`);
  for (const name of m.extra) errs.push(`axis "${name}" is not one of the brief's axes`);
  for (const [name, value] of Object.entries(d.axisValues ?? {})) {
    const over = overCap(value, CAPS.axisValue);
    if (over !== undefined) errs.push(`axis value for "${name}" is ${over}`);
  }
  return errs;
}

export interface RenderOptions {
  /** Judge view: no probability, no id, lens, operator or parents. Defaults to true, so the
   * expensive mistake (leaking provenance into a comparison) needs an explicit opt-out. */
  forJudge?: boolean;
}

function cap(value: string, limit: number, field: string, truncated: string[]): string {
  if (value.length <= limit) return value;
  truncated.push(field);
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function priorArtLines(e: Evidence | undefined): string[] {
  const p = e?.priorArt;
  if (p === undefined) return ["Prior art: not checked"];
  if (p.status === "search_failed") return ["Prior art: search failed (novelty unknown)"];
  if (p.status === "not_falsified") return ["Prior art: searched, no matching artifact found"];
  const a = p.artifact;
  const head = a === undefined ? "Prior art: collided with an unnamed artifact" : `Prior art: collided with "${a.title}" (${a.url})`;
  return p.distance === undefined ? [head] : [head, `Distance: ${p.distance}`];
}

function probeLines(e: Evidence | undefined, truncated: string[]): string[] {
  const p = e?.probe;
  if (p === undefined) return ["Probe: not run (not yet requested)"];
  const out: string[] = [];
  if (p.status === "not_run") out.push(`Probe: not run (${p.reason ?? "not yet requested"})`);
  else if (p.status === "timeout") out.push(p.durationMs === undefined ? "Probe: timeout" : `Probe: timeout after ${p.durationMs} ms`);
  else if (p.status === "error") out.push(p.reason === undefined ? "Probe: error" : `Probe: error (${p.reason})`);
  else out.push(p.exitCode === undefined ? `Probe: ${p.status}` : `Probe: ${p.status} (exit code ${p.exitCode})`);
  if (p.status !== "not_run" && p.durationMs !== undefined && p.status !== "timeout") out.push(`Duration: ${p.durationMs} ms`);
  if (p.reason !== undefined && p.status !== "not_run" && p.status !== "error") out.push(`Reason: ${p.reason}`);
  const tail = p.stdoutTail?.trim();
  if (tail !== undefined && tail.length > 0) out.push("Output tail:", "```", cap(tail, CAPS.stdoutTail, "probe.stdoutTail", truncated), "```");
  return out;
}

/**
 * The rendered dossier plus the fields the caps truncated. Callers record `truncated` in
 * `ideas/<id>.evidence.json` (record round-1 B3); `hash` is the value stored in `tournament.jsonl`.
 */
export function renderDossierDetailed(d: Dossier, e: Evidence | undefined, opts: RenderOptions = {}): { text: string; truncated: string[]; hash: string } {
  const forJudge = opts.forJudge ?? true;
  const truncated: string[] = [];
  const f = (field: (typeof TEXT_FIELDS)[number][0], limit: number): string => cap(d[field] ?? "", limit, field, truncated);
  const axes = Object.entries(d.axisValues ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [
    `# ${f("title", CAPS.title)}`,
    "", "## Mechanism", f("mechanism", CAPS.mechanism),
    "", "## Draws on", f("draws", CAPS.draws),
    "", "## Axes",
    ...axes.map(([name, value]) => `- ${name}: ${cap(value, CAPS.axisValue, `axisValues.${name}`, truncated)}`),
    "", "## Testable claim", f("testableClaim", CAPS.testableClaim),
    "", "## Cheapest test", f("cheapestTest", CAPS.cheapestTest),
    "", "## Strongest failure reason", f("failureReason", CAPS.failureReason),
    "", "## Prior art", ...priorArtLines(e),
    "", "## Probe", ...probeLines(e, truncated),
  ];
  if (!forJudge) {
    lines.push("", "## Provenance", `Id: ${d.id ?? ""}`);
    if (d.lens !== undefined) lines.push(`Lens: ${d.lens}`);
    if (d.operator !== undefined) lines.push(`Operator: ${d.operator}`);
    if (d.parents !== undefined && d.parents.length > 0) lines.push(`Parents: ${d.parents.join(", ")}`);
    if (d.vsProbability !== undefined) lines.push(`Probability: ${d.vsProbability}`);
  }
  const text = `${lines.join("\n")}\n`;
  return { text, truncated: truncated.sort(), hash: renderHash(text) };
}

/**
 * The canonical view of an idea. Nothing derived from the tournament (strengths, cell, status,
 * similarity) is ever rendered: the judge must compare the idea, not its standing.
 */
export function renderDossier(d: Dossier, e: Evidence | undefined, opts: RenderOptions = {}): string {
  return renderDossierDetailed(d, e, opts).text;
}

/** sha256 of a rendered dossier; the `aRenderHash`/`bRenderHash` of `tournament.jsonl`. */
/** sha256 of the rendered text exactly as the judge saw it; referenced from tournament lines. */
export function renderHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
