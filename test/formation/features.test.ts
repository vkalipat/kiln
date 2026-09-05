import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/core/config";
import {
  assignIds,
  derivedCaps,
  isTrivialCommand,
  parseFeatures,
  validateFeatures,
  type Acceptance,
  type FeaturesFile,
} from "../../src/formation/features";
import { parseSpec } from "../../src/formation/spec";

const SPEC = parseSpec(`# Spec\n## What\nx\n## For whom\ny\n## Why now\nz\n## Scope\n- command\n## Non-goals\n- GUI\n## Risks\nnone\n## First milestone\nA user can run it.`);

function file(count: number, acceptance: (index: number) => Acceptance = (index) => ({ type: "shell", command: `bun test test/f${index + 1}.test.ts` })): FeaturesFile {
  return {
    version: 1,
    init: { needs: ["bun"] },
    features: Array.from({ length: count }, (_, index) => ({
      id: `f${String(index + 1).padStart(2, "0")}`,
      title: `Feature ${index + 1}`,
      description: `Implement feature ${index + 1}`,
      acceptance: acceptance(index),
    })),
  };
}

describe("parseFeatures and assignIds", () => {
  test("parses a draft and assigns stable harness ids", () => {
    const draft = parseFeatures(JSON.stringify({ version: 1, init: { needs: [] }, features: [
      { title: "A", description: "a", acceptance: { type: "file", path: "a.txt" } },
      { id: "model-choice", title: "B", description: "b", acceptance: { type: "file", path: "b.txt" } },
    ] }));
    expect(assignIds(draft).features.map((feature) => feature.id)).toEqual(["f01", "f02"]);
    expect(() => parseFeatures("not json")).toThrow(/not valid JSON/);
    expect(() => parseFeatures(JSON.stringify({ version: 1, init: { needs: [] } }))).toThrow(/features must be a list/);
  });

  test("canonical assignment drops model-supplied mutable feature state", () => {
    const draft = parseFeatures(JSON.stringify({ version: 1, init: { needs: [] }, features: [{
      id: "wrong", title: "A", description: "a", acceptance: { type: "file", path: "a.txt" },
      passes: true, attempts: 9, blocked: true, regressedBy: "f02", repairs: 4,
    }] }));
    expect(assignIds(draft).features[0]).toEqual({ id: "f01", title: "A", description: "a", acceptance: { type: "file", path: "a.txt" } });
  });

  test("assignment leaves null and primitive entries for validation instead of throwing", () => {
    const draft = parseFeatures(JSON.stringify({ version: 2, init: { needs: [] }, features: [
      null,
      7,
      "bad",
    ] }));
    const assigned = assignIds(draft);
    expect(assigned.version).toBe(2 as never);
    expect(assigned.features).toEqual([null, 7, "bad"] as never);
    const problems = validateFeatures(assigned, SPEC, defaultConfig());
    expect(problems).toContain("version must be 1");
    expect(problems.filter((problem) => /features\[\d\] must be an object/.test(problem))).toHaveLength(3);
  });

  test("preserves ids across description edits and rejects rename, reorder, or deletion", () => {
    const cfg = defaultConfig(); const original = file(3); const expectedIds = original.features.map((feature) => feature.id);
    const edited = structuredClone(original); edited.features[1]!.description = "Revised description";
    expect(validateFeatures(edited, SPEC, cfg, { expectedIds })).toEqual([]);

    const renamed = structuredClone(edited); renamed.features[1]!.id = "f09";
    expect(validateFeatures(renamed, SPEC, cfg, { expectedIds }).join("\n")).toMatch(/must remain f02|feature ids changed/);
    const reordered = structuredClone(edited); reordered.features.reverse();
    expect(validateFeatures(reordered, SPEC, cfg, { expectedIds }).join("\n")).toMatch(/feature ids changed/);
    const dropped = structuredClone(edited); dropped.features.pop();
    expect(validateFeatures(dropped, SPEC, cfg, { expectedIds }).join("\n")).toMatch(/feature ids changed/);
  });
});

describe("derivedCaps", () => {
  test("derives the repriced default floors and a seven-feature cap", () => {
    const caps = derivedCaps(defaultConfig());
    expect(caps.maxFeatures).toBe(7);
    expect(caps.attemptCeiling).toBeCloseTo(1.9508, 8);
    expect(caps.expectedAttemptUsd).toBe(1.240);
    expect(caps.featureCeilingBase).toBeCloseTo(3.72, 8);
    expect(caps.formationAttempts).toBe(1);
  });

  test("raises the schema cap to twelve at a forty-one-dollar target", () => {
    const cfg = defaultConfig(); cfg.budgets.usd = 41;
    expect(derivedCaps(cfg).maxFeatures).toBe(12);
    cfg.build.maxFeatures = 20; cfg.budgets.usd = 100;
    expect(derivedCaps(cfg).maxFeatures).toBe(12);
  });
});

describe("isTrivialCommand", () => {
  test("recognizes normalized no-op and output-only commands", () => {
    for (const command of ["true", "true;;", " : ; ", "exit   0", "test 1 = 1", "[ 1 = 1 ]", "/bin/true", "echo okay", "printf okay"]) {
      expect(isTrivialCommand(command)).toBe(true);
    }
  });

  test("does not reject commands with a path or real test runner", () => {
    for (const command of ["echo okay > output.txt", "printf x > ./result", "bun test", "make check", "pytest", "node ./test.js"]) {
      expect(isTrivialCommand(command)).toBe(false);
    }
  });
});

describe("validateFeatures", () => {
  test("accepts seven and rejects two or eight features at defaults", () => {
    const cfg = defaultConfig();
    expect(validateFeatures(file(7), SPEC, cfg)).toEqual([]);
    expect(validateFeatures(file(2), SPEC, cfg)).toContain("features: 2 found; minimum is 3");
    expect(validateFeatures(file(8), SPEC, cfg)).toContain("features: 8 found; budget-sized maximum is 7");
  });

  test("requires an executable first feature and at least one executable overall", () => {
    const cfg = defaultConfig();
    const firstManual = file(3, (index) => index === 0 ? { type: "manual", instructions: "Look at it" } : { type: "file", path: `f${index}.txt` });
    expect(validateFeatures(firstManual, SPEC, cfg)).toContain("features[0].acceptance must be executable (shell or file)");
    const allManual = file(3, () => ({ type: "manual", instructions: "Look at it" }));
    expect(validateFeatures(allManual, SPEC, cfg)).toContain("at least one feature must have an executable acceptance check");
  });

  test("screens trivial commands unless an expectation gives them an oracle", () => {
    const cfg = defaultConfig(); const trivial = file(3); trivial.features[1]!.acceptance = { type: "shell", command: " echo hello; " };
    expect(validateFeatures(trivial, SPEC, cfg).join("\n")).toContain("command is trivial");
    trivial.features[1]!.acceptance = { type: "shell", command: "echo hello", expect: { type: "substring", value: "hello" } };
    expect(validateFeatures(trivial, SPEC, cfg)).toEqual([]);
  });

  test("validates predicates, needs, timeouts, paths and schema fields", () => {
    const cfg = defaultConfig(); const invalid = file(3);
    invalid.init = { needs: [""] };
    invalid.features[0]!.acceptance = { type: "shell", command: "bun test", expect: { type: "regex", value: "[" }, timeoutSeconds: 0, needs: [""] };
    invalid.features[1]!.acceptance = { type: "file", path: "../escape", contains: "x" };
    invalid.features[2]!.id = "f02";
    const problems = validateFeatures(invalid, SPEC, cfg).join("\n");
    expect(problems).toMatch(/init\.needs\[0\]/);
    expect(problems).toMatch(/not a valid regex/);
    expect(problems).toMatch(/timeoutSeconds/);
    expect(problems).toMatch(/stay inside the repo/);
    expect(problems).toMatch(/duplicates f02/);
    const missingInitNeeds = structuredClone(file(3)) as unknown as Record<string, unknown>;
    missingInitNeeds.init = {};
    expect(validateFeatures(missingInitNeeds as unknown as FeaturesFile, SPEC, cfg)).toContain("init.needs must be a list");
    const nulPath = file(3); nulPath.features[1]!.acceptance = { type: "file", path: "bad\0path" };
    expect(validateFeatures(nulPath, SPEC, cfg)).toContain("features[1].acceptance.path must not contain a NUL byte");
  });

  test("rejects mutable or unknown feature keys during critique revision", () => {
    const cfg = defaultConfig(); const revised = file(3);
    Object.assign(revised.features[1]!, { passes: true, attempts: 2, blocked: true, extra: "no" });
    const expectedIds = revised.features.map((feature) => feature.id);
    const problems = validateFeatures(revised, SPEC, cfg, { expectedIds });
    for (const key of ["passes", "attempts", "blocked", "extra"]) {
      expect(problems).toContain(`features[1].${key} is not allowed in a frozen feature`);
    }
    expect(problems.some((problem) => problem.startsWith("feature ids changed"))).toBe(false);
  });

  test("applies the wall-clock sizing assertion independently of the dollar cap", () => {
    const cfg = defaultConfig(); cfg.budgets.usd = 41;
    expect(derivedCaps(cfg).maxFeatures).toBe(12);
    expect(validateFeatures(file(12), SPEC, cfg).join("\n")).toContain("exceed wall-clock sizing allowance");
    cfg.budgets.wallSeconds = 20_000;
    expect(validateFeatures(file(12), SPEC, cfg)).toEqual([]);
  });
});
