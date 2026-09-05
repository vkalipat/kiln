import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { projectPaths } from "../../src/formation/paths";
import type { FeaturesFile } from "../../src/formation/features";

const FEATURES: FeaturesFile = {
  version: 1, init: { needs: [] },
  features: [{ id: "f01", title: "One", description: "deliver one", acceptance: { type: "file", path: "one.txt" } }],
};

function output() {
  const out: string[] = []; const err: string[] = [];
  return { out, err, io: { write: (text: string) => out.push(text), error: (text: string) => err.push(text) } };
}

function setup(phase: "form" | "build" | "reflect" = "build") {
  const home = mkdtempSync(join(tmpdir(), "kiln-project-")); initHome(home);
  const run = createRun(home, "seed", { id: "run-a" });
  const project = projectPaths(run.project); mkdirSync(project.dir); mkdirSync(project.repo);
  writeFileSync(project.spec, "# Spec\n");
  writeFileSync(run.features, `${JSON.stringify(FEATURES, null, 2)}\n`);
  writeFileSync(run.acceptanceLock, `${JSON.stringify(writeAcceptanceLock(FEATURES, "old"))}\n`);
  writeStatus(run, { phase, state: "running", projectDir: project.dir, chosenIdeaId: "idea-a" });
  const model = createMockModel({ id: "seat", responses: [{ content: ["unused"] }] as never });
  return { home, run, project, model, record: new RunRecord(run.record) };
}

describe("kiln project", () => {
  test("status and audit read authoritative run copies after every project mirror is poisoned", async () => {
    const s = setup();
    writeFileSync(s.run.featureState, `${JSON.stringify({ t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1, repairs: 0, commitSha: "abc" })}\n`);
    const audit = { featureId: "f01", attempt: 1, checkId: "c1", sourceEventSeq: 2, createdAt: "2026-01-01T00:00:00.000Z", shape: "full", raw: { verified: ["yes"], claimedUnverified: [], regressions: [], nextSessionNotes: "next", checkQuality: { adequate: true, reason: "good" }, verdict: "agree" }, model: { provider: "p", model: "m", ref: "p/m" } } as const;
    writeFileSync(s.run.audits, `${JSON.stringify({ ...audit, attempt: 0, sourceEventSeq: 1 })}\n${JSON.stringify(audit)}\n`);

    const before = output(); expect(await main(["project", "status", s.run.id, "--home", s.home, "--json"], before.io)).toBe(0);
    const expected = JSON.parse(before.out.join(""));
    for (const [path, text] of [[s.project.featuresMirror, "garbage"], [s.project.lockMirror, "garbage"], [s.project.audit, "garbage"], [s.project.progress, "garbage"]]) writeFileSync(path, text);
    const after = output(); expect(await main(["project", "status", s.run.id, "--home", s.home, "--json"], after.io)).toBe(0);
    expect(JSON.parse(after.out.join(""))).toEqual(expected);
    expect(expected.features[0]).toMatchObject({ id: "f01", state: "passed", commitSha: "abc" });

    const audits = output(); expect(await main(["project", "audit", s.run.id, "--home", s.home, "--json"], audits.io)).toBe(0);
    expect(JSON.parse(audits.out.join(""))).toEqual([audit]);
    const text = output(); expect(await main(["project", "audit", s.run.id, "--home", s.home], text.io)).toBe(0);
    expect(text.out.join("")).toContain("# Audit f01 attempt 1");
  });

  test("form routes the authoritative choice and requested path under the command lock", async () => {
    const s = setup("form");
    let seen: unknown;
    const a = output();
    const code = await main(["project", "form", s.run.id, "--home", s.home, "--out", join(s.home, "external"), "--force", "--json"], a.io, {
      models: { brain: s.model as never }, apiKeyFor: async () => "key",
      runForm: async (deps, ideaId, options) => { seen = { ideaId, options, lockHeld: deps.lockHeld }; writeStatus(deps.run, { phase: "build", state: "running" }); return { outcome: "ok" }; },
    });
    expect(code).toBe(0);
    expect(seen).toMatchObject({ ideaId: "idea-a", options: { out: join(s.home, "external"), force: true }, lockHeld: true });
  });

  test("relock requires confirmation, resets terminal state, and a later build can proceed", async () => {
    const s = setup();
    writeStatus(s.run, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message: "lock mismatch" } });
    const refused = output(); expect(await main(["project", "relock", s.run.id, "--home", s.home], refused.io)).toBe(2);
    expect(refused.err.join("")).toContain("--confirm");
    const relocked = output(); expect(await main(["project", "relock", s.run.id, "--home", s.home, "--confirm", "--json"], relocked.io)).toBe(0);
    expect(readStatus(s.run)).toMatchObject({ phase: "build", state: "running", cursor: { step: "relocked" }, relocked: true });
    expect(readStatus(s.run).outcome).toBeUndefined();

    let built = 0; let reflected = 0; let reinit: boolean | undefined;
    const builtOut = output();
    expect(await main(["project", "build", s.run.id, "--home", s.home, "--yes", "--reinit", "--json"], builtOut.io, {
      models: { builder: s.model as never, reflector: s.model as never }, apiKeyFor: async () => "key",
      runBuild: async (deps) => { built++; reinit = deps.reinit; writeStatus(deps.run, { phase: "reflect", state: "running" }); return { outcome: "ok" }; },
      runReflect: async (deps) => { reflected++; writeStatus(deps.run, { state: "done", outcome: { kind: "success" } }); return { outcome: "ok" }; },
    })).toBe(0);
    expect({ built, reflected, reinit }).toEqual({ built: 1, reflected: 1, reinit: true });
  });

  test("build projection can decline, while json/yes skip it and single-session selects arm B", async () => {
    const s = setup();
    let calls = 0;
    const declined = output();
    expect(await main(["project", "build", s.run.id, "--home", s.home], { ...declined.io, ask: async () => "no" }, { models: { builder: s.model as never }, apiKeyFor: async () => "key", runBuild: async () => { calls++; return { outcome: "ok" }; } })).toBe(0);
    expect(calls).toBe(0); expect(declined.out.join("")).toContain("projected build usd"); expect(declined.out.join("")).toContain("build cancelled");

    let armB = 0; let reflected = 0;
    const accepted = output();
    expect(await main(["project", "build", s.run.id, "--home", s.home, "--single-session", "--json"], accepted.io, {
      models: { builder: s.model as never, reflector: s.model as never }, apiKeyFor: async () => "key",
      runBuildSingleSession: async (deps) => { armB++; writeStatus(deps.run, { phase: "reflect", state: "running" }); return { outcome: "ok" }; },
      runReflect: async (deps) => { reflected++; writeStatus(deps.run, { state: "done", outcome: { kind: "success" } }); return { outcome: "ok" }; },
    })).toBe(0);
    expect({ armB, reflected }).toEqual({ armB: 1, reflected: 1 });
    expect(accepted.out.join("")).not.toContain("projected build usd");
  });

  test("a usage pause skips reflector resolution and preserves the paused status", async () => {
    const s = setup(); let reflected = false;
    const a = output();
    expect(await main(["project", "build", s.run.id, "--home", s.home, "--yes", "--json"], a.io, {
      models: { builder: s.model as never }, apiKeyFor: async () => "key",
      runBuild: async (deps) => { writeStatus(deps.run, { state: "paused", wakeAt: "2999-01-01T00:00:00.000Z" }); return { outcome: "ok" }; },
      runReflect: async () => { reflected = true; return { outcome: "ok" }; },
    })).toBe(0);
    expect(reflected).toBe(false); expect(readStatus(s.run).state).toBe("paused");
  });

  test("unknown runs and unformed builds exit as usage errors", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-project-")); initHome(home); const a = output();
    expect(await main(["project", "status", "missing", "--home", home], a.io)).toBe(2);
    const run = createRun(home, "seed", { id: "unformed" });
    expect(await main(["project", "build", run.id, "--home", home], a.io)).toBe(2);
  });
});
