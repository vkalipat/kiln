import { bullets, sections } from "../phases/contracts";

export const SPEC_SECTIONS = ["What", "For whom", "Why now", "Scope", "Non-goals", "Risks", "First milestone"] as const;

export interface ParsedSpec {
  sections: Record<string, string>;
  missing: string[];
}

export function parseSpec(markdown: string): ParsedSpec {
  const parsed = sections(markdown);
  return { sections: parsed, missing: SPEC_SECTIONS.filter((name) => !(name in parsed)) };
}

export function validateSpec(spec: ParsedSpec): string[] {
  const problems = spec.missing.map((name) => `missing section: ${name}`);
  if (!spec.missing.includes("Scope") && bullets(spec.sections.Scope ?? "").length === 0) {
    problems.push("Scope: at least one `- ` bullet is required");
  }
  if (!spec.missing.includes("Non-goals") && bullets(spec.sections["Non-goals"] ?? "").length === 0) {
    problems.push("Non-goals: at least one `- ` bullet is required");
  }
  if (!spec.missing.includes("First milestone")) {
    const milestone = (spec.sections["First milestone"] ?? "").trim();
    if (milestone.length === 0) problems.push("First milestone: must not be empty");
    else if (milestone.length > 600) problems.push(`First milestone: ${milestone.length} characters (cap 600)`);
  }
  return problems;
}
