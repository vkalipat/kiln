import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel, type Model } from "@oh-my-pi/pi-catalog";
import { z } from "zod";
import { initHome } from "../../src/core/home";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime, type OperatorEvent, type OperatorRuntimeOptions } from "../../src/operator/runtime";
import type { OmpSessionHandle, OmpSessionOptions } from "../../src/operator/session";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-jev-runtime-")); initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json"));
  auth.setApiKey("anthropic", "offline-anthropic"); auth.setApiKey("openai", "offline-openai");
  const sequence: string[] = [], events: OperatorEvent[] = [];
  let failSwitch = false, initialRef = "", selected: Model | undefined;
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const factory = async (options: OmpSessionOptions): Promise<OmpSessionHandle> => {
    initialRef = options.modelRef;
    const split = initialRef.indexOf("/"); selected = getBundledModel(initialRef.slice(0, split) as never, initialRef.slice(split + 1));
    options.extensions![0]!({ zod: z, registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); }, on() {} } as never);
    return { sessionId: "jev-parent", sessionFile: join(home, "fake-session.jsonl"), connectedProviders: options.connectedProviders,
      session: { get model() { return selected; },
        async setModel(model: Model) { sequence.push("setModel"); if (failSwitch) throw new Error("synthetic switch failure"); selected = model; },
        setThinkingLevel() { sequence.push("setThinkingLevel"); },
        async prompt() { sequence.push("prompt"); }, async abort() { sequence.push("abort"); },
        agent: { steer() {} },
      } as never, sdk: {} as never, async awaitSettled() {}, async dispose() {} };
  };
  const opts = { home, cwd: home, seed: "Implement a checked feature", auth, createSession: factory, onEvent: (event: OperatorEvent) => events.push(event) };
  return { home, sequence, events, opts, setFailSwitch: () => { failSwitch = true; }, initial: () => initialRef,
    invoke: (kind: string, reason: string) => tools.get("route_step")!.execute("test-route", { kind, reason }, undefined, undefined,
      { sessionManager: { getSessionId: () => "jev-parent" }, model: selected }),
    selected: () => selected ? `${selected.provider}/${selected.id}` : undefined };
}
function classifier(onCall: () => void, confidence = 0.99): typeof fetch {
  return (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    onCall(); const payload = JSON.parse(init!.body as string);
    return Response.json({ model: payload.model, answers: { route: { type: "choice", choice: "research", confidence,
      probabilities: Object.fromEntries(Object.keys(payload.questions.route.criteria).map(key => [key, key === "research" ? 1 : 0])) } },
      usage: { input_tokens: 100, output_tokens: 10 } });
  }) as unknown as typeof fetch;
}
const rows = (dir: string) => JSON.parse(readFileSync(join(dir, "operator-meter.json"), "utf8")).rows as Array<{ provider: string; state: string; costUsd?: number }>;

test("runtime classifies before main dispatch, persists routing and charges repeated classification once", async () => {
  const f = fixture(); let requests = 0;
  const runtime = await createOperatorRuntime({ ...f.opts, jev: { mode: "per_prompt", enabled: true, apiKey: "offline", fetch: classifier(() => { requests++; f.sequence.push("jev"); }) } });
  try {
    expect((await runtime.prompt("Implement a checked feature")).stopped).toBe("completed");
    expect(f.sequence.indexOf("jev")).toBeLessThan(f.sequence.indexOf("setModel"));
    expect(f.sequence.indexOf("setModel")).toBeLessThan(f.sequence.indexOf("prompt"));
    expect(f.sequence.indexOf("setThinkingLevel")).toBeLessThan(f.sequence.indexOf("prompt"));
    expect(f.events.some(event => event.type === "routing" && event.kind === "research" && !event.handoff)).toBe(true);
    const saved = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(saved.step).toBe("research"); expect(saved.modelRef).toBe(f.selected());
    expect((await runtime.prompt("Implement a checked feature")).stopped).toBe("completed");
    expect(requests).toBe(1);
    const classifierRows = rows(runtime.run.dir).filter(row => row.provider === "typesafe");
    expect(classifierRows).toHaveLength(1); expect(classifierRows[0]!.state).toBe("settled");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("failed classifier-selected model switch publishes no applied route and never dispatches main prompt", async () => {
  const f = fixture(); f.setFailSwitch();
  const runtime = await createOperatorRuntime({ ...f.opts, jev: { mode: "per_prompt", enabled: true, apiKey: "offline", fetch: classifier(() => {}) } });
  try {
    expect((await runtime.prompt("Implement a checked feature")).stopped).toBe("failed");
    expect(f.sequence).toContain("setModel"); expect(f.sequence).not.toContain("prompt");
    expect(f.events.some(event => event.type === "routing" && event.kind === "research")).toBe(false);
    const saved = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(saved.modelRef).toBe(f.initial()); expect(saved.step).not.toBe("research");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("cancellation during Jev classification prevents main dispatch", async () => {
  const f = fixture(); let announce!: () => void;
  const called = new Promise<void>(resolve => { announce = resolve; });
  const fetch = (() => { announce(); return new Promise(() => {}); }) as unknown as typeof globalThis.fetch;
  const runtime = await createOperatorRuntime({ ...f.opts, jev: { mode: "per_prompt", enabled: true, apiKey: "offline", fetch, timeoutMs: 1000 } });
  try {
    const work = runtime.prompt("Implement a checked feature"); await called; await runtime.cancel();
    expect((await work).stopped).toBe("paused");
    expect(f.sequence).not.toContain("prompt"); expect(f.sequence).not.toContain("setModel");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("insufficient classifier allocation skips fetch and continues existing model", async () => {
  const f = fixture(); let requests = 0;
  const runtime = await createOperatorRuntime({ ...f.opts, budgetUsd: 0.001, jev: { mode: "per_prompt", enabled: true, apiKey: "offline", fetch: classifier(() => requests++) } });
  try {
    expect((await runtime.prompt("Implement a checked feature")).stopped).toBe("completed");
    expect(requests).toBe(0); expect(f.sequence).toContain("prompt"); expect(f.sequence).not.toContain("setModel");
    expect(f.selected()).toBe(f.initial());
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test.each(["missing_key", "disabled", "low_confidence"] as const)("runtime %s retains active model and effort", async kind => {
  const f = fixture(); let requests = 0;
  const jev: NonNullable<OperatorRuntimeOptions["jev"]> = { mode: "per_prompt", enabled: kind !== "disabled", apiKey: kind === "missing_key" ? "" : "offline",
    fetch: classifier(() => requests++, 0.2) };
  const runtime = await createOperatorRuntime({ ...f.opts, jev });
  try {
    expect((await runtime.prompt("Implement a checked feature")).stopped).toBe("completed");
    expect(requests).toBe(kind === "low_confidence" ? 1 : 0);
    expect(f.sequence).toContain("prompt"); expect(f.sequence).not.toContain("setModel"); expect(f.sequence).not.toContain("setThinkingLevel");
    expect(f.selected()).toBe(f.initial());
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("runtime resume preserves consumed Jev cap and recorded cost", async () => {
  const f = fixture(); let requests = 0;
  const jev = { mode: "per_prompt" as const, enabled: true, apiKey: "offline", maxCalls: 1, fetch: classifier(() => requests++) };
  let runtime = await createOperatorRuntime({ ...f.opts, jev });
  try {
    expect((await runtime.prompt("Investigate first task")).stopped).toBe("completed");
    const runId = runtime.run.id;
    const before = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(before.jev.stats.attempts).toBe(1);
    await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.opts, runId, seed: undefined, jev });
    expect((await runtime.prompt("Investigate a different task")).stopped).toBe("completed");
    expect(requests).toBe(1);
    expect(rows(runtime.run.dir).filter(row => row.provider === "typesafe")).toHaveLength(1);
    const after = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(after.jev.stats.inputTokens).toBe(before.jev.stats.inputTokens);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("route_step auto uses classifier while an explicit independent review bypasses it", async () => {
  const f = fixture(); let requests = 0;
  const runtime = await createOperatorRuntime({ ...f.opts, jev: { mode: "per_prompt", enabled: true, apiKey: "offline", fetch: classifier(() => requests++, 0.2) } });
  try {
    expect((await runtime.prompt("Assess the task")).stopped).toBe("completed");
    expect(requests).toBe(1);
    const automatic = await f.invoke("auto", "Investigate uncertainty before selecting an approach");
    expect(requests).toBe(2);
    expect(automatic.content[0].text).toContain('"state":"unchanged"');
    const explicit = await f.invoke("review", "Independently assess the producer");
    expect(requests).toBe(2);
    expect(explicit.content[0].text).toContain('"state":"recommended_worker"');
    expect(f.sequence).not.toContain("setModel");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("in-flight Jev attempt is durable before transport completes and consumes the resumed call cap", async () => {
  const f = fixture(); let requests = 0, announce!: () => void;
  const called = new Promise<void>(resolve => { announce = resolve; });
  const fetch = ((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests++; announce();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof globalThis.fetch;
  const jev = { mode: "per_prompt" as const, enabled: true, apiKey: "offline", maxCalls: 1, timeoutMs: 1000, fetch };
  let runtime = await createOperatorRuntime({ ...f.opts, jev });
  try {
    const work = runtime.prompt("Investigate the first task"); await called;
    // This is the crash boundary: no response or finally block has updated usage yet.
    const pending = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(pending.jev.stats.attempts).toBe(1);
    expect(pending.jev.stats.inputTokens).toBe(0);
    expect(rows(runtime.run.dir).find(row => row.provider === "typesafe")?.state).toBe("reserved");
    const runId = runtime.run.id;
    await runtime.cancel(); expect((await work).stopped).toBe("paused");
    await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.opts, runId, seed: undefined, jev });
    expect((await runtime.prompt("Investigate another task")).stopped).toBe("completed");
    expect(requests).toBe(1);
    expect(rows(runtime.run.dir).filter(row => row.provider === "typesafe")).toHaveLength(1);
    expect(rows(runtime.run.dir).find(row => row.provider === "typesafe")?.state).toBe("unknown");
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("new default boundaries mode skips every submitted prompt but preserves explicit auto routing", async () => {
  const f = fixture(); let requests = 0;
  const runtime = await createOperatorRuntime({ ...f.opts, jev: { enabled: true, apiKey: "offline", fetch: classifier(() => requests++, 0.2) } });
  try {
    expect((await runtime.prompt("Investigate first task")).stopped).toBe("completed");
    expect((await runtime.prompt("Implement next task")).stopped).toBe("completed");
    expect(requests).toBe(0); expect(f.sequence.filter(value => value === "prompt")).toHaveLength(2);
    expect(f.sequence).not.toContain("setModel"); expect(f.sequence).not.toContain("setThinkingLevel");
    expect(JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8")).jev.mode).toBe("boundaries");
    const automatic = await f.invoke("auto", "Investigate uncertainty at this explicit work boundary");
    expect(requests).toBe(1); expect(automatic.content[0].text).toContain('"state":"unchanged"');
    await f.invoke("review", "Check the producer independently");
    expect(requests).toBe(1);
    expect(rows(runtime.run.dir).filter(row => row.provider === "typesafe")).toHaveLength(1);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("resume without a recorded mode preserves historical per-prompt classification", async () => {
  const f = fixture(); let requests = 0;
  const jev = { enabled: true, apiKey: "offline", fetch: classifier(() => requests++, 0.2) };
  let runtime = await createOperatorRuntime({ ...f.opts, jev: { ...jev, mode: "per_prompt" } });
  try {
    await runtime.prompt("First task"); expect(requests).toBe(1);
    const runId = runtime.run.id, path = join(runtime.run.dir, "operator.json");
    await runtime.dispose();
    const legacy = JSON.parse(readFileSync(path, "utf8")); delete legacy.jev.mode; writeFileSync(path, JSON.stringify(legacy));
    runtime = await createOperatorRuntime({ ...f.opts, runId, seed: undefined, jev });
    expect(JSON.parse(readFileSync(path, "utf8")).jev.mode).toBe("per_prompt");
    expect((await runtime.prompt("Different resumed task")).stopped).toBe("completed");
    expect(requests).toBe(2);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});
