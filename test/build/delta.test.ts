import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDelta, playbookBulletIds, playbookSections, stripCounters, validateDelta, writeCandidate, type DeltaContext, type PlaybookDelta } from "../../src/build/delta";
import { loadPlaybook } from "../../src/brain/prompts";

function context(): DeltaContext {
  const runDir = mkdtempSync(join(tmpdir(), "kiln-delta-run-")); writeFileSync(join(runDir, "seed.md"), "seed");
  const projectDir = mkdtempSync(join(tmpdir(), "kiln-delta-project-")); writeFileSync(join(projectDir, "spec.md"), "spec");
  mkdirSync(join(projectDir, "repo"), { recursive: true }); writeFileSync(join(projectDir, "repo", "x.md"), "x");
  writeFileSync(join(runDir, "outside.md"), "o");
  return {
    digestHeadings: ["Event counts", "Feature f01"], runDir, projectDir,
    metrics: { costUsd: 1.5, costByPhase: { reflect: 0.1 }, checkPassRate: { acceptance: null }, stopKind: "budget" },
    playbook: loadPlaybook(mkdtempSync(join(tmpdir(), "kiln-delta-home-"))),
  };
}

const digest = { kind: "digest" as const, ref: "Event counts" };
const delta = (patch: Partial<PlaybookDelta>): PlaybookDelta => ({
  op: "edit", section: "build", id: "B1", text: "Keep one feature per fresh session.",
  why: "Fresh context isolates failures.", evidence: [digest], ...patch,
});

describe("playbook parsing", () => {
  test("strips counters while preserving lesson bytes and optional delta metadata", () => {
    const md = "## build\n- B1 [helpful:12 harmful:3] Keep the evidence.\n";
    expect(stripCounters(md)).toBe("## build\n- B1 Keep the evidence.\n");
    expect(stripCounters(md.replace("helpful:12 harmful:3", "helpful:99 harmful:0"))).toBe(stripCounters(md));
    expect(stripCounters(md.replace("evidence", "checks"))).not.toBe(stripCounters(md));
    const value = delta({ why: "A failed check exposed the issue.", kind: "correction" });
    expect(parseDelta(value)).toEqual({ delta: value });
    expect(validateDelta(value, context())).toEqual({ ok: true });
    expect(parseDelta({ ...value, why: 1 })).toMatchObject({ reason: expect.any(String) });
  });
  test("lists sections and bullet ids from the bundled playbook", () => {
    const md = context().playbook;
    expect(playbookSections(md)).toEqual(["lenses", "frame", "discover", "ideate", "form", "build"]);
    expect(playbookBulletIds(md, "build")).toEqual(["B1", "B2", "B3", "B4"]);
    expect(playbookBulletIds(md)).toContain("FM1");
    expect(playbookBulletIds(md, "missing")).toEqual([]);
  });
});

describe("parseDelta", () => {
  test("accepts the tool schema shape and rejects anything else with a reason", () => {
    expect(parseDelta({ op: "add", section: "build", text: "t", evidence: [digest] })).toEqual({ delta: { op: "add", section: "build", id: undefined, text: "t", evidence: [digest] } });
    expect(parseDelta(null)).toMatchObject({ reason: expect.stringContaining("object") });
    expect(parseDelta({ op: "drop", section: "build", text: "t", evidence: [digest] })).toMatchObject({ reason: expect.stringContaining("op") });
    expect(parseDelta({ op: "add", text: "t", evidence: [digest] })).toMatchObject({ reason: expect.stringContaining("section") });
    expect(parseDelta({ op: "add", section: "build", evidence: [digest] })).toMatchObject({ reason: expect.stringContaining("text") });
    expect(parseDelta({ op: "add", section: "build", text: "t", evidence: "digest" })).toMatchObject({ reason: expect.stringContaining("evidence") });
    expect(parseDelta({ op: "add", section: "build", text: "t", evidence: [{ kind: "web", ref: "x" }] })).toMatchObject({ reason: expect.stringContaining("kind") });
    expect(parseDelta({ op: "add", section: "build", text: "t", evidence: [{ kind: "digest", ref: "" }] })).toMatchObject({ reason: expect.stringContaining("ref") });
    expect(parseDelta({ op: "add", section: "build", id: 7, text: "t", evidence: [digest] })).toMatchObject({ reason: expect.stringContaining("id") });
  });
});

describe("validateDelta", () => {
  test("accepts edit and retire of existing bullets, and add with no id or a fresh id", () => {
    const ctx = context();
    expect(validateDelta(delta({}), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ op: "retire", id: "B2", text: "", evidence: [{ kind: "metric", ref: "costUsd" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ op: "add", id: undefined, text: "Verify a new lesson." }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ op: "add", id: "B9", text: "Record a different lesson." }), ctx)).toEqual({ ok: true });
  });

  test("rejects unknown sections, missing or unknown ids, colliding ids, and empty text", () => {
    const ctx = context();
    expect(validateDelta(delta({ section: "reflect" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('section "reflect"') });
    expect(validateDelta(delta({ id: undefined }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("edit requires") });
    expect(validateDelta(delta({ id: "B7" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('"B7"') });
    expect(validateDelta(delta({ op: "retire", id: "FM1" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('"FM1"') });
    expect(validateDelta(delta({ op: "add", id: "B1", text: "x" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("collides") });
    expect(validateDelta(delta({ op: "add", id: "FM1", text: "x" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("collides") });
    expect(validateDelta(delta({ op: "add", id: undefined, text: "  " }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("text") });
    expect(validateDelta(delta({ text: "" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("text") });
  });

  test("requires evidence and resolves every ref by kind", () => {
    const ctx = context();
    expect(validateDelta(delta({ evidence: [] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(validateDelta(delta({ evidence: [{ kind: "digest", ref: "Feature f01" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ evidence: [{ kind: "digest", ref: "Feature f02" }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('digest ref "Feature f02"') });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "seed.md" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "spec.md" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "nope.md" }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('file ref "nope.md"') });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "repo/x.md" }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("repo/") });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: join(ctx.runDir, "seed.md") }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("relative") });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "../outside.md" }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("relative") });
    expect(validateDelta(delta({ evidence: [{ kind: "metric", ref: "costUsd" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ evidence: [{ kind: "metric", ref: "costByPhase.reflect" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ evidence: [{ kind: "metric", ref: "checkPassRate.acceptance" }] }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ evidence: [{ kind: "metric", ref: "costByPhase.nope" }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('metric ref "costByPhase.nope"') });
    expect(validateDelta(delta({ evidence: [{ kind: "metric", ref: "stopKind.deep" }] }), ctx)).toMatchObject({ ok: false });
    for (const ref of ["toString", "constructor", "constructor.prototype", "__proto__", "hasOwnProperty", "costByPhase.toString", "costByPhase.__proto__", "costByPhase.constructor.name"]) {
      expect(validateDelta(delta({ evidence: [{ kind: "metric", ref }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining(`metric ref "${ref}"`) });
    }
    expect(validateDelta(delta({ evidence: [digest, { kind: "metric", ref: "missing" }] }), ctx)).toMatchObject({ ok: false });
  });

  test("without a project dir, project-side file refs do not resolve", () => {
    const ctx = { ...context(), projectDir: undefined };
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "spec.md" }] }), ctx)).toMatchObject({ ok: false });
    expect(validateDelta(delta({ evidence: [{ kind: "file", ref: "seed.md" }] }), ctx)).toEqual({ ok: true });
  });

  test("enforces the Why, kind, sentence and retirement evidence rules", () => {
    const ctx = context();
    expect(validateDelta(delta({ why: undefined }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("missing_why") });
    expect(validateDelta(delta({ why: undefined, text: "Keep one feature per session. Why: Fresh context isolates failures." }), ctx)).toEqual({ ok: true });
    expect(validateDelta(delta({ text: "Keep one feature. Start another." }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("sentence_shape") });
    expect(validateDelta(delta({ text: `${"Keep work narrow ".repeat(20)}.` }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("sentence_too_long") });
    expect(validateDelta(delta({ kind: "suggestion" }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("invalid_kind") });
    expect(validateDelta(delta({ op: "retire", id: "B2", text: "", evidence: [digest] }), ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("retire_requires_metric") });
  });

  test("rejects unavailable tools, literal conflicts, duplicate additions and fact-shaped lessons", () => {
    const base = context();
    expect(validateDelta(delta({ section: "ideate", id: "M1", text: "Run bash before accepting a candidate." }), base)).toMatchObject({ ok: false, reason: expect.stringContaining("unavailable_tool") });

    const kernel = "Always preserve every exact authorized user constraint before any optional guidance.";
    expect(validateDelta(delta({ text: "Do not preserve every exact authorized user constraint before any optional guidance." }), { ...base, kernel })).toMatchObject({ ok: false, reason: expect.stringContaining("kernel_conflict") });
    expect(validateDelta(delta({ text: "Never retain every exact evaluator requirement before applying any optional change." }), { ...base, rolePrompt: "Retain every exact evaluator requirement before applying any optional change." })).toMatchObject({ ok: false, reason: expect.stringContaining("prompt_conflict") });

    const existing = "Combine two frontier ideas: take the mechanism of one and the user or setting of the other, and make the join coherent rather than stapled.";
    expect(validateDelta(delta({ op: "add", section: "ideate", id: undefined, text: existing }), base)).toMatchObject({ ok: false, reason: expect.stringContaining("duplicate_bullet") });
    expect(validateDelta(delta({ text: "Event counts." }), base)).toMatchObject({ ok: false, reason: expect.stringContaining("fact_not_lesson") });
    expect(validateDelta(delta({ text: "Record event counts." }), base)).toMatchObject({ ok: false, reason: expect.stringContaining("fact_not_lesson") });
  });
});

describe("writeCandidate", () => {
  test("writes the candidate JSON with every field", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-candidate-"));
    const path = join(dir, "evolution", "candidates", "run-1.json");
    const candidate = { runId: "run-1", digestHash: "d", playbookHash: "p", reflectorModelRef: "mock/reflector", delta: delta({}), createdAt: "2026-09-04T00:00:00.000Z" };
    writeCandidate(path, candidate);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(candidate);
  });
});
