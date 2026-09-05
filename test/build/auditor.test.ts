import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { pinAudit, appendAudit, AUDIT_CAPS_PINNED, AUDIT_CAPS_STORED, type Audit } from "../../src/build/audit-contract";
import { AuditorRunError, runAuditorSession, type AuditorContext } from "../../src/build/auditor";
import { RealGitRunner, type AuditSnapshot, type GitRunner } from "../../src/build/git";
import type { CheckResult, RunCheckOptions } from "../../src/build/verify";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { currentRunControl, RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { runProcess } from "../../src/core/process";
import type { Feature } from "../../src/formation/features";
import { projectPaths } from "../../src/formation/paths";
import { NoModelError } from "../../src/providers/models";
import type { PhaseDeps } from "../../src/phases/frame";
import { FakeGitRunner } from "./fake-git";

const SPEC = `# Spec\n\n## First milestone\nMILESTONE-ONLY\n`;
const FEATURE: Feature = { id: "f01", title: "Feature", description: "Build it", acceptance: { type: "shell", command: "printf ACCEPTANCE-SENTINEL" } };

const fullAudit = (patch: Record<string, unknown> = {}) => ({
  content: [{ type: "toolCall", name: "audit", arguments: {
    verified: ["verified"], claimedUnverified: [], regressions: [], nextSessionNotes: "next",
    checkQuality: { adequate: true, reason: "good" }, verdict: "agree", ...patch,
  } }],
});

const shortAudit = (patch: Record<string, unknown> = {}) => ({
  content: [{ type: "toolCall", name: "audit", arguments: { regressions: ["failed behavior"], nextSessionNotes: "repair it", ...patch } }],
});

const checkResult = (root: string, ok = true, checkId = "check-original"): CheckResult => ({
  checkId, ok, kind: "shell", exitCode: ok ? 0 : 1, durationMs: 5, overrunMs: 0, timedOut: false,
  output: ok ? "CHECK-OUTPUT-ONLY" : "CHECK-FAILED-ONLY", outputPath: join(root, `${checkId}.txt`), outputTruncated: false,
});

class MaterializingGit extends FakeGitRunner {
  statuses: string[] = [];
  override async createAuditSnapshot(dir: string, tempDir: string): Promise<AuditSnapshot> {
    const snapshot = await super.createAuditSnapshot(dir, tempDir);
    mkdirSync(snapshot.worktree, { recursive: true });
    writeFileSync(join(snapshot.worktree, "snapshot.txt"), "SNAPSHOT-ONLY\n");
    return snapshot;
  }
  override async statusPorcelain(dir: string): Promise<string> {
    await super.statusPorcelain(dir);
    return this.statuses.shift() ?? "";
  }
}

function setup(responses: unknown[], patch: Partial<PhaseDeps> = {}, modelPatch: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-auditor-")); initHome(home);
  const run = createRun(home, "seed"); const record = new RunRecord(run.record);
  const project = projectPaths(run.project);
  mkdirSync(project.repo, { recursive: true }); mkdirSync(project.checksDir, { recursive: true });
  writeFileSync(project.spec, SPEC); writeFileSync(project.progress, "PROGRESS-SECRET\n");
  const model = createMockModel({ id: "audit-model", provider: "other", responses: responses as never, ...modelPatch } as never);
  const unused = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
  const resolverCalls: unknown[] = [];
  const deps: PhaseDeps = {
    home, run, record, cfg: defaultConfig(), models: () => ({ model: unused as never, ref: "producer/builder" }),
    availableProviders: new Set(["producer", "other"]),
    modelsOn: (role, provider, exclude) => { resolverCalls.push({ role, provider, exclude }); return { model: model as never, ref: `${provider}/auditor` }; },
    apiKeyFor: async () => "key", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(1), ...patch,
  };
  const git = new MaterializingGit();
  const tempPaths: string[] = [];
  const context: AuditorContext = {
    project, git, attempt: 1, builderRef: "producer/builder", needs: [],
    makeTempDir: () => { const path = mkdtempSync(join(tmpdir(), "kiln-audit-snapshot-")); tempPaths.push(path); return path; },
    now: () => new Date("2026-09-04T00:00:00.000Z"),
  };
  return { home, run, record, project, model, resolverCalls, deps, git, context, tempPaths };
}

function priorAudit(s: ReturnType<typeof setup>): void {
  appendAudit(s.run, {
    featureId: "f00", attempt: 1, checkId: "prior", sourceEventSeq: 1, createdAt: "2026-09-03T00:00:00.000Z", shape: "full",
    raw: {
      verified: ["VERDICT-SECRET"], claimedUnverified: [], regressions: ["REGRESSION-SECRET"], nextSessionNotes: "PREVIOUS-NOTES-ONLY",
      checkQuality: { adequate: false, reason: "QUALITY-SECRET" }, verdict: "disagree",
    },
    model: { provider: "old", model: "old", ref: "old/auditor" },
  });
}

describe("runAuditorSession", () => {
  test("a resumed attempt charges recorded auditor calls before another dispatch", async () => {
    const s = setup([fullAudit()]);
    s.deps.cfg.build.auditorUsdCap = 0.2;
    s.record.append({ t: "feature.pick", featureId: FEATURE.id, attempt: s.context.attempt, phaseBudgetUsd: 10 });
    s.record.append({
      t: "model.call", role: "auditor", provider: "other", model: "audit-model", inputHash: "cancelled-audit",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.3, stopReason: "stop", excerpt: "",
    });
    s.record.append({
      t: "model.call", role: "builder", provider: "producer", model: "builder", inputHash: "unrelated",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 9, stopReason: "stop", excerpt: "",
    });
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(s.model.calls).toHaveLength(0);
    expect(result.costUsd).toBeCloseTo(0.3, 12);
    expect(result.truncated).toBe(true);
  });

  test("cleanup escapes ambient cancellation and preserves the primary cancellation", async () => {
    const s = setup([fullAudit()]);
    const control = new RunControl();
    const baseRemove = s.git.removeAuditSnapshot.bind(s.git);
    let cleanupRan = false;
    s.git.statusPorcelain = async () => {
      control.cancel("operator cancelled audit");
      throw control.signal.reason;
    };
    s.git.removeAuditSnapshot = async (snapshot) => {
      expect(currentRunControl()).not.toBe(control);
      expect(currentRunControl()?.signal.aborted).toBe(false);
      const process = await runProcess({ cmd: "sh", args: ["-c", "printf cleanup"], timeoutMs: 1_000 });
      expect(process.cancelled).toBe(false);
      expect(process.stdout).toBe("cleanup");
      cleanupRan = true;
      await baseRemove(snapshot);
    };
    let caught: unknown;
    try {
      await withRunControl(control, () => runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(control.signal.reason);
    expect(caught).toBeInstanceOf(RunCancelledError);
    expect(cleanupRan).toBe(true);
    expect(s.tempPaths.every((path) => !existsSync(path))).toBe(true);
  });

  test("uses exactly five read-only snapshot tools and supplies only the allowed context", async () => {
    let seen: any; const gitRuns: any[] = [];
    const scriptedResponses = [
      { content: [{ type: "toolCall", name: "read", arguments: { path: "snapshot.txt" } }] },
      { content: [{ type: "toolCall", name: "git_log", arguments: { n: 3 } }] },
      { content: [{ type: "toolCall", name: "git_diff", arguments: { ref: "HEAD^", path: "semi;$(safe).ts" } }] },
      fullAudit(),
    ];
    const s = setup([]);
    const scripted = createMockModel({ id: "audit-model", provider: "other", handler: (ctx: unknown) => { seen = ctx; return scriptedResponses.shift(); } } as never);
    s.deps.modelsOn = () => ({ model: scripted as never, ref: "other/auditor" });
    s.context.gitRun = async (options) => { gitRuns.push(options); return { exitCode: 0, signal: null, stdout: "log", stderr: "", timedOut: false, durationMs: 1, overrunMs: 0, truncated: false }; };
    priorAudit(s); s.record.append({ t: "note", text: "RECORD-SECRET" });
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    const toolNames = (seen.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(["read", "search", "git_log", "git_diff", "audit"]);
    for (const forbidden of ["bash", "write", "edit", "note", "exit"]) expect(toolNames).not.toContain(forbidden);
    const pinned = (seen.systemPrompt as string[]).at(-1) ?? "";
    for (const allowed of ["ACCEPTANCE-SENTINEL", "CHECK-OUTPUT-ONLY", "check-original.txt", "MILESTONE-ONLY", "PREVIOUS-NOTES-ONLY"]) expect(pinned).toContain(allowed);
    for (const hidden of ["PROGRESS-SECRET", "RECORD-SECRET", "VERDICT-SECRET", "REGRESSION-SECRET", "QUALITY-SECRET"]) expect(pinned).not.toContain(hidden);
    const readEvent = s.record.read().find((event) => event.t === "tool.call" && event.name === "read");
    expect(readEvent?.t).toBe("tool.call");
    expect(readEvent && readEvent.t === "tool.call" ? readEvent.excerpt : "").toContain("SNAPSHOT-ONLY");
    const snapshotDir = s.git.calls.find((call) => call.method === "createAuditSnapshot")?.tempDir + "/worktree";
    expect(gitRuns[0]?.cwd).toBe(snapshotDir);
    expect(s.git.calls.filter((call) => call.method === "diff").map((call) => call.method === "diff" ? call.dir : "")).toEqual([snapshotDir, snapshotDir]);
    expect(s.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);
    expect(result).toMatchObject({ rawVerdict: "agree", effectiveVerdict: "agree", evidenceUsable: true, crossProvider: true, recoveredFromVoid: false, finalCheckVoided: false, checkVoided: false });
    expect(s.tempPaths.every((path) => !existsSync(path))).toBe(true);
  });

  test("prefers another provider, falls back to a distinct same-provider ref, and never accepts the producer", async () => {
    const other = setup([fullAudit()]);
    expect((await runAuditorSession(other.deps, FEATURE, checkResult(other.project.checksDir), other.context)).crossProvider).toBe(true);
    expect(other.resolverCalls).toEqual([{ role: "auditor", provider: "other", exclude: undefined }]);

    const same = setup([fullAudit()]); const calls: unknown[] = [];
    same.deps.availableProviders = new Set(["producer"]);
    same.deps.modelsOn = (role, provider, exclude) => { calls.push({ role, provider, exclude }); return { model: same.model as never, ref: "producer/auditor" }; };
    expect((await runAuditorSession(same.deps, FEATURE, checkResult(same.project.checksDir), same.context)).crossProvider).toBe(false);
    expect(calls).toEqual([{ role: "auditor", provider: "producer", exclude: "producer/builder" }]);

    const bad = setup([fullAudit()]); bad.deps.availableProviders = new Set(["producer"]);
    bad.deps.modelsOn = () => ({ model: bad.model as never, ref: "producer/builder" });
    await expect(runAuditorSession(bad.deps, FEATURE, checkResult(bad.project.checksDir), bad.context)).rejects.toBeInstanceOf(NoModelError);
    expect(bad.git.calls).toHaveLength(0);
  });

  test("retries one missing audit, sums both calls, and persists linked audit records", async () => {
    const s = setup([
      { content: ["forgot the tool"], usage: { input: 1, output: 0 } },
      { ...fullAudit(), usage: { input: 1, output: 0 } },
    ], {}, { cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(result).toMatchObject({ retried: true, malformed: false, truncated: false, costUsd: 0.2 });
    const event = s.record.read().find((value) => value.t === "audit");
    const disposition = s.record.read().find((value) => value.t === "audit.disposition");
    expect(event).toMatchObject({ checkId: "check-original", costUsd: 0.2, crossProvider: true });
    expect(disposition).toMatchObject({ checkId: "check-original", retried: true, evidenceUsable: true, checkVoided: false });
    expect(event?.t).toBe("audit");
    if (!event || event.t !== "audit") throw new Error("missing audit event");
    expect(result.audit.sourceEventSeq).toBe(event.seq);
    expect(readFileSync(s.run.audits, "utf8")).toContain('"checkId":"check-original"');
    expect(readFileSync(s.project.audit, "utf8")).toContain("# Audit f01 attempt 1");
  });

  test("keeps malformed, truncated, empty-disagree, and genuine-disagree dispositions distinct", async () => {
    const malformed = setup([{ content: ["none"] }, { content: ["still none"] }]);
    expect(await runAuditorSession(malformed.deps, FEATURE, checkResult(malformed.project.checksDir), malformed.context)).toMatchObject({
      rawVerdict: "agree", effectiveVerdict: "agree", malformed: true, truncated: false, retried: true, evidenceUsable: false,
    });

    const truncated = setup([
      { content: [{ type: "toolCall", name: "read", arguments: { path: "snapshot.txt" } }], usage: { input: 1, output: 0 } },
      fullAudit(),
    ], {}, { cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    truncated.deps.cfg.build.auditorUsdCap = 0.05;
    expect(await runAuditorSession(truncated.deps, FEATURE, checkResult(truncated.project.checksDir), truncated.context)).toMatchObject({
      effectiveVerdict: "agree", malformed: false, truncated: true, retried: false, evidenceUsable: false, costUsd: 0.1,
    });
    expect(truncated.model.calls).toHaveLength(1);
    expect(truncated.record.read().find((event) => event.t === "audit")).toMatchObject({ costUsd: 0.1, usdCapHit: true, truncated: true });
    expect(truncated.record.read().find((event) => event.t === "audit.disposition")).toMatchObject({ evidenceUsable: false, checkVoided: false });

    const empty = setup([fullAudit({ verdict: "disagree", claimedUnverified: [], regressions: [] })]);
    expect(await runAuditorSession(empty.deps, FEATURE, checkResult(empty.project.checksDir), empty.context)).toMatchObject({
      rawVerdict: "disagree", effectiveVerdict: "agree", evidenceUsable: true,
    });
    expect(empty.record.read().find((value) => value.t === "audit.disposition")).toMatchObject({ emptyDisagree: true, malformed: false });

    const genuine = setup([fullAudit({ verdict: "disagree", claimedUnverified: ["not observed"] })]);
    expect(await runAuditorSession(genuine.deps, FEATURE, checkResult(genuine.project.checksDir), genuine.context)).toMatchObject({
      rawVerdict: "disagree", effectiveVerdict: "disagree", evidenceUsable: true,
    });
  });

  test("treats a refusal as malformed agree evidence with a category-named note and no retry", async () => {
    const s = setup([{ stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" } }]);
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(result).toMatchObject({ rawVerdict: "agree", effectiveVerdict: "agree", malformed: true, retried: false, evidenceUsable: false });
    expect(result.audit.raw.nextSessionNotes).toBe("Auditor evidence unusable: auditor refused: safety");
    expect(result.audit.raw.checkQuality).toEqual({ adequate: false, reason: "auditor refused: safety" });
    expect(s.model.calls).toHaveLength(1);
    expect(s.record.read().find((event) => event.t === "audit.disposition")).toMatchObject({
      rawVerdict: "agree", effectiveVerdict: "agree", malformed: true, retried: false, evidenceUsable: false,
    });
  });

  test("uses the short failed-check schema and fills every full Audit field explicitly", async () => {
    let seen: any;
    const model = createMockModel({ id: "short", provider: "other", handler: (ctx: any) => { seen = ctx; return shortAudit(); } } as never);
    const s = setup([]); s.deps.modelsOn = () => ({ model: model as never, ref: "other/auditor" });
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir, false), s.context);
    const schema = (seen.tools as any[]).find((tool) => tool.name === "audit")?.parameters;
    expect(Object.keys(schema.properties)).toEqual(["regressions", "nextSessionNotes"]);
    expect(schema.required).toEqual(["regressions", "nextSessionNotes"]);
    expect(schema.properties.regressions).toEqual({ type: "array", items: { type: "string" } });
    expect(schema.properties.verdict).toBeUndefined();
    expect(result.audit).toMatchObject({ shape: "short", raw: {
      verified: [], claimedUnverified: [], regressions: ["failed behavior"], nextSessionNotes: "repair it",
      checkQuality: { adequate: false }, verdict: "agree",
    } });
  });

  test("stores large audits at stored caps, pins purely at pinned caps, and marks lost evidence", async () => {
    const item = "x".repeat(300); const notes = "n".repeat(1_500); const reason = "q".repeat(300);
    const s = setup([fullAudit({
      verified: Array(10).fill(item), claimedUnverified: Array(10).fill(item), regressions: Array(10).fill(item),
      nextSessionNotes: notes, checkQuality: { adequate: false, reason }, verdict: "disagree",
    })]);
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(result).toMatchObject({ rawVerdict: "disagree", effectiveVerdict: "agree", truncated: true, evidenceUsable: false });
    expect(result.audit.raw.verified).toHaveLength(AUDIT_CAPS_STORED.items);
    expect(result.audit.raw.verified[0]).toHaveLength(AUDIT_CAPS_STORED.itemChars);
    expect(result.audit.raw.nextSessionNotes).toHaveLength(AUDIT_CAPS_STORED.notesChars);
    const pinned = pinAudit(result.audit);
    expect(pinned.raw.verified).toHaveLength(AUDIT_CAPS_PINNED.items);
    expect(pinned.raw.verified[0]).toHaveLength(AUDIT_CAPS_PINNED.itemChars);
    expect(pinned.raw.nextSessionNotes).toHaveLength(AUDIT_CAPS_PINNED.notesChars);
  });

  test("voids a mutated snapshot, rebuilds the same snapshot, rechecks there, and freshly audits", async () => {
    const s = setup([
      { ...fullAudit({ verified: ["first"] }), usage: { input: 1, output: 0 } },
      { ...fullAudit({ verified: ["fresh"] }), usage: { input: 1, output: 0 } },
    ], {}, { cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    s.git.statuses = [" M snapshot.txt\n"];
    let recheckOptions: RunCheckOptions | undefined;
    s.context.check = async (_acceptance, options) => {
      recheckOptions = options;
      const result = checkResult(s.project.checksDir, true, "check-rebuilt");
      options.record.append({ t: "check", ...result, featureId: FEATURE.id, attempt: 1, phase: "acceptance", outputPath: result.outputPath, outputTruncated: false });
      return result;
    };
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    const snapshot = s.git.calls.find((call) => call.method === "createAuditSnapshot");
    expect(recheckOptions?.cwd).toBe(snapshot && snapshot.method === "createAuditSnapshot" ? `${snapshot.tempDir}/worktree` : "missing");
    expect(result).toMatchObject({ recoveredFromVoid: true, finalCheckVoided: false, checkVoided: false, check: { checkId: "check-rebuilt", ok: true }, audit: { checkId: "check-rebuilt" }, costUsd: 0.2 });
    expect(s.model.calls).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "audit")).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "audit.disposition").map((event) => event.t === "audit.disposition" && event.checkVoided)).toEqual([true, false]);
    expect(s.git.calls.filter((call) => call.method === "rebuildAuditSnapshot")).toHaveLength(1);
    expect(s.git.calls.filter((call) => call.method === "removeAuditSnapshot")).toHaveLength(1);
    expect(s.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);
    expect(s.record.read().some((event) => event.t === "failure" && event.class === "policy")).toBe(true);
  });

  test("writes a fresh short audit when the rebuilt-snapshot check fails", async () => {
    const s = setup([fullAudit(), shortAudit()]); s.git.statuses = ["?? changed\n", ""];
    s.context.check = async () => checkResult(s.project.checksDir, false, "check-rebuilt-failed");
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(result).toMatchObject({ recoveredFromVoid: true, finalCheckVoided: false, checkVoided: false, check: { ok: false, checkId: "check-rebuilt-failed" }, audit: { checkId: "check-rebuilt-failed", shape: "short" } });
    expect(s.model.calls).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "audit.disposition").map((event) => event.t === "audit.disposition" && event.checkVoided)).toEqual([true, false]);
  });

  test("voids and downgrades a fresh audit that mutates the rebuilt snapshot again", async () => {
    const s = setup([
      { ...fullAudit({ verified: ["first"] }), usage: { input: 1, output: 0 } },
      { ...fullAudit({ verdict: "disagree", claimedUnverified: ["fresh but mutating"] }), usage: { input: 1, output: 0 } },
    ], {}, { cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    s.git.statuses = [" M first", " M second"];
    s.context.check = async () => checkResult(s.project.checksDir, true, "check-rebuilt-twice");
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(result).toMatchObject({ rawVerdict: "disagree", effectiveVerdict: "agree", evidenceUsable: false, recoveredFromVoid: true, finalCheckVoided: true, checkVoided: true, costUsd: 0.2 });
    expect(s.record.read().filter((event) => event.t === "audit.disposition").map((event) => event.t === "audit.disposition" && event.checkVoided)).toEqual([true, true]);
    expect(s.record.read().filter((event) => event.t === "failure" && event.class === "policy")).toHaveLength(2);
    expect(s.git.calls.filter((call) => call.method === "rebuildAuditSnapshot")).toHaveLength(1);
    expect(s.git.calls.filter((call) => call.method === "removeAuditSnapshot")).toHaveLength(1);
  });

  test("audits Task 4's exact real snapshot without changing producer bytes, status, or index", async () => {
    const odd = "untracked;$(opaque).txt";
    const responses = [
      { content: [{ type: "toolCall", name: "read", arguments: { path: odd } }] },
      { content: [{ type: "toolCall", name: "git_diff", arguments: { ref: "HEAD^", path: odd } }] },
      fullAudit({ verified: ["exact snapshot"] }),
    ];
    const s = setup([]);
    const model = createMockModel({ id: "real-auditor", provider: "other", responses: responses as never });
    s.deps.modelsOn = () => ({ model: model as never, ref: "other/auditor" });
    const real = new RealGitRunner();
    await real.init(s.project.repo);
    writeFileSync(join(s.project.repo, "binary.dat"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(s.project.repo, "mode.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(s.project.repo, "deleted.txt"), "delete me\n");
    await real.commit(s.project.repo, { message: "base" });
    const expectedBytes = Buffer.from([0, 9, 8, 255, 10]);
    writeFileSync(join(s.project.repo, "binary.dat"), expectedBytes);
    writeFileSync(join(s.project.repo, ".gitignore"), `${readFileSync(join(s.project.repo, ".gitignore"), "utf8")}ignored.exact\n`);
    writeFileSync(join(s.project.repo, "ignored.exact"), "IGNORED-SNAPSHOT-ONLY\n");
    chmodSync(join(s.project.repo, "mode.sh"), 0o755);
    rmSync(join(s.project.repo, "deleted.txt"));
    writeFileSync(join(s.project.repo, odd), "UNTRACKED-SNAPSHOT-ONLY\n");
    symlinkSync("binary.dat", join(s.project.repo, "binary-link"));
    const statusBefore = await real.statusPorcelain(s.project.repo);
    const indexBefore = Bun.spawnSync(["git", "ls-files", "--stage"], { cwd: s.project.repo }).stdout.toString();
    let inspected = false; let producerCleaned = false;
    const git: GitRunner = {
      init: (dir) => real.init(dir), commit: (dir, options) => real.commit(dir, options), log: (dir, options) => real.log(dir, options),
      diff: (dir, options) => real.diff(dir, options), revParseHead: (dir) => real.revParseHead(dir),
      revert: (dir, sha, options) => real.revert(dir, sha, options),
      checkoutAndClean: async () => { producerCleaned = true; },
      createAuditSnapshot: (dir, tempDir) => real.createAuditSnapshot(dir, tempDir),
      rebuildAuditSnapshot: (snapshot) => real.rebuildAuditSnapshot(snapshot),
      removeAuditSnapshot: (snapshot) => real.removeAuditSnapshot(snapshot),
      hasTrailer: (dir, key, value) => real.hasTrailer(dir, key, value),
      statusPorcelain: async (dir) => {
        if (dir !== s.project.repo) {
          expect(readFileSync(join(dir, "binary.dat"))).toEqual(expectedBytes);
          expect(lstatSync(join(dir, "mode.sh")).mode & 0o111).not.toBe(0);
          expect(existsSync(join(dir, "deleted.txt"))).toBe(false);
          expect(readlinkSync(join(dir, "binary-link"))).toBe("binary.dat");
          expect(readFileSync(join(dir, odd), "utf8")).toBe("UNTRACKED-SNAPSHOT-ONLY\n");
          expect(readFileSync(join(dir, "ignored.exact"), "utf8")).toBe("IGNORED-SNAPSHOT-ONLY\n");
          inspected = true;
        }
        return real.statusPorcelain(dir);
      },
    };
    s.context.git = git;
    const result = await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context);
    expect(result.effectiveVerdict).toBe("agree");
    expect(inspected).toBe(true);
    expect(producerCleaned).toBe(false);
    expect(readFileSync(join(s.project.repo, "binary.dat"))).toEqual(expectedBytes);
    expect(await real.statusPorcelain(s.project.repo)).toBe(statusBefore);
    expect(Bun.spawnSync(["git", "ls-files", "--stage"], { cwd: s.project.repo }).stdout.toString()).toBe(indexBefore);
    expect(s.record.read().find((event) => event.t === "tool.call" && event.name === "read" && event.excerpt.includes("UNTRACKED-SNAPSHOT-ONLY"))).toBeDefined();
  });

  test("removes the detached snapshot after model, status, and recovery-check errors", async () => {
    const modelError = setup([{ throw: "provider failed" }]);
    await expect(runAuditorSession(modelError.deps, FEATURE, checkResult(modelError.project.checksDir), modelError.context)).rejects.toBeInstanceOf(AuditorRunError);
    expect(modelError.git.calls.filter((call) => call.method === "removeAuditSnapshot")).toHaveLength(1);

    const statusError = setup([fullAudit()]); statusError.git.failMethod = "statusPorcelain";
    await expect(runAuditorSession(statusError.deps, FEATURE, checkResult(statusError.project.checksDir), statusError.context)).rejects.toThrow("statusPorcelain");
    expect(statusError.git.calls.filter((call) => call.method === "removeAuditSnapshot")).toHaveLength(1);

    const checkError = setup([fullAudit()]); checkError.git.statuses = [" M snapshot.txt"];
    checkError.context.check = async () => { throw new Error("recheck failed"); };
    await expect(runAuditorSession(checkError.deps, FEATURE, checkResult(checkError.project.checksDir), checkError.context)).rejects.toThrow("recheck failed");
    expect(checkError.git.calls.filter((call) => call.method === "removeAuditSnapshot")).toHaveLength(1);
    for (const s of [modelError, statusError, checkError]) expect(s.tempPaths.every((path) => !existsSync(path))).toBe(true);
  });

  test("a second-call model error carries all prior auditor spend for attempt accounting", async () => {
    const s = setup([
      { content: ["missing audit"], usage: { input: 1, output: 0 } },
      { throw: "second call failed" },
    ], {}, { cost: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    let thrown: unknown;
    try { await runAuditorSession(s.deps, FEATURE, checkResult(s.project.checksDir), s.context); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AuditorRunError);
    expect((thrown as AuditorRunError).costUsd).toBe(0.1);
    expect((thrown as AuditorRunError).crossProvider).toBe(true);
    expect((thrown as AuditorRunError).stage).toBe("audit");
    expect((thrown as AuditorRunError).message).toContain("second call failed");
    expect((thrown as AuditorRunError).originalCause).toBe((thrown as AuditorRunError).result);
    expect(s.git.calls.filter((call) => call.method === "removeAuditSnapshot")).toHaveLength(1);
  });
});
