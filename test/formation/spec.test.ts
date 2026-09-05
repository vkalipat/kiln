import { describe, expect, test } from "bun:test";
import { parseSpec, SPEC_SECTIONS, validateSpec } from "../../src/formation/spec";

function valid(milestone = "A user can run the command and see a result."): string {
  return `# Spec\n\n## What\nA useful command.\n\n## For whom\nOperators.\n\n## Why now\nThe data is available.\n\n## Scope\n- one command\n\n## Non-goals\n- a GUI\n\n## Risks\nThe source may be noisy.\n\n## First milestone\n${milestone}\n`;
}

describe("formation spec", () => {
  test("parses all seven required sections and accepts a valid spec", () => {
    const parsed = parseSpec(valid());
    expect(Object.keys(parsed.sections)).toEqual([...SPEC_SECTIONS]);
    expect(parsed.missing).toEqual([]);
    expect(validateSpec(parsed)).toEqual([]);
  });

  test("reports every missing section independently", () => {
    const problems = validateSpec(parseSpec("# Spec\n\n## What\nx\n"));
    for (const name of SPEC_SECTIONS.slice(1)) expect(problems).toContain(`missing section: ${name}`);
  });

  test("requires scope and non-goal bullets", () => {
    const text = valid().replace("## Scope\n- one command", "## Scope\none command").replace("## Non-goals\n- a GUI", "## Non-goals\na GUI");
    expect(validateSpec(parseSpec(text))).toEqual([
      "Scope: at least one `- ` bullet is required",
      "Non-goals: at least one `- ` bullet is required",
    ]);
  });

  test("requires a nonempty milestone of at most 600 characters", () => {
    expect(validateSpec(parseSpec(valid("")))).toContain("First milestone: must not be empty");
    expect(validateSpec(parseSpec(valid("x".repeat(600))))).toEqual([]);
    expect(validateSpec(parseSpec(valid("x".repeat(601))))).toContain("First milestone: 601 characters (cap 600)");
  });
});
