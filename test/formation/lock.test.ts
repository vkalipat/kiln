import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, readStatus } from "../../src/core/run";
import { hashInput, RunRecord } from "../../src/core/record";
import type { FeaturesFile } from "../../src/formation/features";
import { relock, verifyAcceptanceLock, writeAcceptanceLock } from "../../src/formation/lock";
import { materializeProjectPath } from "../../src/formation/paths";

function features(): FeaturesFile {
  return {
    version: 1,
    init: { needs: ["bun"] },
    features: [
      { id: "f01", title: "One", description: "one", acceptance: { type: "shell", command: "bun test", expect: { type: "substring", value: "pass" }, needs: ["TOKEN"] } },
      { id: "f02", title: "Two", description: "two", acceptance: { type: "file", path: "out.txt", contains: "ready" } },
      { id: "f03", title: "Three", description: "three", acceptance: { type: "manual", instructions: "Inspect it" } },
    ],
  };
}

describe("acceptance lock", () => {
  test("hashes ids, init and each acceptance object canonically", () => {
    const file = features(); const lock = writeAcceptanceLock(file, "spec-a");
    expect(lock).toEqual({
      version: 1,
      ids: hashInput(["f01", "f02", "f03"]),
      init: hashInput({ needs: ["bun"] }),
      features: Object.fromEntries(file.features.map((feature) => [feature.id, hashInput(feature.acceptance)])),
      specHash: "spec-a",
    });
    const reordered = structuredClone(file);
    reordered.features[0]!.acceptance = { needs: ["TOKEN"], expect: { value: "pass", type: "substring" }, command: "bun test", type: "shell" };
    expect(writeAcceptanceLock(reordered, "spec-a")).toEqual(lock);
  });

  test("reports ids, init and feature mutations while treating spec drift as observational", () => {
    const file = features(); const lock = writeAcceptanceLock(file, hashInput("spec\n"));
    expect(verifyAcceptanceLock(file, lock, hashInput("spec\n"))).toEqual({ ok: true, changed: [], specDrift: false });
    expect(verifyAcceptanceLock(file, lock, hashInput("spec \n"))).toEqual({ ok: true, changed: [], specDrift: true });

    const acceptanceChanged = structuredClone(file); (acceptanceChanged.features[0]!.acceptance as { command: string }).command += " --changed";
    expect(verifyAcceptanceLock(acceptanceChanged, lock, lock.specHash)).toMatchObject({ ok: false, changed: ["features.f01"] });
    const idsChanged = structuredClone(file); idsChanged.features.reverse();
    expect(verifyAcceptanceLock(idsChanged, lock, lock.specHash).changed).toContain("ids");
    const initChanged = structuredClone(file); initChanged.init.needs.push("git");
    expect(verifyAcceptanceLock(initChanged, lock, lock.specHash).changed).toContain("init");
    const extraHash = structuredClone(lock); extraHash.features.f99 = "poison";
    expect(verifyAcceptanceLock(file, extraHash, lock.specHash).changed).toContain("features.f99");
  });

  test("rejects malformed runtime lock shapes without throwing", () => {
    const file = features();
    for (const malformed of [
      null,
      [],
      {},
      { version: "1", ids: 7, init: null, features: null, specHash: 9 },
      { version: 1, ids: "wrong", init: "wrong", features: [], specHash: "spec" },
    ]) {
      const result = verifyAcceptanceLock(file, malformed, "current");
      expect(result.ok).toBe(false);
      expect(result.changed.length).toBeGreaterThan(0);
    }
    const valid = writeAcceptanceLock(file, "old-spec");
    expect(verifyAcceptanceLock(file, valid, "new-spec")).toEqual({ ok: true, changed: [], specDrift: true });
  });

  test("relock writes the authoritative lock and mirror, status, and before/after event", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-relock-")); const run = createRun(home, "seed", { id: "run-a" });
    const project = materializeProjectPath(run, undefined, { ideaId: "idea-a" }); const record = new RunRecord(run.record);
    const previous = writeAcceptanceLock(features(), "old-spec");
    writeFileSync(run.acceptanceLock, `${JSON.stringify(previous)}\n`);
    const nextFile = features(); (nextFile.features[1]!.acceptance as { contains: string }).contains = "new";
    const next = relock(run, nextFile, "new-spec", record);
    expect(JSON.parse(readFileSync(run.acceptanceLock, "utf8"))).toEqual(next);
    expect(readFileSync(project.lockMirror, "utf8")).toBe(readFileSync(run.acceptanceLock, "utf8"));
    expect(readStatus(run)).toMatchObject({ specHash: "new-spec", relocked: true });
    expect(record.read().find((event) => event.t === "relock")).toMatchObject({ before: hashInput(previous), after: hashInput(next), confirmed: true });
  });
});
