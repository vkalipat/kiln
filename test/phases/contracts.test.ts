import { describe, expect, test } from "bun:test";
import { bullets, discoverContract, frameContract, parseAxes, sections, shapeHash, validateBrief } from "../../src/phases/contracts";
import { parseBrief } from "../../src/phases/frame";
import { runPaths } from "../../src/core/run";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery\n";
const brief = (o: { shape?: string; axes?: string; questions?: string } = {}) =>
  `# Brief\n\n## Problem\np\n\n## Constraints\n- c\n\n## Search success\n- s\n\n## Non-goals\n- n\n\n## Shape\n${o.shape ?? "product"}\n\n## Axes\n${o.axes ?? AXES}\n## Discovery questions\n${o.questions ?? "- Q1?\n- Q2?\n"}`;

describe("sections and bullets", () => {
  test("still split headings and bullets", () => {
    expect(Object.keys(sections("## A\nx\n\n## B\ny"))).toEqual(["A", "B"]);
    expect(bullets("- one\n- two")).toEqual(["one", "two"]);
  });
});

describe("parseAxes", () => {
  test("reads `name: v1 | v2 | v3` into a name and its values", () => {
    expect(parseAxes(AXES)).toEqual([
      { name: "who it serves", values: ["hobbyists", "sideliners", "commercial"] },
      { name: "mechanism class", values: ["sensing", "modeling", "logistics"] },
      { name: "where the value shows up", values: ["prevention", "diagnosis", "recovery"] },
    ]);
  });
  test("a bare axis name has no values", () => {
    expect(parseAxes("- who it serves")).toEqual([{ name: "who it serves", values: [] }]);
  });
  test("empty values are dropped and whitespace trimmed", () => {
    expect(parseAxes("- a:  x |  y ||")).toEqual([{ name: "a", values: ["x", "y"] }]);
  });
});

describe("validateBrief", () => {
  test("a well-formed brief has no problems", () => {
    expect(validateBrief(parseBrief(brief()))).toEqual([]);
  });
  test("rejects bare axis names", () => {
    const problems = validateBrief(parseBrief(brief({ axes: "- who it serves\n- mechanism class\n- value\n" })));
    expect(problems.length).toBe(3);
    expect(problems[0]).toMatch(/who it serves/);
    expect(problems[0]).toMatch(/3 to 6/);
  });
  test("rejects an axis with too few or too many values", () => {
    expect(validateBrief(parseBrief(brief({ axes: "- a: x | y\n" }))).some((p) => p.includes("3 to 6"))).toBe(true);
    expect(validateBrief(parseBrief(brief({ axes: "- a: 1 | 2 | 3 | 4 | 5 | 6 | 7\n" }))).some((p) => p.includes("3 to 6"))).toBe(true);
  });
  test("rejects a shape outside the closed set", () => {
    const problems = validateBrief(parseBrief(brief({ shape: "startup" })));
    expect(problems.some((p) => p.includes("research, product, creative"))).toBe(true);
  });
  test("rejects fewer than two or more than four discovery questions", () => {
    expect(validateBrief(parseBrief(brief({ questions: "- only one?\n" }))).some((p) => p.includes("2 to 4"))).toBe(true);
    expect(validateBrief(parseBrief(brief({ questions: "- a?\n- b?\n- c?\n- d?\n- e?\n" }))).some((p) => p.includes("2 to 4"))).toBe(true);
  });
  test("reports every missing section", () => {
    const problems = validateBrief(parseBrief("# Brief\n## Problem\nx\n"));
    expect(problems.filter((p) => p.startsWith("missing section")).length).toBe(6);
  });
  test("no axes at all is a problem", () => {
    expect(validateBrief(parseBrief(brief({ axes: "" }))).some((p) => p.includes("axis"))).toBe(true);
  });
});

describe("shapeHash", () => {
  test("is stable across formatting and case, and changes with the shape or an axis", () => {
    const base = shapeHash(parseBrief(brief()));
    expect(base).toBe(shapeHash(parseBrief(brief({ axes: AXES.toUpperCase() }))));
    expect(base).not.toBe(shapeHash(parseBrief(brief({ shape: "research" }))));
    expect(base).not.toBe(shapeHash(parseBrief(brief({ axes: "- a: x | y | z\n" }))));
  });
});

describe("frameContract", () => {
  test("spells out the axis value syntax", () => {
    const text = frameContract(runPaths("/tmp/home", "r1"), 10);
    expect(text).toContain("name: v1 | v2 | v3");
    expect(text).toContain("3 to 6");
    expect(text).not.toContain("Turn budget: 10");
    expect(discoverContract(runPaths("/tmp/home", "r1"), ["Q1?"], 20)).not.toContain("Turn budget: 20");
  });
});
