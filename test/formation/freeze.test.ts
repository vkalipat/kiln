import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { hashInput, RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { freeze } from "../../src/formation/freeze";
import type { FeaturesFile } from "../../src/formation/features";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { materializeProjectPath } from "../../src/formation/paths";
import type { PhaseDeps } from "../../src/phases/frame";
import { FakeGitRunner } from "../build/fake-git";

function file(): FeaturesFile {
  return { version: 1, init: { needs: ["bun", "git"] }, features: [
    { id: "f01", title: "one", description: "one", acceptance: { type: "shell", command: "bun test", needs: ["bun", "TOKEN"] } },
    { id: "f02", title: "two", description: "two", acceptance: { type: "file", path: "out.txt", needs: ["git"] } },
    { id: "f03", title: "three", description: "three", acceptance: { type: "manual", instructions: "look" } },
  ] };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-freeze-")); const run = createRun(home, "seed", { id: "freeze-run" });
  const project = materializeProjectPath(run, undefined, { ideaId: "idea-a" }); const record = new RunRecord(run.record);
  const model = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
  const deps: PhaseDeps = { home, run, record, cfg: defaultConfig(), models: () => ({ model: model as never, ref: "mock/unused" }), apiKeyFor: async () => "key", effort: "medium", limiter: new Limiter(1) };
  return { home, run, project, record, deps, git: new FakeGitRunner(), file: file() };
}

function assertComplete(s: ReturnType<typeof setup>) {
  expect(JSON.parse(readFileSync(s.run.features, "utf8"))).toEqual(s.file);
  expect(existsSync(s.run.acceptanceLock)).toBe(true);
  expect(readFileSync(s.run.featureState, "utf8")).toBe("");
  for (const path of [s.project.repo, s.project.checksDir, s.project.blockedDir]) expect(existsSync(path)).toBe(true);
  expect(readFileSync(s.project.featuresMirror, "utf8")).toBe(readFileSync(s.run.features, "utf8"));
  expect(readFileSync(s.project.lockMirror, "utf8")).toBe(readFileSync(s.run.acceptanceLock, "utf8"));
}

describe("freeze", () => {
  test("cancellation after a durable step stops the suffix and remains resumable", async () => {
    const s = setup();
    const control = new RunControl();
    await expect(withRunControl(control, () => freeze(s.deps, s.file, "spec-hash", s.git, {
      afterStep: (step) => { if (step === 5) control.cancel("pause freeze"); },
    }))).rejects.toBeInstanceOf(RunCancelledError);
    expect(existsSync(s.project.featuresMirror)).toBe(false);
    expect(existsSync(s.project.lockMirror)).toBe(false);
    expect(s.record.read().some((event) => event.t === "freeze")).toBe(false);
    await freeze(s.deps, s.file, "spec-hash", s.git);
    assertComplete(s);
    expect(s.git.commits).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
  });

  test("performs all six steps, unions needs, and records one event", async () => {
    const s = setup(); const result = await freeze(s.deps, s.file, "spec-hash", s.git);
    assertComplete(s);
    expect(result.needsUnion).toEqual(["TOKEN", "bun", "git"]);
    expect(s.git.commits).toHaveLength(1);
    expect(s.git.commits[0]?.options).toMatchObject({ allowEmpty: true, trailers: { "Kiln-Run": "freeze-run" } });
    expect(s.record.read().filter((event) => event.t === "freeze")).toEqual([expect.objectContaining({ featureCount: 3, manualCount: 1, executableCount: 2, lockIdsHash: result.lock.ids })]);
  });

  test("recovers idempotently from a crash after every durable boundary", async () => {
    for (let crashAfter = 1; crashAfter <= 6; crashAfter += 1) {
      const s = setup();
      await expect(freeze(s.deps, s.file, "spec-hash", s.git, { afterStep: (step) => { if (step === crashAfter) throw new Error(`crash-${step}`); } })).rejects.toThrow(`crash-${crashAfter}`);
      await freeze(s.deps, s.file, "spec-hash", s.git);
      assertComplete(s);
      expect(s.git.commits).toHaveLength(1);
      expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
    }
  });

  test("repairs poisoned mirrors from authoritative copies without duplicate commit or event", async () => {
    const s = setup(); const first = await freeze(s.deps, s.file, "spec-hash", s.git);
    writeFileSync(s.run.features, JSON.stringify(s.file)); writeFileSync(s.run.acceptanceLock, JSON.stringify(first.lock));
    writeFileSync(s.project.featuresMirror, "poison features"); writeFileSync(s.project.lockMirror, "poison lock");
    const result = await freeze(s.deps, s.file, "spec-hash", s.git);
    expect(result.reconciled).toBe(true); assertComplete(s);
    expect(s.git.commits).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
  });

  test("refuses an authoritative feature mismatch instead of trusting the mirror or proposal", async () => {
    const s = setup(); await freeze(s.deps, s.file, "spec-hash", s.git);
    const changed = structuredClone(s.file); changed.features[0]!.description = "changed";
    await expect(freeze(s.deps, changed, "spec-hash", s.git)).rejects.toThrow(/authoritative features differ/);
  });

  test("commits initialization changes even when an adopted repo already has a HEAD", async () => {
    const s = setup(); s.git.head = "a".repeat(40); s.git.status = " M .gitignore\n";
    await freeze(s.deps, s.file, "spec-hash", s.git);
    expect(s.git.commits).toHaveLength(1);
  });

  test("a historical freeze suppresses only an exact current match", async () => {
    const s = setup();
    s.record.append({ t: "freeze", featureCount: 9, lockIdsHash: "old", lockHash: "old-lock", manualCount: 0, executableCount: 9, needsUnion: ["old"], specHash: "old-spec" });
    const result = await freeze(s.deps, s.file, "spec-hash", s.git);
    const events = s.record.read().filter((event) => event.t === "freeze");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ lockIdsHash: result.lock.ids, specHash: "spec-hash", featureCount: 3 });
    await freeze(s.deps, s.file, "spec-hash", s.git);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(2);
  });

  test("same summary fields with changed acceptance content emits a new freeze event", async () => {
    const s = setup(); const oldFile = structuredClone(s.file);
    (oldFile.features[0]!.acceptance as { command: string }).command = "bun test old";
    const oldLock = writeAcceptanceLock(oldFile, "spec-hash");
    s.record.append({
      t: "freeze", featureCount: 3, lockIdsHash: oldLock.ids, lockHash: hashInput(oldLock),
      manualCount: 1, executableCount: 2, needsUnion: ["TOKEN", "bun", "git"], specHash: "spec-hash",
    });
    const result = await freeze(s.deps, s.file, "spec-hash", s.git);
    expect(result.lock.ids).toBe(oldLock.ids);
    expect(hashInput(result.lock)).not.toBe(hashInput(oldLock));
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(2);
    await freeze(s.deps, s.file, "spec-hash", s.git);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(2);
  });
});
