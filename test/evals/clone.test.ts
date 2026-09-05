import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRecord, hashInput } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { cloneFormedRun, cloneRunAcrossHomes } from "../../src/evals/clone";
import type { FeaturesFile } from "../../src/formation/features";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { projectPaths, readProjectMarker, writeProjectMarker } from "../../src/formation/paths";

function frozen(home: string, id: string) {
  const run = createRun(home, "seed", { id }); const project = projectPaths(run.project);
  for (const dir of [project.dir, project.repo, project.checksDir, project.blockedDir]) mkdirSync(dir, { recursive: true });
  writeProjectMarker(run.project, { runId: id, ideaId: "idea-1", kilnVersion: "test", createdAt: "2026-09-05T00:00:00.000Z" });
  const spec = "# Spec\n\n## First milestone\nWorks.\n";
  const features: FeaturesFile = { version: 1, init: { needs: [] }, features: [
    { id: "f01", title: "one", description: "one", acceptance: { type: "file", path: "out.txt" } },
  ] };
  const specHash = hashInput(spec); const lock = writeAcceptanceLock(features, specHash);
  const featureText = `${JSON.stringify(features, null, 2)}\n`; const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  writeFileSync(project.spec, spec); writeFileSync(project.initSh, "#!/bin/sh\n");
  writeFileSync(run.features, featureText); writeFileSync(project.featuresMirror, featureText);
  writeFileSync(run.acceptanceLock, lockText); writeFileSync(project.lockMirror, lockText);
  writeFileSync(run.featureState, "");
  new RunRecord(run.record).append({
    t: "freeze", featureCount: 1, lockIdsHash: lock.ids, lockHash: hashInput(lock),
    manualCount: 0, executableCount: 1, needsUnion: [], specHash,
  });
  writeStatus(run, { phase: "build", state: "running", projectDir: realpathSync(run.project), specHash });
  return { run, project, features, lock, specHash };
}

function checkpoint(home: string, id: string) {
  const run = createRun(home, "seed", { id });
  writeFileSync(run.frontier, '{"version":1,"shown":["idea-1"]}\n');
  new RunRecord(run.record).append({ t: "phase.end", phase: "ideate", outcome: "stopped" });
  writeStatus(run, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
  return run;
}

describe("cloneFormedRun", () => {
  test("copies a valid freeze and rewrites only its three run identities", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-clone-")); const source = frozen(home, "source");
    const stale = join(home, "runs", ".clone-candidate-stale"); const foreign = join(home, "runs", ".clone-candidate-foreign");
    mkdirSync(stale); mkdirSync(foreign);
    writeFileSync(join(stale, ".kiln-clone-owner.json"), `${JSON.stringify({ version: 1, pid: 999_999_999, fromHome: home, fromId: "source", toHome: home, toId: "candidate" })}\n`);
    writeFileSync(join(foreign, "user.txt"), "preserve");
    const record = readFileSync(source.run.record);
    const target = cloneFormedRun(home, "source", "candidate");
    expect(readStatus(target)).toMatchObject({ id: "candidate", projectDir: target.project, phase: "build", specHash: source.specHash });
    expect(readProjectMarker(target.project)).toMatchObject({ runId: "candidate", ideaId: "idea-1" });
    expect(readFileSync(target.record).equals(record)).toBe(true);
    expect(readFileSync(target.features).equals(readFileSync(source.run.features))).toBe(true);
    expect(readFileSync(target.acceptanceLock).equals(readFileSync(source.run.acceptanceLock))).toBe(true);
    expect(readProjectMarker(source.run.project)).toMatchObject({ runId: "source" });
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(foreign, "user.txt"), "utf8")).toBe("preserve");
    expect(readdirSync(join(home, "runs")).filter((name) => name.startsWith(".clone-candidate-") && name !== ".clone-candidate-foreign")).toEqual([]);
  });

  test("supports the checkpoint clone boundary before a project exists", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-clone-")); const source = checkpoint(home, "source");
    const record = readFileSync(source.record); const target = cloneFormedRun(home, source.id, "candidate");
    expect(readStatus(target)).toMatchObject({ id: "candidate", phase: "ideate", cursor: { step: "checkpoint" } });
    expect(readStatus(target).projectDir).toBeUndefined();
    expect(existsSync(target.project)).toBe(false);
    expect(readFileSync(target.record).equals(record)).toBe(true);
  });

  test("clones directly across staged homes and enforces the requested boundary", () => {
    const champion = mkdtempSync(join(tmpdir(), "kiln-clone-champion-")); const candidate = mkdtempSync(join(tmpdir(), "kiln-clone-candidate-"));
    mkdirSync(join(candidate, "runs")); const source = frozen(champion, "source");
    const target = cloneRunAcrossHomes({ fromHome: champion, fromId: source.run.id, toHome: candidate, toId: "candidate", boundary: "freeze" });
    expect(readStatus(target)).toMatchObject({ id: "candidate", projectDir: target.project, phase: "build" });
    expect(readProjectMarker(target.project)?.runId).toBe("candidate");
    expect(() => cloneRunAcrossHomes({ fromHome: champion, fromId: source.run.id, toHome: candidate, toId: "wrong-boundary", boundary: "checkpoint" })).toThrow(/at freeze, not checkpoint/);
  });

  test("refuses a non-local project with the binding diagnostic", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-clone-")); const source = createRun(home, "seed", { id: "source" });
    const external = mkdtempSync(join(tmpdir(), "kiln-clone-project-")); symlinkSync(external, source.project, "dir");
    expect(() => cloneFormedRun(home, "source", "target")).toThrow(/clone needs a run-local project/);
    expect(existsSync(join(home, "runs", "target"))).toBe(false);
  });

  test("refuses wrong identities, invalid locks, started builds, and mismatched mirrors", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-clone-"));
    const status = frozen(home, "wrong-status"); writeStatus(status.run, { id: "other" });
    expect(() => cloneFormedRun(home, "wrong-status", "wrong-status-copy")).toThrow(/identity mismatch/);

    const wrong = frozen(home, "wrong"); writeProjectMarker(wrong.run.project, { ...readProjectMarker(wrong.run.project)!, runId: "other" });
    expect(() => cloneFormedRun(home, "wrong", "wrong-copy")).toThrow(/marker.*identity/);

    const lock = frozen(home, "bad-lock"); writeFileSync(lock.run.acceptanceLock, "{}\n"); writeFileSync(lock.project.lockMirror, "{}\n");
    expect(() => cloneFormedRun(home, "bad-lock", "bad-lock-copy")).toThrow(/acceptance lock is invalid/);

    const started = frozen(home, "started"); writeFileSync(started.run.featureState, '{"featureId":"f01"}\n');
    expect(() => cloneFormedRun(home, "started", "started-copy")).toThrow(/already started building/);

    const mirror = frozen(home, "bad-mirror"); writeFileSync(mirror.project.featuresMirror, "{}\n");
    expect(() => cloneFormedRun(home, "bad-mirror", "mirror-copy")).toThrow(/features mirror differs/);

    const locked = frozen(home, "locked"); writeFileSync(locked.run.lock, "held\n");
    expect(() => cloneFormedRun(home, "locked", "locked-copy")).toThrow(/still locked/);
  });

  test("preserves safe internal symlinks and refuses links escaping the cloned run", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-clone-")); const safe = frozen(home, "safe");
    writeFileSync(join(safe.project.repo, "inside.txt"), "inside"); symlinkSync("inside.txt", join(safe.project.repo, "inside-link"));
    const copied = cloneFormedRun(home, "safe", "safe-copy");
    expect(readlinkSync(join(copied.project, "repo", "inside-link"))).toBe("inside.txt");

    const unsafe = frozen(home, "unsafe"); const external = join(mkdtempSync(join(tmpdir(), "kiln-clone-outside-")), "outside.txt");
    writeFileSync(external, "untouched"); symlinkSync(external, join(unsafe.project.repo, "escape"));
    expect(() => cloneFormedRun(home, "unsafe", "unsafe-copy")).toThrow(/unsafe symlink/);
    expect(readFileSync(external, "utf8")).toBe("untouched");
    expect(existsSync(join(home, "runs", "unsafe-copy"))).toBe(false);
  });

  test("refuses existing destinations without deleting their content and rejects unsafe ids", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-clone-")); const source = frozen(home, "real");
    const held = createRun(home, "do not delete", { id: "held" }); writeFileSync(join(held.dir, "owner.txt"), "user content");
    expect(() => cloneFormedRun(home, source.run.id, "held")).toThrow(/already exists/);
    expect(readFileSync(join(held.dir, "owner.txt"), "utf8")).toBe("user content");
    expect(() => cloneFormedRun(home, "../real", "other")).toThrow(/safe path segment/);
  });

  test("refuses a symlinked destination runs tree without touching its target", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kiln-clone-source-")); const source = checkpoint(sourceHome, "source");
    const targetHome = mkdtempSync(join(tmpdir(), "kiln-clone-target-")); const external = mkdtempSync(join(tmpdir(), "kiln-clone-external-"));
    symlinkSync(external, join(targetHome, "runs"), "dir");
    expect(() => cloneRunAcrossHomes({ fromHome: sourceHome, fromId: source.id, toHome: targetHome, toId: "candidate", boundary: "checkpoint" })).toThrow(/runs path must be a real directory/);
    expect(readdirSync(external)).toEqual([]);
  });
});
