import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt, PROMPT_FILES } from "../../src/brain/prompts";

const KILN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPTS_DIR = join(KILN_ROOT, "prompts");

function bundled(name: (typeof PROMPT_FILES)[number]): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
}

describe("bundled prompts", () => {
  test("every registered base prompt loads", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-prompts-"));
    expect(PROMPT_FILES).toHaveLength(11);
    for (const name of PROMPT_FILES) expect(loadPrompt(home, name).trim()).not.toBe("");
  });

  test("kernel states precedence and base prompts omit retired prescriptions", () => {
    expect(bundled("kernel")).toContain(
      "The pinned contract and the user turn take precedence over playbook guidance; if two instructions conflict, name the one you cannot follow.",
    );
    expect(bundled("brain")).toContain(
      "The pinned contract is the task; scouts answer one precise question each.",
    );
    expect(bundled("scout")).toContain(
      "Each finding is a fact, a number, a name, or a quote, with its source (URL or file path).",
    );

    const base = PROMPT_FILES.map(bundled).join("\n").toLowerCase();
    for (const retired of [
      "do not narrate a plan",
      "four scouts at most",
      "at most 1,500 tokens",
      "do not write recommendations",
      "do not pad",
      "no preamble",
      "no rankings",
      "no advice",
      "no hedging",
      "no summary of the input",
      "offer advice",
      "two turns",
      "turn budget shown in the pinned block",
      "do not restate the obvious",
    ]) expect(base).not.toContain(retired);
  });

  test("all prompt markdown avoids reasoning-echo and retired anti-formatting phrases", () => {
    const files = [...new Bun.Glob("**/*.md").scanSync({ cwd: PROMPTS_DIR, onlyFiles: true })];
    const banned = [
      /explain your reasoning/i,
      /show your thinking/i,
      /think step by step/i,
      /do not narrate a plan/i,
      /do not write recommendations/i,
      /do not pad/i,
      /no preamble/i,
      /no rankings/i,
      /no advice/i,
      /no hedging/i,
      /no summary of the input/i,
      /offer advice/i,
    ];
    for (const file of files) {
      const text = readFileSync(join(PROMPTS_DIR, file), "utf8");
      for (const pattern of banned) expect(`${file}\n${text}`).not.toMatch(pattern);
    }
  });

  test("de-prescription preserves parser-facing output contracts", () => {
    const generator = bundled("generator");
    for (const clause of [
      "Exactly five ideas per batch.",
      "# Idea <n>",
      "Title,\n  Mechanism, Draws on, Axes, Testable claim, Cheapest test, Strongest failure reason, Probability.",
      "at least three under 10 percent",
    ]) expect(generator).toContain(clause);

    const judge = bundled("judge");
    for (const field of [
      "`verdict` tool",
      "`valueWinner`",
      "`feasibilityWinner`",
      "`reason`",
      "### research",
      "### product",
      "### creative",
    ]) {
      expect(judge).toContain(field);
    }

    const scout = bundled("scout");
    for (const field of ["## prior art", "Template:", "{purpose}", "{mechanism}", "{evaluation}", "{shape}"]) {
      expect(scout).toContain(field);
    }

    const prober = bundled("prober");
    for (const field of ["`probe_spec` tool", "`files`", "`command`", "`needs`", "requires network", "`timeoutSeconds`", "`successPredicate`"]) {
      expect(prober).toContain(field);
    }

    expect(bundled("critic")).toContain("critique tool once");
    expect(bundled("arbiter")).toContain("Answer through the tool you are given");
    expect(bundled("builder")).toContain("cannot_be_satisfied");
    expect(bundled("auditor")).toContain("audit tool once");
    expect(bundled("reflector")).toContain("playbook_delta tool");
  });
});
