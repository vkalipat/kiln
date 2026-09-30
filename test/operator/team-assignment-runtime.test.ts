import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { initHome } from "../../src/core/home";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime, type OperatorRuntimeOptions } from "../../src/operator/runtime";
import type { OmpSessionHandle, OmpSessionOptions } from "../../src/operator/session";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-assignment-runtime-"));
  initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json"));
  auth.setApiKey("anthropic", "offline-anthropic");
  auth.setApiKey("openai", "offline-openai");
  let sessionOptions: OmpSessionOptions;
  let prompts = 0;
  let jobs: { running: any[]; recent: any[] } = { running: [], recent: [] };
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const context = (id = "assignment-parent") => ({ sessionManager: { getSessionId: () => id } });
  const createSession = async (options: OmpSessionOptions): Promise<OmpSessionHandle> => {
    sessionOptions = options;
    options.extensions![0]!({ zod: z, registerTool(tool: any) { tools.set(tool.name, tool); }, on() {} } as never);
    return { sessionId: "assignment-parent", sessionFile: join(home, "synthetic-session.jsonl"), connectedProviders: options.connectedProviders,
      session: { async prompt() { prompts++; }, async abort() {}, setThinkingLevel() {}, getAsyncJobSnapshot() { return jobs; } } as never,
      sdk: {} as never, async awaitSettled() {}, async dispose() {} };
  };
  const invoke = async (name: string, args: unknown, actor?: string) => {
    const result = await tools.get(name)!.execute("synthetic-call", args, undefined, undefined, context(actor));
    return JSON.parse(result.content[0].text);
  };
  const spawn = (name: string, overrides = {}, actor?: string) => sessionOptions.beforeSubagentSpawn!(
    { agent: "task", invocationKind: "task", patterns: [], taskName: name, spawnKey: name, taskText: "Complete the owned feature", ...overrides }, context(actor) as never);
  return { home, auth, context, invoke, spawn, prompts: () => prompts, options: () => sessionOptions,
    setJobs: (value: typeof jobs) => { jobs = value; },
    opts: { home, cwd: home, seed: "Build a parser and document its inputs", auth, createSession } };
}

const plans = [
  { id: "parser", objective: "Implement malformed row handling", scopes: ["parser.ts"], dependencies: [], acceptance: ["Malformed rows have checked behavior"] },
  { id: "docs", objective: "Explain accepted input shapes", scopes: ["guide.md"], dependencies: [], acceptance: ["Input shapes match parser behavior"] },
];

async function start(f: ReturnType<typeof fixture>, jev: OperatorRuntimeOptions["jev"] = { enabled: false }) {
  const runtime = await createOperatorRuntime({ ...f.opts, jev });
  expect((await runtime.prompt(f.opts.seed)).stopped).toBe("completed");
  await f.invoke("team", { action: "plan", expectedRevision: 0, plans });
  return runtime;
}

test("task-specific responsibilities dispatch independently and survive operator resume", async () => {
  const f = fixture();
  let runtime = await start(f);
  try {
    const catalog = (await f.invoke("team_assign", { action: "catalog" })).models;
    expect(catalog.length).toBeGreaterThan(1);
    const first = catalog[0], second = catalog[1];
    const parser = await f.invoke("team_assign", { action: "assign", featureId: "parser", role: "Malformed-input contract investigator",
      candidates: [{ modelRef: first.modelRef, reason: "Inspect error cases against the existing parser with focused checks" }], preferredModelRef: first.modelRef });
    const docs = await f.invoke("team_assign", { action: "assign", featureId: "docs", role: "Input-example consistency editor",
      candidates: [{ modelRef: second.modelRef, reason: "Write precise examples in an independent file while parser work proceeds" }], preferredModelRef: second.modelRef });
    expect(parser.role).toBe("Malformed-input contract investigator");
    expect(docs.role).toBe("Input-example consistency editor");
    expect(parser.dispatchName).not.toBe(docs.dispatchName);
    expect(f.prompts()).toBe(1);
    const dispatched = await Promise.all([f.spawn(parser.dispatchName), f.spawn(docs.dispatchName)]);
    expect(dispatched[0]).toMatchObject({ model: `${first.modelRef}:${f.options().effort}` });
    expect(dispatched[1]).toMatchObject({ model: `${second.modelRef}:${f.options().effort}` });
    expect(parser.effort).toBe(first.effort);
    expect(docs.effort).toBe(second.effort);
    expect(f.prompts()).toBe(1);
    const saved = JSON.parse(readFileSync(join(runtime.run.dir, "operator", "team-assignments.json"), "utf8"));
    expect(saved.assignments).toHaveLength(2);
    const runId = runtime.run.id;
    await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: { enabled: false } });
    expect((await runtime.prompt("Continue the planned features")).stopped).toBe("completed");
    expect(await f.invoke("team_assign", { action: "query" })).toEqual([parser, docs]);
    expect(await f.spawn(parser.dispatchName)).toMatchObject({ model: `${first.modelRef}:${f.options().effort}` });
    expect(f.prompts()).toBe(2);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("only parent assigns; unknown and incompatible candidate choices do not create assignments", async () => {
  const f = fixture(), runtime = await start(f);
  try {
    const [model] = (await f.invoke("team_assign", { action: "catalog" })).models;
    const args = { action: "assign", featureId: "parser", role: "Parser edge-case owner",
      candidates: [{ modelRef: model.modelRef, reason: "Appropriate for the scoped parser behavior" }], preferredModelRef: model.modelRef };
    await expect(f.invoke("team_assign", args, "worker")).rejects.toThrow("parent");
    await expect(f.invoke("team_assign", { ...args, candidates: [{ modelRef: "unconnected/not-admitted", reason: "Not a connected model" }], preferredModelRef: "unconnected/not-admitted" })).rejects.toThrow("admitted");
    expect(await f.invoke("team_assign", { action: "query" })).toEqual([]);
    expect(f.prompts()).toBe(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("native inherited parent selector does not override the task-specific assigned model", async () => {
  const f = fixture(), runtime = await start(f);
  try {
    const catalog = await f.invoke("team_assign", { action: "catalog" });
    expect(catalog.evidenceSnapshot).toBeDefined();
    const selected = catalog.models.find((model: { modelRef: string }) => model.modelRef !== f.options().modelRef);
    expect(selected).toBeDefined();
    const assignment = await f.invoke("team_assign", { action: "assign", featureId: "parser", role: "Malformed-input contract investigator",
      candidates: [{ modelRef: selected.modelRef, reason: "Inspect the task-specific parser failure cases" }], preferredModelRef: selected.modelRef });
    expect(await f.spawn(assignment.dispatchName, { patterns: [f.options().modelRef], modelRole: undefined }))
      .toMatchObject({ model: `${selected.modelRef}:${f.options().effort}` });
    const explicit = await f.invoke("team_assign", { action: "assign", featureId: "docs", role: "Input-example consistency editor",
      candidates: [{ modelRef: selected.modelRef, reason: "Write precise input examples" }], preferredModelRef: selected.modelRef });
    expect(await f.spawn(explicit.dispatchName, { patterns: [`${selected.modelRef}:low`], modelRole: undefined }))
      .toMatchObject({ model: `${selected.modelRef}:low` });
    const dispatchRecords = readFileSync(runtime.run.record, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.t === "note" && row.text.startsWith("operator.team_dispatch "))
      .map(row => JSON.parse(row.text.slice("operator.team_dispatch ".length)));
    expect(dispatchRecords.at(-1)).toMatchObject({ selector: `${selected.modelRef}:low`, requestedEffort: "low", effortSource: "model_selector" });
    expect(f.prompts()).toBe(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("saved assignments reject conflicting selectors, worker redispatch and duplicate launches", async () => {
  const f = fixture(), runtime = await start(f);
  try {
    const [model] = (await f.invoke("team_assign", { action: "catalog" })).models;
    expect(await f.spawn("unassigned-native-worker")).toBeUndefined();
    const assignment = await f.invoke("team_assign", { action: "assign", featureId: "parser", role: "Parser invariants owner",
      candidates: [{ modelRef: model.modelRef, reason: "Check parser invariants within the feature scope" }], preferredModelRef: model.modelRef });
    expect(await f.spawn(assignment.dispatchName, {}, "worker")).toMatchObject({ block: true });
    expect(await f.spawn(assignment.dispatchName, { patterns: ["unconnected/not-admitted"] })).toMatchObject({ block: true });
    expect(await f.spawn("assignment_00000000000000000000000000000000")).toMatchObject({ block: true });
    expect(await f.spawn("unassigned-native-worker")).toMatchObject({ block: true });
    expect(await f.spawn("", { taskName: undefined, spawnKey: undefined })).toMatchObject({ block: true });
    expect(await f.spawn(assignment.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    expect(await f.spawn(assignment.dispatchName)).toMatchObject({ block: true });
    expect(f.prompts()).toBe(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("confirmed failed startup releases only its assignment reservation for a deliberate retry", async () => {
  const f = fixture(), runtime = await start(f);
  try {
    const [model] = (await f.invoke("team_assign", { action: "catalog" })).models;
    const base = { action: "assign", role: "Scoped feature owner",
      candidates: [{ modelRef: model.modelRef, reason: "Check the owned feature against its acceptance criteria" }], preferredModelRef: model.modelRef };
    const parser = await f.invoke("team_assign", { ...base, featureId: "parser" });
    const docs = await f.invoke("team_assign", { ...base, featureId: "docs" });
    expect(await f.spawn(parser.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    expect(await f.spawn(docs.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    expect(await f.spawn(parser.dispatchName)).toMatchObject({ block: true });
    await f.options().onTaskDispatchFailure!([parser.dispatchName], f.context("unrelated-worker") as never);
    expect(await f.spawn(parser.dispatchName)).toMatchObject({ block: true });
    // The native adapter calls this only after an error and absence of a live matching child.
    await f.options().onTaskDispatchFailure!([parser.dispatchName], f.context() as never);
    expect(await f.spawn(docs.dispatchName)).toMatchObject({ block: true });
    expect(await f.spawn(parser.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    expect(await f.spawn(parser.dispatchName)).toMatchObject({ block: true });
    expect(await f.invoke("team_assign", { action: "query" })).toEqual([parser, docs]);
    expect(f.prompts()).toBe(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("an async assignment retries only after its exact prior job has failed and is no longer running", async () => {
  const f = fixture(), runtime = await start(f);
  try {
    const [model] = (await f.invoke("team_assign", { action: "catalog" })).models;
    const assignment = await f.invoke("team_assign", { action: "assign", featureId: "parser", role: "Parser invariants owner",
      candidates: [{ modelRef: model.modelRef, reason: "Check parser invariants within the feature scope" }], preferredModelRef: model.modelRef });
    const firstId = `parent.${assignment.dispatchName}`;
    const retryId = `${firstId}-2`;
    expect(await f.spawn(assignment.dispatchName, { spawnKey: firstId })).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    f.setJobs({ running: [{ id: firstId }], recent: [{ id: firstId, status: "failed" }] });
    expect(await f.spawn(assignment.dispatchName, { spawnKey: retryId })).toMatchObject({ block: true });
    f.setJobs({ running: [], recent: [{ id: "unrelated-job", status: "failed" }] });
    expect(await f.spawn(assignment.dispatchName, { spawnKey: retryId })).toMatchObject({ block: true });
    f.setJobs({ running: [], recent: [{ id: firstId, status: "failed" }] });
    expect(await f.spawn(assignment.dispatchName, { spawnKey: retryId })).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    expect(await f.spawn(assignment.dispatchName, { spawnKey: `${firstId}-3` })).toMatchObject({ block: true });
    expect(f.prompts()).toBe(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a resumed operator retains assignments when the user changes reasoning effort", async () => {
  const f = fixture(); let runtime = await start(f);
  try {
    const [model] = (await f.invoke("team_assign", { action: "catalog" })).models;
    const assignment = await f.invoke("team_assign", { action: "assign", featureId: "parser", role: "Parser invariants owner",
      candidates: [{ modelRef: model.modelRef, reason: "Check parser invariants within the feature scope" }], preferredModelRef: model.modelRef });
    await runtime.setEffort(model.effort === "low" ? "high" : "low");
    const runId = runtime.run.id;
    await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.opts, seed: undefined, runId, jev: { enabled: false } });
    expect((await runtime.prompt("Continue after the explicit effort change")).stopped).toBe("completed");
    expect(await f.invoke("team_assign", { action: "query" })).toHaveLength(1);
    expect(await f.spawn(assignment.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("reopening a feature invalidates its old dispatch identity while admitting a fresh assignment", async () => {
  const f = fixture(), runtime = await start(f);
  try {
    const [model] = (await f.invoke("team_assign", { action: "catalog" })).models;
    const args = { action: "assign", featureId: "parser", role: "Parser invariants owner",
      candidates: [{ modelRef: model.modelRef, reason: "Check parser invariants within the feature scope" }], preferredModelRef: model.modelRef };
    const first = await f.invoke("team_assign", args);
    expect(await f.spawn(first.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
    await f.invoke("team", { action: "claim", id: "parser", expectedRevision: 1 }, "first-worker");
    await f.invoke("team", { action: "reopen", id: "parser", expectedRevision: 2, summary: "Worker stopped before finishing; restart the remaining scoped work" });
    await expect(Promise.resolve().then(() => f.spawn(first.dispatchName))).rejects.toThrow("changed or reopened");
    const second = await f.invoke("team_assign", args);
    expect(second.dispatchName).not.toBe(first.dispatchName);
    expect(await f.spawn(second.dispatchName)).toMatchObject({ model: `${model.modelRef}:${f.options().effort}` });
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

function classifier(onCall: () => void, confidence: number): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    onCall();
    const payload = JSON.parse(init!.body as string);
    return Response.json({ model: payload.model, answers: { model: { type: "choice", choice: "model_1", confidence,
      probabilities: Object.fromEntries(Object.keys(payload.questions.model.criteria).map(key => [key, key === "model_1" ? 1 : 0])) } },
      usage: { input_tokens: 100, output_tokens: 10 } });
  }) as unknown as typeof fetch;
}

test.each([0.99, 0.1])("Jev shortlist confidence %s preserves bounded assignment without an additional frontier prompt", async confidence => {
  const f = fixture(); let requests = 0;
  const runtime = await start(f, { enabled: true, mode: "boundaries", apiKey: "offline", fetch: classifier(() => requests++, confidence) });
  try {
    const catalog = (await f.invoke("team_assign", { action: "catalog" })).models;
    const candidates = catalog.slice(0, 2).map((model: any) => ({ modelRef: model.modelRef, reason: "Meets feature quality needs with bounded verification" }));
    const args = { action: "assign", featureId: "parser", role: "Malformed row behavior owner", candidates, preferredModelRef: candidates[0].modelRef };
    const assignment = await f.invoke("team_assign", args);
    expect(assignment).toMatchObject({ modelRef: candidates[confidence > 0.8 ? 1 : 0].modelRef, source: confidence > 0.8 ? "jev" : "frontier" });
    expect(requests).toBe(1);
    expect(await f.invoke("team_assign", args)).toEqual(assignment);
    expect(requests).toBe(1);
    expect(f.prompts()).toBe(1);
    expect(await f.spawn(assignment.dispatchName)).toMatchObject({ model: `${assignment.modelRef}:${f.options().effort}` });
    expect(requests).toBe(1);
    expect(f.prompts()).toBe(1);
    const explicit = await f.invoke("team_assign", { ...args, featureId: "docs", exactModelRef: candidates[0].modelRef });
    expect(explicit).toMatchObject({ modelRef: candidates[0].modelRef, source: "frontier" });
    expect(requests).toBe(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});
