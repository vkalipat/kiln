import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { initHome } from "../../src/core/home";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime, type OperatorRuntimeOptions } from "../../src/operator/runtime";
import type { OmpSessionHandle, OmpSessionOptions } from "../../src/operator/session";
import { runBrowserWorkflow } from "../../src/operator/browser-workflow";

type Tool = { execute: (id: string, args: unknown, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<any> };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-runtime-")); initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("anthropic", "offline-test-key");
  const tools = new Map<string, Tool>(), steering: string[] = [];
  let prompt = async () => {};
  const factory = async (options: OmpSessionOptions): Promise<OmpSessionHandle> => {
    options.extensions![0]!({ zod: z, registerTool(value: Tool & { name: string }) { tools.set(value.name, value); }, on() {} } as never);
    return { sessionId: "workflow-parent", sessionFile: join(home, "session.jsonl"), connectedProviders: ["anthropic"],
      session: { prompt: () => prompt(), async steer(text: string) { steering.push(text); }, async abort() {} } as never,
      sdk: {} as never, async awaitSettled() {}, async dispose() {} };
  };
  return { home, tools, steering,
    options: { home, cwd: home, seed: "Collect sample results without treating labels as verified truth", auth, createSession: factory },
    prompt: (body: () => Promise<void>) => { prompt = body; },
    invoke: (name: string, args: unknown, sessionId = "workflow-parent", signal?: AbortSignal) => {
      const tool = tools.get(name); if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute("fixture-call", args, signal, undefined, { sessionManager: { getSessionId: () => sessionId } });
    },
  };
}
function transport(choose: (id: string, payload: any) => { choice: string; confidence?: number }, wire: any[]): typeof fetch {
  return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)); wire.push(payload);
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, raw]) => {
      const criteria = (raw as { criteria: Record<string, string> }).criteria;
      const selected = choose(id, payload);
      if (!Object.hasOwn(criteria, selected.choice)) throw new Error(`Fixture choice absent: ${id}/${selected.choice}`);
      return [id, { type: "choice", choice: selected.choice, confidence: selected.confidence ?? 0.99,
        probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === selected.choice ? 1 : 0])) }];
    }));
    return Response.json({ model: payload.model, answers, usage: { input_tokens: 100, output_tokens: 10 } });
  }) as unknown as typeof fetch;
}
const researchInput = { question: "Did every sample pass and was sample C measured?",
  requiredFields: [{ id: "all_pass", question: "Did every sample pass?" }, { id: "measured", question: "Was sample C measured?" }],
  sources: ["https://docs.example.com/results"], allowedHosts: ["docs.example.com"] };
const meterRows = (dir: string) => JSON.parse(readFileSync(join(dir, "operator-meter.json"), "utf8")).rows as Array<{ lane: string; sessionId: string; provider: string; state: string; costUsd?: number }>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const jevOptions = (fetch: typeof globalThis.fetch): OperatorRuntimeOptions["jev"] => ({ enabled: true, mode: "boundaries", apiKey: "offline-typesafe", fetch });

test("registered research task traverses real capture, batch service, accounting and cited unknown-preserving receipt", async () => {
  const f = fixture(), wire: any[] = []; let captures = 0;
  const jev = transport(id => ({ choice: id === "f0_coverage" ? "contradicts" : id === "f1_coverage" ? "unknown" : id === "f0_conflict" ? "p0" : "none" }), wire);
  const fetch = (async (url: Parameters<typeof globalThis.fetch>[0]) => {
    expect(String(url)).toBe("https://docs.example.com/results"); captures++;
    return new Response("<html><body><h1>Sample results</h1><p>Sample B failed. Sample C was not measured.</p></body></html>", { headers: { "content-type": "text/html" } });
  }) as unknown as typeof globalThis.fetch;
  const runtime = await createOperatorRuntime({ ...f.options, jev: jevOptions(jev), workflows: { enabled: true, fetch } });
  try {
    await runtime.prompt("Collect source evidence");
    const { details } = await f.invoke("research_task", researchInput, "research-worker");
    expect(captures).toBe(1); expect(wire).toHaveLength(1);
    expect(Object.keys(wire[0].questions)).toHaveLength(6);
    expect(details.truthVerified).toBe(false);
    expect(details.fields.find((field: any) => field.id === "all_pass").evidence[0].coverage).toBe("contradicts");
    expect(details.fields.find((field: any) => field.id === "measured").status).toBe("unknown");
    const source = details.sources[0], captured = readFileSync(source.artifact.path, "utf8");
    expect(captured).toContain("Sample B failed"); expect(digest(captured)).toBe(source.artifact.sha256);
    const location = details.fields[0].evidence[0].locations[0];
    expect(location.path).toBe(source.artifact.path); expect(location.sha256).toBe(source.artifact.sha256);
    expect(captured.slice(location.start, location.end)).toContain("Sample B failed");
    expect(details.cost.complete).toBe(false); // Fetch has no provider price receipt.
    expect(digest(readFileSync(details.artifact.path, "utf8"))).toBe(details.artifact.sha256);
    expect(meterRows(runtime.run.dir)).toEqual([expect.objectContaining({ lane: "external", provider: "typesafe", sessionId: "research-worker", state: "settled" })]);
    expect(meterRows(runtime.run.dir)[0]!.costUsd).toBeCloseTo(0.0000042, 12);
    const metadata = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(metadata.workflows.stats).toMatchObject({ attempts: 1, inputTokens: 100, outputTokens: 10 });
    expect(readFileSync(runtime.run.record, "utf8")).toContain("operator.workflow");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("registered browser decision accounts one batch and ignores uncertain unselected target heads", async () => {
  const f = fixture(), wire: any[] = []; let browserCalls = 0;
  const jev = transport(id => id === "operation" ? { choice: "click" } : id === "click_target" ? { choice: "e2" } : { choice: "e3", confidence: 0.1 }, wire);
  const runtime = await createOperatorRuntime({ ...f.options, jev: jevOptions(jev), workflows: { enabled: true,
    browser: async () => { browserCalls++; throw new Error("Decision must not invoke an executor"); } } });
  try {
    await runtime.prompt("Prepare the bounded browser task");
    const { details } = await f.invoke("kiln_browser_decide", { task: "Open results", stateHash: "observed-fixture", step: 0,
      state: { url: "https://docs.example.com/", title: "Results", text: "Open results", actions: [
        { id: "e1", kind: "click", label: "About" }, { id: "e2", kind: "click", label: "Results" }, { id: "e3", kind: "fill", label: "Search" },
      ] } }, "browser-worker");
    expect(details).toMatchObject({ accepted: true, stateHash: "observed-fixture", operation: "click", target: "e2" });
    expect(wire).toHaveLength(1); expect(browserCalls).toBe(0);
    expect(meterRows(runtime.run.dir)[0]).toMatchObject({ lane: "external", sessionId: "browser-worker", state: "settled" });
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("registered browser task uses actual decision service yet cannot certify a failed outcome check", async () => {
  const f = fixture(), wire: any[] = []; let actions = 0;
  const jev = transport(id => ({ choice: id === "operation" ? "done" : "e1" }), wire);
  const runtime = await createOperatorRuntime({ ...f.options, jev: jevOptions(jev), workflows: { enabled: true,
    browser: (input, execution) => runBrowserWorkflow(input, {
      observe: async () => ({ url: "https://docs.example.com/results", title: "Results", text: "Sample B missing",
        actions: [{ id: "e1", kind: "click", label: "Results" }], marker: "unchanged", page_key: "fixture", guards: {} }),
      decide: async payload => (await f.invoke(execution.decideToolName, payload, "browser-worker", execution.signal)).details,
      act: async () => { actions++; return { status: "acted" }; },
      verify: async checks => checks.map((check, index) => ({ index, kind: check.kind, passed: false })),
      wait: async () => {}, now: () => performance.now(), signal: execution.signal,
    }) } });
  try {
    await runtime.prompt("Open results and verify the required observation");
    const { details } = await f.invoke("browser_task", { tab: "fixture", task: "Show Sample B measured outcome", allowedActions: [{ kind: "click", label: "Results" }],
      checks: [{ kind: "text_includes", value: "Sample B failed" }] }, "browser-worker");
    expect(details.status).toBe("incomplete"); expect(details.taskQualityValidated).toBe(false);
    expect(wire).toHaveLength(1); expect(actions).toBe(0);
    expect(digest(readFileSync(details.artifact.path, "utf8"))).toBe(details.artifact.sha256);
    expect(meterRows(runtime.run.dir)[0]!.sessionId).toBe("browser-worker");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("workflow tools remain absent when the opt-in is disabled", async () => {
  const f = fixture();
  const runtime = await createOperatorRuntime({ ...f.options, jev: { enabled: false }, workflows: { enabled: false } });
  try {
    await runtime.prompt("Use existing native tools");
    expect(f.tools.has("research_task")).toBe(false);
    expect(f.tools.has("browser_task")).toBe(false);
    expect(f.tools.has("kiln_browser_decide")).toBe(false);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a new native run does not register workflows when neither API nor environment opts in", async () => {
  const previous = process.env.KILN_JEV_WORKFLOWS;
  delete process.env.KILN_JEV_WORKFLOWS;
  const f = fixture(); let runtime: Awaited<ReturnType<typeof createOperatorRuntime>> | undefined;
  try {
    runtime = await createOperatorRuntime({ ...f.options, jev: { enabled: false } });
    await runtime.prompt("Use existing native tools");
    expect(["research_task", "browser_task", "kiln_browser_decide"].some(name => f.tools.has(name))).toBe(false);
    expect(JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8")).workflows.enabled).toBe(false);
  } finally {
    await runtime?.dispose(); rmSync(f.home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.KILN_JEV_WORKFLOWS; else process.env.KILN_JEV_WORKFLOWS = previous;
  }
});

test("steering invalidates in-flight registered research before classification or further I/O", async () => {
  const f = fixture(); let promptStarted!: () => void, finishPrompt!: () => void, fetchStarted!: () => void;
  const promptEntered = new Promise<void>(resolve => { promptStarted = resolve; });
  const fetchEntered = new Promise<void>(resolve => { fetchStarted = resolve; });
  f.prompt(async () => { promptStarted(); await new Promise<void>(resolve => { finishPrompt = resolve; }); });
  const wire: any[] = [];
  const fetch = (async () => { fetchStarted(); return new Promise(() => {}); }) as unknown as typeof globalThis.fetch;
  const runtime = await createOperatorRuntime({ ...f.options, jev: jevOptions(transport(() => ({ choice: "unknown" }), wire)), workflows: { enabled: true, fetch } });
  let turn: ReturnType<typeof runtime.prompt> | undefined;
  try {
    turn = runtime.prompt("Collect these results"); await promptEntered;
    const pending = f.invoke("research_task", researchInput);
    await fetchEntered;
    await runtime.steer("Stop this collection and use the revised evidence scope");
    const { details } = await pending;
    expect(details.status).toBe("cancelled"); expect(details.sources).toHaveLength(0);
    expect(details.fields.every((field: any) => field.status === "unknown")).toBe(true);
    expect(wire).toHaveLength(0);
    expect(f.steering).toEqual(["Stop this collection and use the revised evidence scope"]);
    finishPrompt(); expect((await turn).stopped).toBe("completed");
  } finally { finishPrompt?.(); await turn; await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});
