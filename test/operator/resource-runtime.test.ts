import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { initHome } from "../../src/core/home";
import { loadConfig, saveConfig } from "../../src/core/config";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime } from "../../src/operator/runtime";
import type { OmpSessionHandle, OmpSessionOptions } from "../../src/operator/session";

/** Capture the selector used at the native prompt boundary, not only the routing receipt. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-resource-runtime-"));
  initHome(home, { plugAndPlay: true });
  const cfg = loadConfig(home);
  cfg.routing = { mode: "adaptive", resources: "jev", effort: "adaptive" };
  saveConfig(home, cfg);
  const auth = new AuthStore(join(home, "auth.json"));
  auth.setApiKey("anthropic", "offline-resource-test");
  let options: OmpSessionOptions;
  let contextTokens: number | undefined;
  let beforeModelSwitch: (() => Promise<void>) | undefined;
  const prompts: Array<{ modelRef: string; effort: string }> = [];
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const context = (actor = "resource-parent") => ({ sessionManager: { getSessionId: () => actor } });
  const createSession = async (value: OmpSessionOptions): Promise<OmpSessionHandle> => {
    options = value;
    let modelRef = value.modelRef, effort = value.effort;
    value.extensions![0]!({ zod: z, registerTool(tool: any) { tools.set(tool.name, tool); }, on() {} } as never);
    return { sessionId: "resource-parent", sessionFile: join(home, "synthetic-session.jsonl"), connectedProviders: value.connectedProviders,
      session: {
        async prompt() { prompts.push({ modelRef, effort }); }, async abort() {},
        async setModel(model: { provider: string; id: string }) { await beforeModelSwitch?.(); modelRef = `${model.provider}/${model.id}`; },
        setThinkingLevel(next: string) { effort = next; },
        getAsyncJobSnapshot() { return { running: [], recent: [] }; }, agent: { steer() {} },
        getContextUsage() { return contextTokens === undefined ? undefined : { tokens: contextTokens }; },
      } as never, sdk: {} as never, async awaitSettled() {}, async dispose() {} };
  };
  const invoke = async (name: string, args: unknown, actor?: string) => {
    const result = await tools.get(name)!.execute("resource-call", args, undefined, undefined, context(actor));
    return JSON.parse(result.content[0].text);
  };
  return { home, prompts, invoke, options: () => options,
    setContextTokens: (tokens: number) => { contextTokens = tokens; },
    onModelSwitch: (callback: () => Promise<void>) => { beforeModelSwitch = callback; },
    spawn: (name: string) => options.beforeSubagentSpawn!({ agent: "task", invocationKind: "task", patterns: [], taskName: name,
      spawnKey: name, taskText: "Fix the owned punctuation typo" }, context() as never),
    opts: { home, cwd: home, seed: "Fix a punctuation typo in README.md and verify the edited sentence", auth, createSession },
  };
}

const metadata = (dir: string) => JSON.parse(readFileSync(join(dir, "operator.json"), "utf8"));

const CHEAP = "anthropic/claude-haiku-4-5";
function classifier(confidence = 0.99, firstEffort = "light", preferredModel = CHEAP) {
  const wire: any[] = [];
  let resourceCalls = 0;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    wire.push(payload);
    const effort = payload.questions.model && resourceCalls++ === 0 ? firstEffort : "light";
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => {
      const entries = Object.entries((question as { criteria: Record<string, string> }).criteria);
      const choice = (id === "model" ? entries.find(([, text]) => text === preferredModel)
        : id === "effort" ? entries.find(([key]) => key === effort) : undefined)?.[0] ?? entries[0]![0];
      return [id, { type: "choice", choice, confidence,
        probabilities: Object.fromEntries(entries.map(([key]) => [key, key === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: payload.model, answers, usage: { input_tokens: 100, output_tokens: 10 } });
  }) as unknown as typeof globalThis.fetch;
  return { wire, jev: { enabled: true, mode: "boundaries" as const, apiKey: "offline-resource-classifier", fetch } };
}

test("Jev's cheaper low-effort route reaches the first actual native prompt", async () => {
  const f = fixture(), c = classifier();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    expect((await runtime.prompt(f.opts.seed)).stopped).toBe("completed");
    expect(f.prompts).toEqual([{ modelRef: CHEAP, effort: "minimal" }]);
    expect(c.wire.some(payload => payload.questions.model)).toBe(true);
    expect(metadata(runtime.run.dir).resources).toMatchObject({ version: 1, effortPolicy: "adaptive" });
    const meter = JSON.parse(readFileSync(join(runtime.run.dir, "operator-meter.json"), "utf8"));
    expect(meter.rows.some((row: any) => row.provider === "typesafe" && row.state === "settled")).toBe(true);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("explicit effort pins subsequent resource choices and remains pinned on resume", async () => {
  const f = fixture(), c = classifier();
  let runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    await runtime.setEffort("high");
    await runtime.prompt("Fix the next punctuation typo");
    expect(f.prompts.at(-1)).toEqual({ modelRef: CHEAP, effort: "high" });
    expect(metadata(runtime.run.dir).resources.effortPolicy).toBe("fixed");
    const runId = runtime.run.id;
    await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: c.jev });
    await runtime.prompt("Continue with the saved effort choice");
    expect(f.prompts.at(-1)).toEqual({ modelRef: CHEAP, effort: "high" });
    expect(metadata(runtime.run.dir).resources.effortPolicy).toBe("fixed");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a saved adaptive resource policy survives different home defaults", async () => {
  const f = fixture(), c = classifier();
  let runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    const runId = runtime.run.id;
    await runtime.dispose();
    const cfg = loadConfig(f.home);
    cfg.routing = { mode: "manual", resources: "legacy", effort: "fixed" };
    cfg.effort = "xhigh";
    saveConfig(f.home, cfg);
    runtime = await createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: c.jev });
    await runtime.prompt("Continue the saved adaptive task");
    expect(f.prompts.at(-1)).toEqual({ modelRef: CHEAP, effort: "minimal" });
    expect(metadata(runtime.run.dir).resources).toMatchObject({ version: 1, effortPolicy: "adaptive" });
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("old sessions without resource metadata do not acquire Jev resource routing on resume", async () => {
  const f = fixture(), c = classifier();
  const cfg = loadConfig(f.home);
  cfg.routing = { mode: "adaptive", resources: "legacy", effort: "fixed" };
  saveConfig(f.home, cfg);
  let runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    const runId = runtime.run.id;
    expect(metadata(runtime.run.dir).resources).toBeUndefined();
    await runtime.dispose();
    cfg.routing = { mode: "adaptive", resources: "jev", effort: "adaptive" };
    saveConfig(f.home, cfg);
    const previousCalls = c.wire.filter(payload => payload.questions.model).length;
    runtime = await createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: c.jev });
    await runtime.prompt("Continue the legacy session");
    expect(c.wire.filter(payload => payload.questions.model)).toHaveLength(previousCalls);
    expect(metadata(runtime.run.dir).resources).toBeUndefined();
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("uncertain Jev resource choices cannot masquerade as accepted cheap routes", async () => {
  const f = fixture(), c = classifier(0.1);
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    expect((await runtime.prompt(f.opts.seed)).stopped).toBe("completed");
    expect(c.wire.some(payload => payload.questions.model)).toBe(true);
    expect(f.prompts[0]).not.toEqual({ modelRef: CHEAP, effort: "minimal" });
    const record = readFileSync(runtime.run.record, "utf8");
    expect(record).toContain("fallback");
    expect(record).not.toContain('\\"source\\":\\"jev\\"');
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("removing the saved resource policy cannot silently turn its admitted catalog into a legacy run", async () => {
  const f = fixture(), c = classifier();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    const runId = runtime.run.id, path = join(runtime.run.dir, "operator.json");
    await runtime.dispose();
    const saved = metadata(runtime.run.dir);
    delete saved.resources;
    writeFileSync(path, JSON.stringify(saved));
    await expect(createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: c.jev })).rejects.toThrow("admitted model catalog");
    expect(f.prompts).toHaveLength(0);
    expect(c.wire).toHaveLength(0);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a task-specific worker receives Jev's own effort in the native spawn selector", async () => {
  const f = fixture(), c = classifier(0.99, "deep");
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    expect(f.prompts[0]).toEqual({ modelRef: CHEAP, effort: "xhigh" });
    await f.invoke("team", { action: "plan", expectedRevision: 0, plans: [{ id: "typo", objective: "Correct one punctuation typo",
      scopes: ["README.md"], dependencies: [], acceptance: ["Edited sentence has correct punctuation"] }] });
    const assignment = await f.invoke("team_assign", { action: "assign", featureId: "typo", role: "Punctuation editor", qualityDemand: "simple" });
    expect(assignment).toMatchObject({ modelRef: CHEAP, effort: "minimal", source: "jev" });
    expect(await f.spawn(assignment.dispatchName)).toMatchObject({ model: `${CHEAP}:minimal` });
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a worker-specific explicit effort takes precedence over an earlier global effort pin", async () => {
  const f = fixture(), c = classifier();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    await runtime.setEffort("high");
    await f.invoke("team", { action: "plan", expectedRevision: 0, plans: [{ id: "typo", objective: "Correct one punctuation typo",
      scopes: ["README.md"], dependencies: [], acceptance: ["Edited sentence has correct punctuation"] }] });
    const assignment = await f.invoke("team_assign", { action: "assign", featureId: "typo", role: "Punctuation editor",
      exactModelRef: CHEAP, exactEffort: "low" });
    expect(assignment).toMatchObject({ modelRef: CHEAP, effort: "low", source: "explicit" });
    expect(await f.spawn(assignment.dispatchName)).toMatchObject({ model: `${CHEAP}:low` });
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("an effort pin arriving while Jev is pending governs the first actual model call", async () => {
  const f = fixture(), c = classifier();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch: typeof globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
    entered(); await gate; return c.jev.fetch(...args);
  }) as typeof globalThis.fetch;
  const runtime = await createOperatorRuntime({ ...f.opts, jev: { ...c.jev, fetch } });
  let turn: ReturnType<typeof runtime.prompt> | undefined;
  try {
    turn = runtime.prompt(f.opts.seed);
    await started;
    await runtime.setEffort("high");
    release();
    expect((await turn).stopped).toBe("completed");
    expect(f.prompts[0]?.effort).toBe("high");
    expect(metadata(runtime.run.dir).effort).toBe("high");
  } finally { release(); await turn; await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("context admission includes a large new user message as well as existing history", async () => {
  const f = fixture(), c = classifier();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    f.setContextTokens(190_000);
    expect((await runtime.prompt("Review this new material: " + "new evidence ".repeat(20_000))).stopped).toBe("completed");
    expect(f.prompts.at(-1)?.modelRef).not.toBe(CHEAP);
    const route = c.wire.filter(payload => payload.questions.model).at(-1);
    expect(route.state.requiredContextTokens).toBeGreaterThan(200_000);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("resume consults restored native history before admitting a smaller-context model", async () => {
  const f = fixture(), c = classifier(0.99, "light", "anthropic/claude-opus-5-5");
  let runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    f.setContextTokens(250_000);
    const runId = runtime.run.id;
    await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: c.jev });
    expect((await runtime.prompt("Continue from the saved research")).stopped).toBe("completed");
    const route = c.wire.filter(payload => payload.questions.model).at(-1);
    expect(route.state.requiredContextTokens).toBeGreaterThan(250_000);
    expect(Object.values(route.questions.model.criteria).some(value => value === CHEAP)).toBe(false);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("independent review excludes the actual dispatched producer and rejects a reopened producer", async () => {
  const f = fixture(), c = classifier();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  try {
    await runtime.prompt(f.opts.seed);
    await f.invoke("team", { action: "plan", expectedRevision: 0, plans: [
      { id: "typo", objective: "Correct one punctuation typo", scopes: ["README.md"], dependencies: [], acceptance: ["Edited sentence has correct punctuation"] },
      { id: "review", objective: "Independently review the edited sentence", scopes: ["review.md"], dependencies: [], acceptance: ["Review records whether the change is correct"] },
    ] });
    const producer = await f.invoke("team_assign", { action: "assign", featureId: "typo", role: "Punctuation editor" });
    const request = { action: "assign", featureId: "review", role: "Independent punctuation reviewer", reviewOfFeatureId: "typo" };
    await expect(f.invoke("team_assign", request)).rejects.toThrow("dispatch");
    expect(await f.spawn(producer.dispatchName)).toMatchObject({ model: `${CHEAP}:minimal` });
    await f.invoke("team", { action: "claim", id: "typo", expectedRevision: 1 }, "punctuation-worker");
    const reviewer = await f.invoke("team_assign", request);
    expect(reviewer.modelRef).not.toBe(producer.modelRef);
    expect(reviewer.reviewOf).toMatchObject({ featureId: "typo", modelRef: producer.modelRef, dispatchName: producer.dispatchName });
    await f.invoke("team", { action: "reopen", id: "typo", expectedRevision: 2, summary: "Revise the source sentence before review" });
    await expect(Promise.resolve().then(() => f.spawn(reviewer.dispatchName))).rejects.toThrow("producer");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("an effort pin arriving during native model switching is not overwritten by the earlier route", async () => {
  const f = fixture(), c = classifier();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: c.jev });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let turn: ReturnType<typeof runtime.prompt> | undefined;
  try {
    await runtime.prompt(f.opts.seed);
    f.setContextTokens(250_000);
    f.onModelSwitch(async () => { entered(); await gate; });
    turn = runtime.prompt("Review the accumulated evidence");
    await started;
    await runtime.setEffort("high");
    release();
    expect((await turn).stopped).toBe("completed");
    expect(f.prompts.at(-1)?.effort).toBe("high");
  } finally { release(); await turn; await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});
