import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_CAP_BYTES, bundleMarkdown, bundleProjectDir } from "../../src/build/bundle";
import { initHome } from "../../src/core/home";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { projectPaths } from "../../src/formation/paths";

function setup(options: { chosen?: string; project?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-bundle-")); initHome(home);
  const run = createRun(home, "SEED TEXT");
  writeFileSync(run.brief, "BRIEF TEXT\n"); writeFileSync(run.landscape, "LANDSCAPE TEXT\n"); writeFileSync(run.notes, "NOTES TEXT\n");
  writeFileSync(join(run.ideasDir, "a.md"), "IDEA A\n"); writeFileSync(join(run.ideasDir, "b.md"), "IDEA B\n");
  writeFileSync(run.record, `${JSON.stringify({ seq: 1, ts: "t", t: "note", text: "SENTINEL_RECORD" })}\n`);
  mkdirSync(join(home, "evals", "seeds"), { recursive: true }); writeFileSync(join(home, "evals", "seeds", "s.md"), "SENTINEL_EVALS\n");
  let projectDir: string | undefined;
  if (options.project !== false) {
    projectDir = mkdtempSync(join(tmpdir(), "kiln-project-")); const project = projectPaths(projectDir);
    mkdirSync(project.repo, { recursive: true }); mkdirSync(project.checksDir, { recursive: true }); mkdirSync(project.blockedDir, { recursive: true });
    writeFileSync(project.spec, "SPEC TEXT\n"); writeFileSync(project.audit, "AUDIT TEXT\n"); writeFileSync(project.progress, "PROGRESS TEXT\n");
    writeFileSync(join(project.repo, "README.md"), "SENTINEL_REPO\n"); writeFileSync(join(project.checksDir, "c.md"), "SENTINEL_CHECKS\n"); writeFileSync(join(project.blockedDir, "b.md"), "SENTINEL_BLOCKED\n");
    writeFileSync(project.initSh, "SENTINEL_INIT\n");
  }
  writeStatus(run, { chosenIdeaId: options.chosen ?? "a", projectDir });
  return { home, run, projectDir };
}

describe("bundleMarkdown", () => {
  test("includes only the allowlisted run and project markdown, in order, fenced under relative-path headings", () => {
    const s = setup();
    const bundle = bundleMarkdown(s.run, s.projectDir);
    expect(bundle.included).toEqual(["seed.md", "brief.md", "landscape.md", "notes.md", "ideas/a.md", "spec.md", "audit.md", "progress.md"]);
    expect(bundle.omitted).toEqual([]);
    expect(bundle.bytes).toBe(Buffer.byteLength(bundle.text));
    for (const heading of bundle.included) expect(bundle.text).toContain(`## ${heading}\n`);
    for (const content of ["SEED TEXT", "BRIEF TEXT", "LANDSCAPE TEXT", "NOTES TEXT", "IDEA A", "SPEC TEXT", "AUDIT TEXT", "PROGRESS TEXT"]) expect(bundle.text).toContain(content);
    for (const sentinel of ["IDEA B", "SENTINEL_RECORD", "SENTINEL_EVALS", "SENTINEL_REPO", "SENTINEL_CHECKS", "SENTINEL_BLOCKED", "SENTINEL_INIT"]) expect(bundle.text).not.toContain(sentinel);
    expect(bundle.text.indexOf("## seed.md")).toBeLessThan(bundle.text.indexOf("## spec.md"));
  });

  test("fences content with more backticks than the content uses", () => {
    const s = setup();
    writeFileSync(s.run.notes, "before\n```\ncode\n```\nafter\n");
    const bundle = bundleMarkdown(s.run, s.projectDir);
    const section = bundle.text.slice(bundle.text.indexOf("## notes.md"), bundle.text.indexOf("## ideas/a.md"));
    expect(section).toContain("\n````\nbefore\n```\ncode\n```\nafter\n````\n");
  });

  test("skips a symlinked allowlisted entry and never follows it into record.jsonl", () => {
    const s = setup();
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(s.run.notes); symlinkSync(s.run.record, s.run.notes);
    const bundle = bundleMarkdown(s.run, s.projectDir);
    expect(bundle.included).not.toContain("notes.md");
    expect(bundle.omitted).toEqual(["notes.md"]);
    expect(bundle.text).not.toContain("SENTINEL_RECORD");
  });

  test("omits an oversized file whole and keeps the rest, then takes progress.md as a line-aligned tail", () => {
    const s = setup();
    writeFileSync(s.run.landscape, `${"L".repeat(BUNDLE_CAP_BYTES + 10)}\n`);
    const lines = Array.from({ length: 2_000 }, (_, index) => `progress line ${String(index).padStart(5, "0")} ${"p".repeat(20)}`);
    writeFileSync(projectPaths(s.projectDir!).progress, `${lines.join("\n")}\n`);
    const bundle = bundleMarkdown(s.run, s.projectDir);
    expect(bundle.omitted).toEqual(["landscape.md"]);
    expect(bundle.included).toEqual(["seed.md", "brief.md", "notes.md", "ideas/a.md", "spec.md", "audit.md", "progress.md"]);
    expect(bundle.bytes).toBeLessThanOrEqual(BUNDLE_CAP_BYTES);
    expect(bundle.text).toContain("## progress.md\n(tail: last ");
    expect(bundle.text).toContain(lines.at(-1)!);
    expect(bundle.text).not.toContain(lines[0]!);
    const tail = bundle.text.slice(bundle.text.indexOf("## progress.md")).split("\n");
    expect(tail[1]).toMatch(/^\(tail: last \d+ of \d+ bytes\)$/);
    expect(tail[2]).toBe("```");
    expect(tail[3]).toMatch(/^progress line \d{5} p{20}$/);
  });

  test("omits progress.md when nothing is left for even one line, and ignores an unsafe chosen idea id", () => {
    const s = setup({ chosen: "../seed" });
    writeFileSync(s.run.notes, `${"N".repeat(BUNDLE_CAP_BYTES - 400)}\n`);
    writeFileSync(projectPaths(s.projectDir!).progress, `${"P".repeat(2_000)}\n`);
    const bundle = bundleMarkdown(s.run, s.projectDir);
    expect(bundle.included).not.toContain("progress.md");
    expect(bundle.included.some((label) => label.startsWith("ideas/"))).toBe(false);
    expect(bundle.bytes).toBeLessThanOrEqual(BUNDLE_CAP_BYTES);
  });

  test("bundles only run-side files when there is no project dir", () => {
    const s = setup({ project: false });
    const bundle = bundleMarkdown(s.run, undefined);
    expect(bundle.included).toEqual(["seed.md", "brief.md", "landscape.md", "notes.md", "ideas/a.md"]);
  });
});

describe("bundleProjectDir", () => {
  test("prefers status.projectDir, then the real path of the run's project entry", () => {
    const s = setup();
    expect(bundleProjectDir(s.run, readStatus(s.run))).toBe(s.projectDir);
    const target = mkdtempSync(join(tmpdir(), "kiln-target-"));
    symlinkSync(target, s.run.project);
    expect(bundleProjectDir(s.run, { projectDir: undefined })).toBe(realpathSync(target));
    const bare = setup({ project: false });
    expect(bundleProjectDir(bare.run, { projectDir: undefined })).toBeUndefined();
  });
});
