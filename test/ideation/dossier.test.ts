import { describe, expect, test } from "bun:test";
import {
  CAPS, DOSSIER_SECTIONS, RENDER_VERSION, REQUIRED_SECTIONS,
  normalizeAxes, parseDossier, renderDossier, renderDossierDetailed, renderHash, splitIdeas, validateDossier,
  type Axis, type Dossier, type Evidence,
} from "../../src/ideation/dossier";

const AXES: Axis[] = [
  { name: "who it serves", values: ["hobbyists", "commercial keepers", "researchers"] },
  { name: "mechanism class", values: ["sensing", "breeding", "logistics"] },
];

function ideaBlock(n: number, title: string, extra = ""): string {
  return `# Idea ${n}\n## Title\n${title}\n\n## Mechanism\nMechanism ${n}: place a sensor in the hive and watch the drift.\n\n## Draws on\n- atom ${n} (rare)\n- tension ${n}\n\n## Axes\n- who it serves: hobbyists\n- mechanism class: sensing\n\n## Testable claim\nClaim ${n} holds for at least ten hives.\n\n## Cheapest test\nRecord ${n} nights of audio and run a classifier.\n\n## Strongest failure reason\nAmbient noise swamps the signal ${n}.\n\n## Probability\n0.0${n}\n${extra}`;
}
const BLOB = `Here are the five ideas as a distribution.\n\n${Array.from({ length: 10 }, (_, i) => ideaBlock(i + 1, `Idea title ${i + 1}`)).join("\n")}`;

function full(over: Partial<Dossier> = {}): Dossier {
  return {
    id: "r1-i2-3", title: "Acoustic mite index", mechanism: "Listen to the hive at night and score the spectrum.",
    draws: "acoustic atom; noise tension", axisValues: { "who it serves": "hobbyists", "mechanism class": "sensing" },
    testableClaim: "A microphone separates mite-stressed hives from healthy ones.", cheapestTest: "Record ten hives for one night.",
    failureReason: "Ambient noise swamps the signal.", vsProbability: 0.037, parents: [], ...over,
  };
}

describe("splitIdeas", () => {
  test("splits a realistic ten-idea blob and drops the preamble", () => {
    const blocks = splitIdeas(BLOB);
    expect(blocks.length).toBe(10);
    expect(blocks[0]).toStartWith("## Title");
    expect(blocks.some((b) => b.includes("Here are the five ideas"))).toBe(false);
    expect(parseDossier(blocks[2]!).dossier.title).toBe("Idea title 3");
  });
  test("keeps empty blocks so the count matches the heading count", () => {
    expect(splitIdeas("# Idea 1\n\n# Idea 2\n## Title\nx\n").length).toBe(2);
  });
  test("tolerates a titled and differently cased heading", () => {
    expect(splitIdeas("# idea 1: The hook\n## Title\nx\n").length).toBe(1);
  });
  test("returns nothing when there are no idea headings", () => { expect(splitIdeas("## Title\nx")).toEqual([]); });
});

describe("parseDossier", () => {
  test("extracts every field, bullets, axes and probability", () => {
    const { dossier, missing } = parseDossier(splitIdeas(ideaBlock(4, "Hive drift"))[0]!);
    expect(missing).toEqual([]);
    expect(dossier.title).toBe("Hive drift");
    expect(dossier.draws).toBe("atom 4 (rare); tension 4");
    expect(dossier.axisValues).toEqual({ "who it serves": "hobbyists", "mechanism class": "sensing" });
    expect(dossier.vsProbability).toBeCloseTo(0.04, 10);
  });
  test("reports a missing section and leaves the rest parsed", () => {
    const block = splitIdeas(ideaBlock(1, "T"))[0]!.replace(/## Cheapest test\n[^\n]+\n/, "");
    const { dossier, missing } = parseDossier(block);
    expect(missing).toEqual(["Cheapest test"]);
    expect(dossier.title).toBe("T");
  });
  test("treats an empty section as missing and never reports Probability", () => {
    const { missing } = parseDossier("## Title\n\n## Mechanism\nm\n");
    expect(missing).toContain("Title");
    expect(missing).not.toContain("Probability");
    expect(REQUIRED_SECTIONS).not.toContain("Probability");
    expect(DOSSIER_SECTIONS).toContain("Probability");
  });
  test("reads a percentage probability and ignores an unparseable one", () => {
    expect(parseDossier("## Probability\n3.5%\n").dossier.vsProbability).toBeCloseTo(0.035, 10);
    expect(parseDossier("## Probability\nlow\n").dossier.vsProbability).toBeUndefined();
  });
  test("collapses wrapped prose to one normalized line", () => {
    expect(parseDossier("## Mechanism\nline one\n  line   two\n").dossier.mechanism).toBe("line one line two");
  });
});

describe("validateDossier", () => {
  test("maps axis names and values case-insensitively into the vocabulary", () => {
    const d = full({ axisValues: { "Who It Serves": "Hobbyists", "MECHANISM CLASS": " Sensing " } });
    expect(validateDossier(d, AXES)).toEqual([]);
    const m = normalizeAxes(d, AXES);
    expect(m.axisValues).toEqual({ "who it serves": "hobbyists", "mechanism class": "sensing" });
    expect(m.mapped).toEqual([{ axis: "who it serves", from: "Hobbyists", to: "hobbyists" }, { axis: "mechanism class", from: " Sensing ", to: "sensing" }]);
  });
  test("rejects an out-of-vocabulary value and reports the allowed set", () => {
    const d = full({ axisValues: { "who it serves": "astronauts", "mechanism class": "sensing" } });
    const errs = validateDossier(d, AXES);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("astronauts");
    expect(errs[0]).toContain("commercial keepers");
    expect(normalizeAxes(d, AXES).unknown).toEqual([{ axis: "who it serves", value: "astronauts", allowed: AXES[0]!.values }]);
  });
  test("reports a missing axis and an axis outside the brief", () => {
    const d = full({ axisValues: { "who it serves": "hobbyists", "vibe": "cosy" } });
    const errs = validateDossier(d, AXES);
    expect(errs.some((e) => e.includes("mechanism class") && e.includes("missing"))).toBe(true);
    expect(errs.some((e) => e.includes("vibe"))).toBe(true);
  });
  test("reports empty required fields and over-cap fields", () => {
    const errs = validateDossier({ title: "", mechanism: "m".repeat(CAPS.mechanism + 1), axisValues: {} }, []);
    expect(errs.some((e) => e.startsWith("title is empty"))).toBe(true);
    expect(errs.some((e) => e.includes("mechanism is 901 characters") && e.includes("cap 900"))).toBe(true);
  });
  test("caps an over-long axis value", () => {
    const axes: Axis[] = [{ name: "a", values: ["x".repeat(CAPS.axisValue + 1)] }];
    expect(validateDossier(full({ axisValues: { a: "x".repeat(CAPS.axisValue + 1) } }), axes).some((e) => e.includes("axis value"))).toBe(true);
  });
});

describe("renderDossier", () => {
  test("is identical for two dossiers differing only in field order and whitespace", () => {
    const a = parseDossier(splitIdeas(ideaBlock(1, "Hive drift"))[0]!).dossier as Dossier;
    const reordered = "## Axes\n-  mechanism class:  sensing\n-   who it serves:  hobbyists\n\n## Probability\n0.01\n\n## Strongest failure reason\n   Ambient noise swamps the signal 1.\n\n## Mechanism\nMechanism 1: place a sensor in the hive\nand watch the drift.\n\n## Title\n   Hive drift   \n\n## Cheapest test\nRecord 1 nights of audio and run a classifier.\n\n## Testable claim\nClaim 1 holds for at least ten hives.\n\n## Draws on\n-   atom 1 (rare)\n-  tension 1\n";
    const b = parseDossier(reordered).dossier as Dossier;
    expect(renderDossier(b, undefined)).toBe(renderDossier(a, undefined));
    expect(renderHash(renderDossier(a, undefined))).toBe(renderHash(renderDossier(b, undefined)));
  });
  test("differs when content differs", () => {
    expect(renderHash(renderDossier(full(), undefined))).not.toBe(renderHash(renderDossier(full({ title: "Other" }), undefined)));
  });
  test("never shows the probability, the id, the lens or the operator to the judge", () => {
    const text = renderDossier(full({ lens: "economist", operator: "invert" }), undefined);
    expect(text).not.toContain("0.037");
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text).not.toContain("r1-i2-3");
    expect(text).not.toContain("economist");
    expect(text).not.toContain("invert");
  });
  test("shows the probability and id only outside the judge view", () => {
    const text = renderDossier(full(), undefined, { forJudge: false });
    expect(text).toContain("0.037");
    expect(text).toContain("r1-i2-3");
  });
  test("never leaks strengths, cell, status or similarity", () => {
    const e: Evidence = { status: "active", cell: "hobbyists|sensing", similarity: 0.41, strengths: { value: { mean: 1.2, lo: 0.4, hi: 2, n: 6 }, feasibility: { mean: 0.3, lo: -1, hi: 1.4, n: 6 } } };
    const text = renderDossier(full(), e);
    for (const s of ["hobbyists|sensing", "0.41", "1.2", "strength", "Cell"]) expect(text).not.toContain(s);
  });
  test("always includes a Prior art line and a Probe block when evidence is absent", () => {
    const text = renderDossier(full(), undefined);
    expect(text).toContain("Prior art: not checked");
    expect(text).toContain("Probe: not run (not yet requested)");
    expect(text).toContain("## Prior art");
    expect(text).toContain("## Probe");
  });
  test("renders every prior-art status", () => {
    const r = (p: Evidence["priorArt"]) => renderDossier(full(), { status: "active", priorArt: p });
    expect(r({ status: "collided", artifact: { title: "HiveEar", url: "https://x.test/h" }, distance: "same sensor, same claim" }))
      .toContain('Prior art: collided with "HiveEar" (https://x.test/h)');
    expect(r({ status: "collided", artifact: { title: "HiveEar", url: "https://x.test/h" }, distance: "same sensor, same claim" })).toContain("Distance: same sensor, same claim");
    expect(r({ status: "not_falsified" })).toContain("Prior art: searched, no matching artifact found");
    expect(r({ status: "search_failed" })).toContain("Prior art: search failed (novelty unknown)");
  });
  test("renders all five probe statuses", () => {
    const r = (p: NonNullable<Evidence["probe"]>) => renderDossier(full(), { status: "active", probe: p });
    expect(r({ status: "pass", exitCode: 0, durationMs: 1200, stdoutTail: "ok: 12 hives" })).toContain("Probe: pass");
    expect(r({ status: "pass", exitCode: 0, durationMs: 1200, stdoutTail: "ok: 12 hives" })).toContain("ok: 12 hives");
    expect(r({ status: "fail", exitCode: 3, durationMs: 900 })).toContain("Probe: fail (exit code 3)");
    expect(r({ status: "timeout", durationMs: 120000 })).toContain("Probe: timeout after 120000 ms");
    expect(r({ status: "error", reason: "spawn ENOENT" })).toContain("Probe: error (spawn ENOENT)");
    expect(r({ status: "not_run", reason: "missing_dependency:ffmpeg" })).toContain("Probe: not run (missing_dependency:ffmpeg)");
    expect(r({ status: "not_run" })).toContain("Probe: not run (not yet requested)");
  });
  test("orders axes by name so key order cannot change the render", () => {
    const one = renderDossier(full({ axisValues: { b: "2", a: "1" } }), undefined);
    expect(one).toBe(renderDossier(full({ axisValues: { a: "1", b: "2" } }), undefined));
    expect(one.indexOf("- a: 1")).toBeLessThan(one.indexOf("- b: 2"));
  });
});

describe("caps at render", () => {
  test("truncates every over-cap field and records which ones", () => {
    const d = full({ title: "T".repeat(200), mechanism: "M".repeat(2000), draws: "D".repeat(500), testableClaim: "C".repeat(500), cheapestTest: "H".repeat(500), failureReason: "F".repeat(500), axisValues: { "who it serves": "W".repeat(400) } });
    const { text, truncated } = renderDossierDetailed(d, { status: "active", probe: { status: "pass", stdoutTail: "S".repeat(4000) } });
    expect(truncated.sort()).toEqual(["axisValues.who it serves", "cheapestTest", "draws", "failureReason", "mechanism", "probe.stdoutTail", "testableClaim", "title"]);
    expect(text.split("\n").find((l) => l.startsWith("# "))!.length).toBe(2 + CAPS.title);
    expect(text).toContain("...");
    expect(text.includes("M".repeat(CAPS.mechanism + 1))).toBe(false);
    expect(text.includes("S".repeat(CAPS.stdoutTail + 1))).toBe(false);
  });
  test("records nothing and changes nothing when every field fits", () => {
    const { text, truncated } = renderDossierDetailed(full(), undefined);
    expect(truncated).toEqual([]);
    expect(text).toBe(renderDossier(full(), undefined));
  });
  test("truncation is idempotent", () => {
    const d = full({ mechanism: "M".repeat(2000) });
    const once = renderDossier(d, undefined);
    const reparsed = parseDossier(once.replace(/^# (.*)$/m, "## Title\n$1")).dossier;
    expect(reparsed.mechanism!.length).toBeLessThanOrEqual(CAPS.mechanism);
  });
});

describe("renderHash and RENDER_VERSION", () => {
  test("is a stable sha256 hex of the text", () => {
    expect(renderHash("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(renderHash("abc")).toBe(renderHash("abc"));
    expect(renderHash("abc")).not.toBe(renderHash("abd"));
  });
  test("RENDER_VERSION is 1 and is not part of the rendered text", () => {
    expect(RENDER_VERSION).toBe(1);
    expect(renderDossier(full(), undefined)).not.toContain("RENDER_VERSION");
  });
});

describe("renderHash", () => {
  test("is the plain sha256 of the rendered text", () => {
    // sha256("abc")
    expect(renderHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
