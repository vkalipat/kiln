import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { createOperatorRuntime, type OperatorEvent } from "../../src/operator/runtime";
import { createOmpSession, type OmpSessionHandle } from "../../src/operator/session";
import { AuthStore } from "../../src/providers/auth";
import { initHome } from "../../src/core/home";
import { readStatus } from "../../src/core/run";

const usage = { input: 20, output: 10 };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-operator-runtime-")); initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("anthropic", "synthetic-test-key");
  return { home, auth };
}

test("real native operator runs tools, retains shared context and follows up in one session", async () => {
  const { home, auth } = fixture(); const events: OperatorEvent[] = [];
  let liveUsageMatched = false;
  writeFileSync(join(home, "input.txt"), "native evidence");
  const model = createMockModel({ id: "claude-fable-5-1", provider: "anthropic", responses: [
    { content: [{ type: "toolCall", name: "read", arguments: { path: "input.txt" } }], usage },
    { content: [{ type: "toolCall", name: "context_publish", arguments: { id: "finding", kind: "fact", text: "native evidence was read" } }], usage },
    { content: [{ type: "toolCall", name: "write", arguments: { path: "answer.txt", content: "checked" } }], usage },
    { content: ["The checked artifact is written."], usage },
    { content: [{ type: "toolCall", name: "context_query", arguments: { step: "synthesize" } }], usage },
    { content: ["The retained finding is still available."], usage },
  ] as never });
  let created = 0;
  const runtime = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, seed: " Read input.txt and write a checked artifact.\n", auth, onEvent: event => {
    events.push(event);
    if (event.type === "usage" && event.costUsd > 0) {
      expect(readStatus(runtime.run).usdSpent).toBe(event.costUsd);
      liveUsageMatched = true;
    }
  },
    createSession: options => { created++; return createOmpSession({ ...options, model: model as never, streamFn: streamMock as never, contextFiles: [] }); } });
  try {
    const first = await runtime.prompt("Read input.txt and write a checked artifact.");
    expect(first).toMatchObject({ stopped: "completed", taskQualityValidated: false });
    expect(readFileSync(join(home, "answer.txt"), "utf8")).toBe("checked");
    const second = await runtime.prompt("Keep the artifact; explain the retained finding.");
    expect(second.stopped).toBe("completed");
    expect(created).toBe(1);
    expect(model.calls).toHaveLength(6);
    expect(JSON.stringify(model.calls.at(-1)?.context)).toContain("native evidence was read");
    expect(readFileSync(runtime.run.seed, "utf8")).toBe(" Read input.txt and write a checked artifact.\n");
    expect(events.some(event => event.type === "tool_start" && event.name === "context_publish")).toBe(true);
    expect(readStatus(runtime.run).state).toBe("done");
    expect(liveUsageMatched).toBe(true);
    const meter = JSON.parse(readFileSync(join(runtime.run.dir, "operator-meter.json"), "utf8"));
    expect(meter.rows).toHaveLength(6);
    expect(meter.rows.every((row: { state: string }) => row.state === "settled")).toBe(true);
    const stored = JSON.parse(readFileSync(join(runtime.run.dir, "operator-context.json"), "utf8"));
    expect(stored.entries.filter((entry: { owner: string }) => entry.owner === "user")).toHaveLength(2);
  } finally { await runtime.dispose(); }
}, 30_000);

test("startup steering is retained while native SDK initialization is still pending", async () => {
  const { home, auth } = fixture(); let release!: () => void, initializing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { initializing = resolve; });
  const model = createMockModel({ id: "claude-fable-5-1", provider: "anthropic", responses: [{ content: ["Revised task handled."], usage }] as never });
  const runtime = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, seed: "Inspect the local task.", auth,
    createSession: async options => { initializing(); await gate; return createOmpSession({ ...options, model: model as never, streamFn: streamMock as never, contextFiles: [] }); } });
  try {
    const work = runtime.prompt("Inspect the local task."); await started;
    expect(await runtime.steer("Retain this exact startup direction.")).toMatchObject({ status: "delivered" });
    const before = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(before.pendingSteering[0].text).toBe("Retain this exact startup direction.");
    release();
    expect((await work).stopped).toBe("completed");
    expect(model.calls).toHaveLength(1);
    expect(JSON.stringify(model.calls.map(call => call.context.messages))).toContain("Retain this exact startup direction.");
    expect(JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8")).pendingSteering).toEqual([]);
  } finally { release(); await runtime.dispose(); }
}, 30_000);

test("cancellation during native startup makes no provider call and preserves the acknowledged direction", async () => {
  const { home, auth } = fixture(); let release!: () => void, initializing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { initializing = resolve; });
  const model = createMockModel({ id: "claude-fable-5-1", provider: "anthropic", responses: [{ content: ["must not run"], usage }] as never });
  const runtime = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, seed: "Inspect the local task.", auth,
    createSession: async options => { initializing(); await gate; return createOmpSession({ ...options, model: model as never, streamFn: streamMock as never, contextFiles: [] }); } });
  try {
    const work = runtime.prompt("Inspect the local task."); await started;
    await runtime.steer("Keep this direction for resume.");
    const cancel = runtime.cancel(); release(); await cancel;
    expect((await work).stopped).toBe("paused");
    expect(model.calls).toHaveLength(0);
    const meta = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    expect(meta.pendingSteering[0].text).toBe("Keep this direction for resume.");
    expect(readStatus(runtime.run).state).toBe("paused");
  } finally { release(); await runtime.dispose(); }
}, 30_000);
