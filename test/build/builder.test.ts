import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import type { Feature } from "../../src/formation/features";
import { projectPaths } from "../../src/formation/paths";
import type { PhaseDeps } from "../../src/phases/frame";
import { buildContract, buildContractDetailed, BUILDER_CONTRACT_CHARS, BUILDER_PINNED_CHARS, createBuilderDriver, runBuilderSession } from "../../src/build/builder";
import type { Audit } from "../../src/build/audit-contract";
import { parseProgress, renderProgressEntry, type ProgressEntry } from "../../src/build/progress";
import { FakeGitRunner } from "./fake-git";

const shellFeature = (id = "f01", command = "printf ok"): Feature => ({ id, title: `Feature ${id}`, description: "Deliver one visible result.", acceptance: { type: "shell", command } });

function setup(model: unknown) {
  const home = mkdtempSync(join(tmpdir(), "kiln-builder-"));
  initHome(home);
  const run = createRun(home, "seed");
  const project = projectPaths(run.project);
  mkdirSync(project.repo, { recursive: true });
  const record = new RunRecord(run.record);
  const git = new FakeGitRunner();
  const deps: PhaseDeps = {
    home, run, record, cfg: defaultConfig(), models: () => ({ model: model as never, ref: "mock/builder" }),
    apiKeyFor: async () => "key", effort: "medium", streamFn: streamMock as never, limiter: new Limiter(1),
  };
  return { home, run, project, record, git, deps, model: model as any };
}

function audit(): Audit {
  const items = Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(220)}`);
  return {
    featureId: "f01", attempt: 1, checkId: "check-old", sourceEventSeq: 10, createdAt: "2026-09-04T00:00:00.000Z", shape: "full",
    raw: { verified: items, claimedUnverified: items, regressions: items, nextSessionNotes: "n".repeat(1_400), checkQuality: { adequate: false, reason: "q".repeat(220) }, verdict: "disagree" },
    model: { provider: "mock", model: "auditor", ref: "mock/auditor" },
  };
}

function progress(featureId: string, attempt: number, checkId: string): ProgressEntry {
  const text = renderProgressEntry({
    featureId, attempt, iso: `2026-09-04T00:00:0${attempt}.000Z`,
    check: { checkId, ok: false, kind: "shell", exitCode: 1, durationMs: 10, excerpt: checkId + "-" + "z".repeat(1_000) },
    audit: { rawVerdict: "agree", effectiveVerdict: "agree", evidenceUsable: true }, commit: { error: "failed" },
  });
  return parseProgress(text)[0]!;
}

describe("builder contract", () => {
  test("honors the 8000-character allocations and drops oldest progress first", () => {
    const model = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
    const { project } = setup(model);
    const entries = [progress("f01", 1, "oldest-p1"), progress("f01", 2, "p2"), progress("f02", 1, "p3"), progress("f03", 1, "p4"), progress("f04", 1, "newest-p5")];
    const context = { attempt: 3, remainingUsd: 0.5, remainingTurns: 7, audit: audit(), progress: entries };
    const built = buildContractDetailed(project, shellFeature(), context);
    expect(built.text.length).toBeLessThanOrEqual(BUILDER_PINNED_CHARS);
    expect(built.pinnedTruncated).toBe(true);
    expect(built.text).toContain("shell command: printf ok");
    expect(built.text).toContain("the harness runs this check after your session and the harness's run is the only one that counts");
    expect(built.text).toContain("cannot_be_satisfied");
    expect(built.text).toContain(".kiln-scratch/");
    expect(built.text).toContain("newest-p5");
    expect(built.text).not.toContain("oldest-p1");
    expect(built.text).not.toContain("record.jsonl");
    expect(built.text).not.toContain("/prompts/");
    expect(built.text).not.toContain("/evals/");
    expect(built.text).not.toContain("transcript");
    expect(buildContract(project, shellFeature(), context)).toBe(built.text);
  });

  test("long variable fields cannot displace the exact acceptance contract", () => {
    const project = projectPaths(join("/tmp", "p".repeat(5_000)));
    const feature: Feature = {
      id: "f".repeat(1_000), title: "title ".repeat(1_000), description: "description ".repeat(2_000),
      acceptance: { type: "shell", command: "printf exact-acceptance-check" },
    };
    const built = buildContractDetailed(project, feature, { attempt: 1, remainingUsd: 1, remainingTurns: 40 });
    expect(built.text.length).toBeLessThanOrEqual(BUILDER_PINNED_CHARS);
    expect(built.pinnedTruncated).toBe(true);
    expect(built.text).toContain("shell command: printf exact-acceptance-check");
    expect(built.text).toContain("the harness runs this check after your session and the harness's run is the only one that counts");
    expect(built.text).toContain("The frozen plan is not yours to write.");
    expect(built.text).toContain("cannot_be_satisfied");
  });

  test("an oracle too large for the contract is refused instead of truncated", () => {
    const project = projectPaths("/tmp/project");
    const fittingOracle = "k".repeat(1_700);
    const fitting = shellFeature("f01", fittingOracle);
    fitting.description = "description ".repeat(1_000);
    const built = buildContractDetailed(project, fitting, { attempt: 1, remainingUsd: 1, remainingTurns: 40 });
    expect(built.text).toContain(`shell command: ${fittingOracle}`);
    expect(built.text).toContain("the harness runs this check after your session and the harness's run is the only one that counts");
    expect(built.text).toContain("The frozen plan is not yours to write.");
    expect(built.text).toContain("cannot_be_satisfied");
    expect(built.text).toContain("Remaining budget: $1.0000.");
    expect(built.text).not.toContain("40 turns");
    expect(built.pinnedTruncated).toBe(true);
    const command = shellFeature("f01", "x".repeat(3_000));
    const nearLimit = shellFeature("f01", "n".repeat(2_100));
    const predicate = shellFeature("f01", "printf ok");
    predicate.acceptance = { type: "shell", command: "printf ok", expect: { type: "regex", value: "p".repeat(3_000) } };
    for (const feature of [command, nearLimit, predicate]) {
      expect(() => buildContractDetailed(project, feature, { attempt: 1, remainingUsd: 1, remainingTurns: 40 })).toThrow("acceptance contract exceeds 2500");
    }
  });

  test("a one-character description allowance cannot overflow its contract segment", () => {
    const project = projectPaths("/tmp/project");
    const feature = shellFeature("f01", "c".repeat(2_021));
    feature.description = "description that must be truncated";
    const built = buildContractDetailed(project, feature, { attempt: 1, remainingUsd: 1, remainingTurns: 40 });
    const auditOffset = built.text.indexOf("## Latest audit");
    expect(auditOffset).toBeGreaterThan(0);
    expect(built.text.slice(0, auditOffset).length).toBeLessThanOrEqual(BUILDER_CONTRACT_CHARS);
    expect(auditOffset).toBeLessThanOrEqual(BUILDER_CONTRACT_CHARS);
    expect(built.text).toContain(`shell command: ${feature.acceptance.type === "shell" ? feature.acceptance.command : ""}`);
    expect(built.pinnedTruncated).toBe(true);
  });
});

describe("runBuilderSession", () => {
  test("uses six tools, observes the real bash args locally, and writes only inside the repo", async () => {
    const model = Object.assign(createMockModel({ id: "builder", responses: [
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "printf    ok" } }] },
      { content: [{ type: "toolCall", name: "write", arguments: { path: "result.txt", content: "done\n" } }] },
      { content: ["done"] },
    ] as never }), { thinking: { mode: "effort" as const, efforts: ["low", "medium", "high"] as const } });
    const s = setup(model);
    const result = await runBuilderSession(s.deps, shellFeature(), { project: s.project, git: s.git, attempt: 1 });
    expect(result).toMatchObject({ stopped: "done", selfVerified: true, headMoved: false, contextPressure: false });
    expect(existsSync(join(s.project.repo, "result.txt"))).toBe(true);
    expect(s.model.calls[0]!.context.tools.map((tool: { name: string }) => tool.name)).toEqual(["read", "write", "edit", "bash", "search", "exit"]);
    const system = (s.model.calls[0]!.context.systemPrompt as string[]).join("\n");
    expect(system).toContain("B1");
    expect(system).not.toContain("Remaining budget:");
    const messages = JSON.stringify(s.model.calls[0]!.context.messages);
    expect(messages).toContain("Remaining budget: $1.2560.");
    expect(messages).not.toContain("40 turns");
    expect(s.record.read().find((event) => event.t === "model.call")).toMatchObject({ role: "builder", effort: "high" });
    expect(s.record.read().some((event) => event.t === "attempt")).toBe(false);
  });

  test("allows only cannot_be_satisfied and returns its concrete reasons", async () => {
    const model = createMockModel({ id: "builder-exit", responses: [
      { content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["wrong"] } }] },
      { content: [{ type: "toolCall", name: "exit", arguments: { kind: "cannot_be_satisfied", reasons: ["dependency cannot exist"] } }] },
    ] as never });
    const s = setup(model);
    const result = await runBuilderSession(s.deps, shellFeature(), { project: s.project, git: s.git, attempt: 2 });
    expect(result).toMatchObject({ stopped: "exit", exitReasons: ["dependency cannot exist"] });
    expect(s.record.read().filter((event) => event.t === "honest_exit")).toHaveLength(1);
    expect(s.record.read().some((event) => event.t === "failure" && event.class === "policy")).toBe(true);
  });

  test("the third identical tool result stalls before another model call", async () => {
    const model = createMockModel({ id: "builder-stall", handler: () => ({ content: [{ type: "toolCall", name: "read", arguments: { path: "same.txt" } }] }) } as never);
    const s = setup(model);
    writeFileSync(join(s.project.repo, "same.txt"), "same\n");
    const result = await runBuilderSession(s.deps, shellFeature(), { project: s.project, git: s.git, attempt: 3 });
    expect(result.stalled).toMatchObject({ tool: "read", fingerprint: expect.any(String) });
    expect(s.model.calls).toHaveLength(3);
    expect(s.record.read().filter((event) => event.t === "stall")).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "model.call")).toHaveLength(3);
  });

  test("reports moved HEAD, provider errors, and context pressure as raw facts", async () => {
    const git = new FakeGitRunner();
    const model = createMockModel({ id: "pressed", contextWindow: 100, handler: () => { git.head = "1".repeat(40); return { content: ["done"], usage: { input: 80, output: 1 } }; } } as never);
    const s = setup(model); s.git.head = git.head;
    const moved = createBuilderDriver(s.deps, { project: s.project, git, turnCap: 40, usdCap: 10 });
    expect(await moved.runFeature(shellFeature(), { attempt: 1 })).toMatchObject({ headMoved: true, contextPressure: true, stopped: "done" });

    const failing = setup(createMockModel({ id: "failing", handler: () => ({ throw: "provider failed", responseStatus: 503, responseHeaders: { "x-test": "1" }, responseRequestId: "req-builder" }) } as never));
    const error = await runBuilderSession(failing.deps, shellFeature(), { project: failing.project, git: failing.git, attempt: 1 });
    expect(error).toMatchObject({ stopped: "error", error: "provider failed", errorStatus: 503 });
  });

  test("returns turn-boundary turn and dollar cap stops from a fresh attempt", async () => {
    const turnModel = createMockModel({ id: "fresh-turn", responses: [
      { content: [{ type: "toolCall", name: "read", arguments: { path: "same.txt" } }] }, { content: ["late"] },
    ] as never });
    const turn = setup(turnModel); writeFileSync(join(turn.project.repo, "same.txt"), "same\n");
    expect(await runBuilderSession(turn.deps, shellFeature(), { project: turn.project, git: turn.git, attempt: 1, turnCap: 1 })).toMatchObject({ stopped: "turn_cap" });

    const usdModel = createMockModel({ id: "fresh-usd", cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, responses: [
      { content: [{ type: "toolCall", name: "read", arguments: { path: "same.txt" } }], usage: { input: 1, output: 0 } }, { content: ["late"] },
    ] as never });
    const usd = setup(usdModel); writeFileSync(join(usd.project.repo, "same.txt"), "same\n");
    expect(await runBuilderSession(usd.deps, shellFeature(), { project: usd.project, git: usd.git, attempt: 1, usdCap: 0.5 })).toMatchObject({ stopped: "usd_cap", costUsd: 1 });
  });

  test("omission is not a sandbox: an explicit traversal can still read the record", async () => {
    let sawSentinel = false;
    const model = createMockModel({ id: "traversal", handler: (context: any) => {
      const text = JSON.stringify(context.messages);
      if (text.includes("builder traversal sentinel")) { sawSentinel = true; return { content: ["done"] }; }
      return { content: [{ type: "toolCall", name: "read", arguments: { path: "../../record.jsonl" } }] };
    } } as never);
    const s = setup(model);
    s.record.append({ t: "note", text: "builder traversal sentinel" });
    await runBuilderSession(s.deps, shellFeature(), { project: s.project, git: s.git, attempt: 1 });
    expect(sawSentinel).toBe(true);
  });
});

describe("persistent builder driver", () => {
  test("reuses one brain with a frozen system prompt and appended feature contracts", async () => {
    const model = createMockModel({ id: "persistent", responses: [{ content: ["first"] }, { content: ["second"] }] as never });
    const s = setup(model);
    const driver = createBuilderDriver(s.deps, { project: s.project, git: s.git, turnCap: 10, usdCap: 10 });
    await driver.runFeature(shellFeature("f01"), { attempt: 1 });
    await driver.runFeature(shellFeature("f02"), { attempt: 1 });
    expect(s.model.calls).toHaveLength(2);
    expect(s.model.calls[1]!.context.systemPrompt).toEqual(s.model.calls[0]!.context.systemPrompt);
    expect(JSON.stringify(s.model.calls[0]!.context.messages)).toContain("Feature: f01");
    expect(JSON.stringify(s.model.calls[1]!.context.messages)).toContain("Feature: f02");
    expect(JSON.stringify(s.model.calls[1]!.context.messages)).toContain("first");
    expect(s.model.calls[0]!.context.messages.map((message: { role: string }) => message.role)).toEqual(["user", "developer"]);
    expect(driver.turns).toBe(2);
  });

  test("enforces aggregate turn and dollar caps across prompts", async () => {
    const turnModel = createMockModel({ id: "turns", responses: [{ content: ["first"] }, { content: ["second"] }] as never });
    const turns = setup(turnModel);
    const turnDriver = createBuilderDriver(turns.deps, { project: turns.project, git: turns.git, turnCap: 1, usdCap: 10 });
    expect((await turnDriver.runFeature(shellFeature("f01"), { attempt: 1 })).stopped).toBe("done");
    expect((await turnDriver.runFeature(shellFeature("f02"), { attempt: 1 })).stopped).toBe("turn_cap");
    expect(turns.model.calls).toHaveLength(1);
    expect(turns.record.read().filter((event) => event.t === "model.call")).toHaveLength(1);

    const usdModel = createMockModel({ id: "dollars", cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, responses: [
      { content: ["first"], usage: { input: 1, output: 0 } }, { content: ["second"] },
    ] as never });
    const dollars = setup(usdModel);
    const usdDriver = createBuilderDriver(dollars.deps, { project: dollars.project, git: dollars.git, turnCap: 10, usdCap: 0.5 });
    expect((await usdDriver.runFeature(shellFeature("f01"), { attempt: 1 })).costUsd).toBeGreaterThan(0.5);
    expect((await usdDriver.runFeature(shellFeature("f02"), { attempt: 1 })).stopped).toBe("usd_cap");
    expect(dollars.model.calls).toHaveLength(1);
    expect(dollars.record.read().filter((event) => event.t === "model.call")).toHaveLength(1);
  });

  test("a partially consumed aggregate turn budget stops on the exact remaining turn", async () => {
    let call = 0;
    const model = createMockModel({ id: "partial-turns", handler: () => {
      const current = call++;
      if (current === 29) return { content: ["first feature done"] };
      return { content: [{ type: "toolCall", name: "read", arguments: { path: "lines.txt", offset: current + 1, limit: 1 } }] };
    } } as never);
    const s = setup(model);
    writeFileSync(join(s.project.repo, "lines.txt"), Array.from({ length: 60 }, (_, index) => `line-${index}`).join("\n"));
    const driver = createBuilderDriver(s.deps, { project: s.project, git: s.git, turnCap: 40, usdCap: 100 });
    expect(await driver.runFeature(shellFeature("f01"), { attempt: 1 })).toMatchObject({ stopped: "done", turns: 30 });
    expect(await driver.runFeature(shellFeature("f02"), { attempt: 1 })).toMatchObject({ stopped: "turn_cap", turns: 10 });
    expect(s.model.calls).toHaveLength(40);
    expect(s.record.read().filter((event) => event.t === "model.call")).toHaveLength(40);
    expect(s.record.read().filter((event) => event.t === "turn")).toHaveLength(40);
    expect(driver.turns).toBe(40);
  });

  test("an allowed exit on the exact final aggregate turn beats the cap marker", async () => {
    const model = createMockModel({ id: "final-exit", responses: [
      { content: ["first done"] },
      { content: [{ type: "toolCall", name: "exit", arguments: { kind: "cannot_be_satisfied", reasons: ["final-turn reason"] } }] },
    ] as never });
    const s = setup(model);
    const driver = createBuilderDriver(s.deps, { project: s.project, git: s.git, turnCap: 2, usdCap: 10 });
    expect((await driver.runFeature(shellFeature("f01"), { attempt: 1 })).stopped).toBe("done");
    expect(await driver.runFeature(shellFeature("f02"), { attempt: 1 })).toMatchObject({ stopped: "exit", exitReasons: ["final-turn reason"], turns: 1 });
    expect(s.model.calls).toHaveLength(2);
    expect(driver.turns).toBe(2);
  });

  test("overlapping calls refuse without corrupting the active feature and the guard resets", async () => {
    const model = createMockModel({ id: "overlap", delayMs: 20, responses: [
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "printf ok" } }] },
      { content: ["first done"] }, { content: ["third done"] }, { content: ["fifth done"] },
    ] as never } as never);
    const s = setup(model);
    const driver = createBuilderDriver(s.deps, { project: s.project, git: s.git, turnCap: 10, usdCap: 10 });
    const first = driver.runFeature(shellFeature("f01"), { attempt: 1 });
    await expect(driver.runFeature(shellFeature("f02"), { attempt: 1 })).rejects.toThrow("already running");
    expect(await first).toMatchObject({ stopped: "done", selfVerified: true, stalled: undefined });
    expect((s.model.calls[0]!.context.systemPrompt as string[]).join("\n")).not.toContain("Feature: f01");
    expect(JSON.stringify(s.model.calls[0]!.context.messages)).toContain("Feature: f01");
    expect((await driver.runFeature(shellFeature("f03"), { attempt: 1 })).stopped).toBe("done");

    await expect(driver.runFeature(shellFeature("f04", "x".repeat(3_000)), { attempt: 1 })).rejects.toThrow("acceptance contract exceeds");
    expect((await driver.runFeature(shellFeature("f05"), { attempt: 1 })).stopped).toBe("done");
  });
});
