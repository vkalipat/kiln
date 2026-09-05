import { SHAPES, type IdeaShape } from "../core/config";
import { hashInput } from "../core/record";
import type { RunPaths } from "../core/run";

export const BRIEF_SECTIONS = ["Problem", "Constraints", "Search success", "Non-goals", "Shape", "Axes", "Discovery questions"] as const;
export const LANDSCAPE_SECTIONS = ["Obvious list", "Atoms", "Tensions", "Distant domains"] as const;

/** How many named values an axis must offer: too few and the archive has no room, too many and the cells never fill. */
export const AXIS_VALUES_MIN = 3;
export const AXIS_VALUES_MAX = 6;
export const QUESTIONS_MIN = 2;
export const QUESTIONS_MAX = 4;

/** One behavior axis and its closed vocabulary, written in the brief as `name: v1 | v2 | v3`. */
export interface Axis {
  name: string;
  values: string[];
}

/** Splits markdown into `## <heading>` sections, keyed by trimmed heading text. */
export function sections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of md.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    const name = (nl === -1 ? part : part.slice(0, nl)).trim();
    out[name] = (nl === -1 ? "" : part.slice(nl + 1)).trim();
  }
  return out;
}

/** The `- ` bulleted lines in `text`, trimmed and de-prefixed. */
export function bullets(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
}

/**
 * Reads the Axes section's bullets as `name: v1 | v2 | v3`. A bullet with no colon is an axis with
 * no vocabulary, which `validateBrief` rejects — islands cannot choose from a list that is not there.
 */
export function parseAxes(text: string): Axis[] {
  return bullets(text).map((b) => {
    const i = b.indexOf(":");
    if (i === -1) return { name: b.trim(), values: [] };
    return {
      name: b.slice(0, i).trim(),
      values: b.slice(i + 1).split("|").map((v) => v.trim()).filter((v) => v.length > 0),
    };
  });
}

/** What `validateBrief` and `shapeHash` need out of a parsed brief. */
export interface BriefFacts {
  missing: readonly string[];
  shape?: IdeaShape;
  /** The raw first word of the Shape section, so an unknown shape can be quoted back. */
  shapeRaw?: string;
  axes: Axis[];
  questions: string[];
}

/**
 * Everything about a brief that would make the rest of the run dishonest if it were wrong
 * (record §1): a shape outside the closed set, an axis with no usable vocabulary, or a discovery
 * step with too little or too much to research. Returns one line per problem, ready to hand back
 * to the brain as a re-ask.
 */
export function validateBrief(b: BriefFacts): string[] {
  const problems = b.missing.map((n) => `missing section: ${n}`);
  if (!b.missing.includes("Shape") && b.shape === undefined) {
    problems.push(`Shape must be one of ${SHAPES.join(", ")} (got "${b.shapeRaw ?? ""}")`);
  }
  if (!b.missing.includes("Axes")) {
    if (b.axes.length === 0) problems.push("Axes: no axis bullets found; write one bullet per axis as `name: v1 | v2 | v3`");
    for (const a of b.axes) {
      if (a.values.length < AXIS_VALUES_MIN || a.values.length > AXIS_VALUES_MAX) {
        problems.push(`Axes: "${a.name}" has ${a.values.length} values; each axis needs ${AXIS_VALUES_MIN} to ${AXIS_VALUES_MAX}, written as \`${a.name}: v1 | v2 | v3\``);
      }
    }
  }
  if (!b.missing.includes("Discovery questions") && (b.questions.length < QUESTIONS_MIN || b.questions.length > QUESTIONS_MAX)) {
    problems.push(`Discovery questions: ${b.questions.length} found; write ${QUESTIONS_MIN} to ${QUESTIONS_MAX}, one precise question each`);
  }
  return problems;
}

/**
 * The fingerprint of what frame froze: the idea shape and the axis vocabulary the whole run is
 * spread across. Case and formatting are normalized, so reflowing the brief does not read as a
 * changed shape, while renaming an axis or its values does.
 */
export function shapeHash(b: Pick<BriefFacts, "shape" | "axes">): string {
  return hashInput({
    shape: b.shape,
    axes: b.axes.map((a) => ({ name: a.name.trim().toLowerCase(), values: a.values.map((v) => v.trim().toLowerCase()) })),
  });
}

const EXIT_CLAUSE = "If the seed is too underspecified to search, or no honest output is possible, call the exit tool with the kind and reasons. That is a correct outcome.";

export function frameContract(run: RunPaths, _turnCap: number): string {
  return [
    `Phase: frame. Output file: ${run.brief}`,
    `Required sections (## headings, in this order): ${BRIEF_SECTIONS.join(", ")}.`,
    `Problem: restate it in one paragraph. Constraints: hard limits as bullets. Search success: what a winning idea must do, as bullets. Non-goals: bullets. Shape: exactly one of ${SHAPES.join(", ")}. Axes: 3 to 5 bullets naming the behavior axes ideas will be spread across (default: who it serves, mechanism class, what it assumes that others do not, where the value shows up). Discovery questions: ${QUESTIONS_MIN} to ${QUESTIONS_MAX} bullets, one precise question each, for scouts.`,
    `Every axis bullet is a closed vocabulary written as \`name: v1 | v2 | v3\` with ${AXIS_VALUES_MIN} to ${AXIS_VALUES_MAX} values, lowercase, each a value an idea can actually take. Islands choose from this list and nothing else, so a bare axis name is not accepted.`,
    EXIT_CLAUSE,
  ].join("\n");
}

export function discoverContract(run: RunPaths, questions: string[], _turnCap: number): string {
  return [
    `Phase: discover. Output file: ${run.landscape}`,
    `Findings files are in ${run.discoveryDir}; read them first.`,
    `Required sections (## headings, in this order): ${LANDSCAPE_SECTIONS.join(", ")}.`,
    "Obvious list: at least 5 bullets, the ideas anyone would propose in five minutes. Atoms: 20 to 40 bullets, each a concept, mechanism, or constraint from the findings, tagged (common) or (rare). Tensions: bullets, constraints that fight, shared assumptions, and things tried and failed with the stated reason. Distant domains: 3 to 5 bullets, fields far from this one with a structurally similar problem.",
    `Questions that were scouted: ${questions.map((q) => `"${q}"`).join("; ")}.`,
    EXIT_CLAUSE,
  ].join("\n");
}
