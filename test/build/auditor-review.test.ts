import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { AuditorRunError, runAuditorSession, type AuditorContext, type AuditorStage } from "../../src/build/auditor";
import type { AuditSnapshot } from "../../src/build/git";
import type { CheckResult } from "../../src/build/verify";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import type { Feature } from "../../src/formation/features";
import { projectPaths } from "../../src/formation/paths";
import type { PhaseDeps } from "../../src/phases/frame";
import { FakeGitRunner } from "./fake-git";

const FEATURE: Feature = { id: "f01", title: "Feature", description: "Build", acceptance: { type: "shell", command: "printf ok" } };
const audit = (patch: Record<string, unknown> = {}) => ({
  content: [{ type: "toolCall", name: "audit", arguments: {
    verified: ["verified"], claimedUnverified: [], regressions: [], nextSessionNotes: "next",
    checkQuality: { adequate: true, reason: "good" }, verdict: "agree", ...patch,
  } }], usage: { input: 1, output: 0 },
});
const invalidAudit = { content: [{ type: "toolCall", name: "audit", arguments: { verdict: "disagree" } }], usage: { input: 1, output: 0 } };

class ReviewGit extends FakeGitRunner {
  statuses: string[] = [];
  override async createAuditSnapshot(dir: string, tempDir: string): Promise<AuditSnapshot> {
    const snapshot = await super.createAuditSnapshot(dir, tempDir);
    mkdirSync(snapshot.worktree, { recursive: true });
    writeFileSync(join(snapshot.worktree, "visible.txt"), "visible\n");
    return snapshot;
  }
  override async statusPorcelain(dir: string): Promise<string> {
    await super.statusPorcelain(dir);
    return this.statuses.shift() ?? "";
  }
}

function setup(responses: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), "kiln-auditor-review-")); initHome(home);
  const run = createRun(home, "seed"); const record = new RunRecord(run.record); const project = projectPaths(run.project);
  mkdirSync(project.repo, { recursive: true }); mkdirSync(project.checksDir, { recursive: true });
  writeFileSync(project.spec, "# Spec\n\n## First milestone\nOne result.\n");
  const model = createMockModel({
    id: "auditor", provider: "other", responses: responses as never,
    cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as never);
  const unused = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
  const deps: PhaseDeps = {
    home, run, record, cfg: defaultConfig(), models: () => ({ model: unused as never, ref: "producer/builder" }),
    availableProviders: new Set(["producer", "other"]), modelsOn: () => ({ model: model as never, ref: "other/auditor" }),
    apiKeyFor: async () => "key", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(1),
  };
  const git = new ReviewGit(); const temps: string[] = [];
  const context: AuditorContext = {
    project, git, attempt: 1, builderRef: "producer/builder",
    makeTempDir: () => { const path = mkdtempSync(join(tmpdir(), "kiln-auditor-review-snapshot-")); temps.push(path); return path; },
  };
  const check: CheckResult = {
    checkId: "original", ok: true, kind: "shell", exitCode: 0, durationMs: 1, overrunMs: 0, timedOut: false,
    output: "ok", outputPath: join(project.checksDir, "original.txt"), outputTruncated: false,
  };
  return { home, run, record, project, model, deps, git, context, check, temps };
}

async function caught(run: Promise<unknown>): Promise<AuditorRunError> {
  try { await run; } catch (error) {
    expect(error).toBeInstanceOf(AuditorRunError);
    return error as AuditorRunError;
  }
  throw new Error("expected AuditorRunError");
}

function expectStage(error: AuditorRunError, stage: AuditorStage, message: string, cost = 0.1): void {
  expect(error.stage).toBe(stage);
  expect(error.message).toContain(message);
  expect(error.costUsd).toBe(cost);
  expect(error.crossProvider).toBe(true);
  expect(error.originalCause).toBeInstanceOf(Error);
  expect((error.originalCause as Error).message).toContain(message);
}

describe("auditor review boundaries", () => {
  test("an invalid audit result ends its run and exactly one outer retry may succeed", async () => {
    const s = setup([invalidAudit, audit()]);
    const ended: boolean[] = [];
    s.deps.onTool = (event) => { if (event.name === "audit" && event.phase === "end") ended.push(event.ok === true); };
    const result = await runAuditorSession(s.deps, FEATURE, s.check, s.context);
    expect(result).toMatchObject({ malformed: false, retried: true, effectiveVerdict: "agree", costUsd: 0.2 });
    expect(s.model.calls).toHaveLength(2);
    const schema = (s.model.calls[0]?.context.tools ?? []).find((tool: { name: string }) => tool.name === "audit")?.parameters as any;
    expect(schema.required).toEqual(["verified", "claimedUnverified", "regressions", "nextSessionNotes", "checkQuality", "verdict"]);
    expect(schema.properties.verified).toEqual({ type: "array", items: { type: "string" } });
    expect(schema.properties.checkQuality).toEqual({ type: "object", properties: { adequate: { type: "boolean" }, reason: { type: "string" } }, required: ["adequate", "reason"] });
    expect(schema.properties.verdict.enum).toEqual(["agree", "disagree"]);
    expect(s.record.read().filter((event) => event.t === "tool.call" && event.name === "audit").map((event) => event.t === "tool.call" && event.ok)).toEqual([false, true]);
    expect(ended).toEqual([false, true]);
  });

  test("three scripted audit calls can consume at most two and retain invalid tool outcomes", async () => {
    const s = setup([invalidAudit, invalidAudit, audit()]);
    const result = await runAuditorSession(s.deps, FEATURE, s.check, s.context);
    expect(result).toMatchObject({ rawVerdict: "disagree", effectiveVerdict: "agree", malformed: true, retried: true, evidenceUsable: false, costUsd: 0.2 });
    expect(s.model.calls).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "tool.call" && event.name === "audit").map((event) => event.t === "tool.call" && event.ok)).toEqual([false, false]);
  });

  test("read traversal remains possible but neither prompt nor tool construction supplies the record", async () => {
    const s = setup([]);
    s.record.append({ t: "note", text: "TRAVERSAL-RECORD-SECRET" });
    const call = s.model.calls;
    const responses = [
      { content: [{ type: "toolCall", name: "read", arguments: { path: s.run.record } }], usage: { input: 1, output: 0 } }, audit(),
    ];
    const model = createMockModel({ id: "traversal", provider: "other", handler: () => responses.shift(), cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } } as never);
    s.deps.modelsOn = () => ({ model: model as never, ref: "other/auditor" });
    await runAuditorSession(s.deps, FEATURE, s.check, s.context);
    const pinned = (model.calls[0]?.context.systemPrompt as string[]).at(-1) ?? "";
    expect(pinned).not.toContain(s.run.record);
    expect(pinned).not.toContain("TRAVERSAL-RECORD-SECRET");
    expect((model.calls[0]?.context.tools ?? []).map((tool: { name: string }) => tool.name)).toEqual(["read", "search", "git_log", "git_diff", "audit"]);
    expect(s.record.read().find((event) => event.t === "tool.call" && event.name === "read")?.t).toBe("tool.call");
    const read = s.record.read().find((event) => event.t === "tool.call" && event.name === "read");
    expect(read && read.t === "tool.call" ? read.excerpt : "").toContain("TRAVERSAL-RECORD-SECRET");
    expect(call).toHaveLength(0);
  });

  test("status, rebuild, and recheck failures after spend carry the stage and aggregate cost", async () => {
    const status = setup([audit()]); status.git.failMethod = "statusPorcelain";
    expectStage(await caught(runAuditorSession(status.deps, FEATURE, status.check, status.context)), "status", "statusPorcelain");

    const rebuild = setup([audit()]); rebuild.git.statuses = [" M visible.txt"]; rebuild.git.failMethod = "rebuildAuditSnapshot";
    expectStage(await caught(runAuditorSession(rebuild.deps, FEATURE, rebuild.check, rebuild.context)), "rebuild", "rebuildAuditSnapshot");

    const recheck = setup([audit()]); recheck.git.statuses = [" M visible.txt"];
    recheck.context.check = async () => { throw new Error("recheck primary"); };
    expectStage(await caught(runAuditorSession(recheck.deps, FEATURE, recheck.check, recheck.context)), "recheck", "recheck primary");
  });

  test("fresh-status, remove, and cleanup failures retain all spend", async () => {
    const freshStatus = setup([audit(), audit()]); freshStatus.git.statuses = [" M visible.txt", ""];
    const baseStatus = freshStatus.git.statusPorcelain.bind(freshStatus.git); let statuses = 0;
    freshStatus.git.statusPorcelain = async (dir) => { const value = await baseStatus(dir); statuses += 1; if (statuses === 2) throw new Error("fresh status failed"); return value; };
    freshStatus.context.check = async () => ({ ...freshStatus.check, checkId: "rebuilt" });
    expectStage(await caught(runAuditorSession(freshStatus.deps, FEATURE, freshStatus.check, freshStatus.context)), "fresh_status", "fresh status failed", 0.2);

    const remove = setup([audit()]); remove.git.failMethod = "removeAuditSnapshot";
    expectStage(await caught(runAuditorSession(remove.deps, FEATURE, remove.check, remove.context)), "remove", "removeAuditSnapshot");
    expect(remove.temps.every((path) => !existsSync(path))).toBe(true);

    const cleanup = setup([audit()]); cleanup.context.cleanup = () => { throw new Error("cleanup failed"); };
    expectStage(await caught(runAuditorSession(cleanup.deps, FEATURE, cleanup.check, cleanup.context)), "cleanup", "cleanup failed");
    cleanup.temps.forEach((path) => rmSync(path, { recursive: true, force: true }));
  });

  test("remove and cleanup failures never override a primary post-spend failure", async () => {
    const s = setup([audit()]); s.git.failMethod = "statusPorcelain";
    const baseRemove = s.git.removeAuditSnapshot.bind(s.git);
    s.git.removeAuditSnapshot = async (snapshot) => { s.git.failMethod = undefined; await baseRemove(snapshot); throw new Error("remove secondary"); };
    s.context.cleanup = () => { throw new Error("cleanup secondary"); };
    expectStage(await caught(runAuditorSession(s.deps, FEATURE, s.check, s.context)), "status", "statusPorcelain");
    s.temps.forEach((path) => rmSync(path, { recursive: true, force: true }));
  });
});
