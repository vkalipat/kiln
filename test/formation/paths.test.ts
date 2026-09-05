import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRun } from "../../src/core/run";
import {
  adoptDecision,
  materializeProjectPath,
  projectPaths,
  readProjectMarker,
  writeProjectMarker,
  type ProjectMarker,
} from "../../src/formation/paths";

function temp(prefix = "kiln-formation-paths-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function marker(runId = "run-a", ideaId = "idea-a"): ProjectMarker {
  return { runId, ideaId, kilnVersion: "0.1.0", createdAt: "2026-09-04T00:00:00.000Z" };
}

describe("projectPaths and project markers", () => {
  test("names the complete project layout without touching disk", () => {
    const dir = join(temp(), "project");
    expect(projectPaths(dir)).toEqual({
      dir,
      projectJson: join(dir, "project.json"),
      spec: join(dir, "spec.md"),
      initSh: join(dir, "init.sh"),
      progress: join(dir, "progress.md"),
      audit: join(dir, "audit.md"),
      checksDir: join(dir, "checks"),
      blockedDir: join(dir, "blocked"),
      repo: join(dir, "repo"),
      featuresMirror: join(dir, "features.json"),
      lockMirror: join(dir, "acceptance.lock"),
    });
    expect(existsSync(dir)).toBe(false);
  });

  test("writes and reads a marker atomically, rejecting malformed marker content", () => {
    const dir = temp();
    writeProjectMarker(dir, marker());
    expect(readProjectMarker(dir)).toEqual(marker());
    writeFileSync(join(dir, "project.json"), "not-json");
    expect(readProjectMarker(dir)).toBeUndefined();
    expect(adoptDecision(dir, "run-a", "idea-a")).toBe("refuse:project.json is invalid");
  });
});

describe("adoptDecision", () => {
  test("implements the empty, matching, mismatch, unmarked and git-only matrix", () => {
    const empty = temp();
    expect(adoptDecision(empty, "run-a", "idea-a")).toBe("adopt");

    const matching = temp(); writeProjectMarker(matching, marker()); writeFileSync(join(matching, "keep.txt"), "held");
    expect(adoptDecision(matching, "run-a", "idea-a")).toBe("adopt");

    const otherRun = temp(); writeProjectMarker(otherRun, marker("run-b", "idea-a"));
    expect(adoptDecision(otherRun, "run-a", "idea-a")).toContain("refuse:project.json belongs to run run-b");

    const otherIdea = temp(); writeProjectMarker(otherIdea, marker("run-a", "idea-b"));
    expect(adoptDecision(otherIdea, "run-a", "idea-a")).toContain("refuse:project.json belongs to idea idea-b");

    const unmarked = temp(); writeFileSync(join(unmarked, "keep.txt"), "held");
    expect(adoptDecision(unmarked, "run-a", "idea-a")).toContain("refuse:non-empty unmarked");

    const gitOnly = temp(); mkdirSync(join(gitOnly, ".git"));
    expect(adoptDecision(gitOnly, "run-a", "idea-a")).toContain("refuse:non-empty unmarked");
  });

  test("force flips content-based refusals without deleting anything", () => {
    for (const setup of [
      (dir: string) => writeProjectMarker(dir, marker("other", "idea-a")),
      (dir: string) => writeProjectMarker(dir, marker("run-a", "other")),
      (dir: string) => writeFileSync(join(dir, "unmarked.txt"), "keep"),
      (dir: string) => mkdirSync(join(dir, ".git")),
    ]) {
      const dir = temp(); setup(dir); writeFileSync(join(dir, "sentinel"), "preserve");
      expect(adoptDecision(dir, "run-a", "idea-a", { force: true })).toBe("adopt");
      expect(readFileSync(join(dir, "sentinel"), "utf8")).toBe("preserve");
    }
  });

  test("allows a matching marker with empty reserved directories", () => {
    const dir = temp();
    writeProjectMarker(dir, marker());
    mkdirSync(join(dir, "checks")); mkdirSync(join(dir, "blocked"));
    expect(adoptDecision(dir, "run-a", "idea-a")).toBe("adopt");
  });

  test("refuses a dangling symlink instead of mistaking it for an absent directory", () => {
    const dir = join(temp(), "project");
    symlinkSync(join(temp(), "missing"), dir, "dir");
    expect(adoptDecision(dir, "run-a", "idea-a")).toBe("refuse:project path is not a directory");
  });
});

describe("materializeProjectPath", () => {
  test("creates the default project as a real directory with the explicit idea marker", () => {
    const run = createRun(temp(), "seed", { id: "run-a" });
    const paths = materializeProjectPath(run, undefined, { ideaId: "explicit-idea", createdAt: marker().createdAt });
    expect(lstatSync(paths.dir).isDirectory()).toBe(true);
    expect(lstatSync(paths.dir).isSymbolicLink()).toBe(false);
    expect(readProjectMarker(paths.dir)).toMatchObject({ runId: "run-a", ideaId: "explicit-idea" });
  });

  test("adopts an external directory through the stable run-side symlink", () => {
    const run = createRun(temp(), "seed", { id: "run-a" });
    const out = join(temp(), "new-project");
    const paths = materializeProjectPath(run, out, { ideaId: "idea-a" });
    expect(lstatSync(run.project).isSymbolicLink()).toBe(true);
    expect(realpathSync(run.project)).toBe(realpathSync(out));
    expect(paths.spec).toBe(join(run.project, "spec.md"));
    expect(readProjectMarker(out)).toMatchObject({ runId: "run-a", ideaId: "idea-a" });
  });

  test("resolves a valid external directory symlink before adopting it", () => {
    const run = createRun(temp(), "seed", { id: "run-a" });
    const target = temp(); const alias = join(temp(), "alias"); symlinkSync(target, alias, "dir");
    materializeProjectPath(run, alias, { ideaId: "idea-a" });
    expect(realpathSync(run.project)).toBe(realpathSync(target));
    expect(readProjectMarker(target)).toMatchObject({ ideaId: "idea-a" });
  });

  test("uses physical paths for externality, including aliases and missing children", () => {
    const run = createRun(temp(), "seed", { id: "run-a" });
    const internal = join(run.dir, "internal"); mkdirSync(internal);
    const outsideAlias = join(temp(), "alias-to-internal"); symlinkSync(internal, outsideAlias, "dir");
    expect(() => materializeProjectPath(run, outsideAlias, { ideaId: "idea-a" })).toThrow(/resolve outside/);

    const parentAlias = join(temp(), "alias-parent"); symlinkSync(run.dir, parentAlias, "dir");
    const missingChild = join(parentAlias, "missing-child");
    expect(() => materializeProjectPath(run, missingChild, { ideaId: "idea-a" })).toThrow(/resolve outside/);
    expect(existsSync(join(run.dir, "missing-child"))).toBe(false);

    const deepSegments = Array.from({ length: 24 }, (_, index) => `missing-${index}`);
    const deepMissingChild = join(parentAlias, ...deepSegments);
    expect(() => materializeProjectPath(run, deepMissingChild, { ideaId: "idea-a" })).toThrow(/resolve outside/);
    expect(existsSync(join(run.dir, ...deepSegments))).toBe(false);

    const dotDotPrefix = join(run.dir, "..internal");
    expect(() => materializeProjectPath(run, dotDotPrefix, { ideaId: "idea-a" })).toThrow(/resolve outside/);
    expect(existsSync(dotDotPrefix)).toBe(false);

    // The textual alias is inside the run, but its resolved target is genuinely external.
    const external = temp(); const internalAlias = join(run.dir, "external-alias"); symlinkSync(external, internalAlias, "dir");
    materializeProjectPath(run, internalAlias, { ideaId: "idea-a" });
    expect(realpathSync(run.project)).toBe(realpathSync(external));
  });

  test("reserves the exact run project entry after it becomes an external symlink", () => {
    const run = createRun(temp(), "seed", { id: "run-a" }); const external = temp();
    materializeProjectPath(run, external, { ideaId: "idea-a" });
    expect(realpathSync(run.project)).toBe(realpathSync(external));
    expect(() => materializeProjectPath(run, run.project, { ideaId: "idea-a" })).toThrow(/cannot be the run project entry/);
    expect(realpathSync(run.project)).toBe(realpathSync(external));
  });

  test("refuses a wrong target or dangling link unless forced, then replaces only the link", () => {
    const home = temp(); const run = createRun(home, "seed", { id: "run-a" });
    const oldTarget = temp(); const nextTarget = temp();
    writeFileSync(join(oldTarget, "sentinel"), "old target survives");
    symlinkSync(oldTarget, run.project, "dir");
    expect(() => materializeProjectPath(run, nextTarget, { ideaId: "idea-a" })).toThrow(/project link points/);
    materializeProjectPath(run, nextTarget, { ideaId: "idea-a", force: true });
    expect(realpathSync(run.project)).toBe(realpathSync(nextTarget));
    expect(readFileSync(join(oldTarget, "sentinel"), "utf8")).toBe("old target survives");

    const danglingRun = createRun(temp(), "seed", { id: "run-b" });
    const missing = join(temp(), "missing-target");
    symlinkSync(missing, danglingRun.project, "dir");
    expect(() => materializeProjectPath(danglingRun, temp(), { ideaId: "idea-b" })).toThrow(/project link points/);
    const replacement = temp();
    materializeProjectPath(danglingRun, replacement, { ideaId: "idea-b", force: true });
    expect(resolve(dirname(danglingRun.project), readlinkSync(danglingRun.project))).toBe(realpathSync(replacement));
  });

  test("force adopts a mismatched marked target and preserves unrelated contents", () => {
    const run = createRun(temp(), "seed", { id: "run-a" }); const out = temp();
    writeProjectMarker(out, marker("other-run", "other-idea"));
    writeFileSync(join(out, "sentinel"), "preserve");
    expect(() => materializeProjectPath(run, out, { ideaId: "idea-a" })).toThrow(/belongs to run/);
    materializeProjectPath(run, out, { ideaId: "idea-a", force: true });
    expect(readFileSync(join(out, "sentinel"), "utf8")).toBe("preserve");
    expect(readProjectMarker(out)).toMatchObject({ runId: "run-a", ideaId: "idea-a" });
  });

  test("refuses self-targets, run-internal targets and external dangling targets even with force", () => {
    const run = createRun(temp(), "seed", { id: "run-a" });
    expect(() => materializeProjectPath(run, run.project, { ideaId: "idea-a", force: true })).toThrow(/run project entry/);
    expect(() => materializeProjectPath(run, join(run.dir, "nested"), { ideaId: "idea-a", force: true })).toThrow(/resolve outside/);
    const dangling = join(temp(), "dangling"); symlinkSync(join(temp(), "absent"), dangling, "dir");
    expect(() => materializeProjectPath(run, dangling, { ideaId: "idea-a", force: true })).toThrow(/not a directory|ENOENT/);
  });

  test("refuses home-contained targets except projects under home/runs", () => {
    const home = temp();
    const run = createRun(home, "seed", { id: "run-a" });
    for (const target of [join(home, "evals", "x"), join(home, "playbook", "x"), join(home, "other")]) {
      expect(() => materializeProjectPath(run, target, { ideaId: "idea-a" })).toThrow(/inside the kiln home outside runs/);
      expect(existsSync(target)).toBe(false);
    }

    const otherRunProject = join(home, "runs", "run-b", "project");
    const paths = materializeProjectPath(run, otherRunProject, { ideaId: "idea-a" });
    expect(realpathSync(paths.dir)).toBe(realpathSync(otherRunProject));
  });
});
