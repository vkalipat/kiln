import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { contextInputHash, createBrain } from "../../src/brain/agent";
import { brainTools, type ToolContext } from "../../src/brain/tools";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { StallDetector } from "../../src/core/failure";
import type { Role } from "../../src/core/config";
import { defaultConfig } from "../../src/core/config";
import { RunCancelledError, RunControl, withRunControl, type RunControlEvent } from "../../src/core/run-control";

function setup(responses: unknown[], turnCap = 5, modelOpts: Record<string, unknown> = {}, role: Role = "brain") {
  const home = mkdtempSync(join(tmpdir(), "kiln-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const exits: string[] = [];
  const tools: Array<{ toolCallId: string; name: string; args: unknown; phase: "start" | "end"; ok?: boolean; excerpt?: string }> = [];
  const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record, onExit: (k) => exits.push(k) };
  const model = createMockModel({ id: "mock-brain", responses: responses as never, ...modelOpts });
  if (modelOpts.compat !== undefined) Object.assign(model, { compat: modelOpts.compat });
  if (modelOpts.thinking !== undefined) Object.assign(model, { thinking: modelOpts.thinking });
  const cfg = defaultConfig();
  const brain = createBrain({ model: model as never, tools: brainTools(ctx, "frame"), systemPrompt: ["kernel", "brain"], pinned: "contract v1", record, role, phase: "frame", turnCap, effort: cfg.effortByRole?.[role] ?? cfg.effort, streamFn: streamMock as never, shaping: { cfg, runId: run.id }, onTool: (e) => tools.push(e) });
  return { brain, record, exits, run, tools, model };
}

const modelCalls = (record: RunRecord) => record.read().filter((e) => e.t === "model.call") as Array<Extract<import("../../src/core/record").StoredEvent, { t: "model.call" }>>;

describe("createBrain", () => {
  test("records model calls and returns final text", async () => {
    const { brain, record } = setup([{ content: [{ type: "toolCall", name: "note", arguments: { text: "n" } }], usage: { input: 5, output: 2 } }, { content: ["all done"], usage: { input: 7, output: 3 } }]);
    const r = await brain.run("go");
    expect(r.text).toBe("all done"); expect(r.stopped).toBe("done"); expect(r.turns).toBe(2);
    const calls = record.read().filter((e) => e.t === "model.call");
    expect(calls.length).toBe(2); expect(calls[0]!.t === "model.call" && calls[0]!.usage.input).toBe(5);
    expect(calls.every((call) => call.t === "model.call" && call.fallbackServed === false)).toBe(true);
    expect(brain.agent.state.systemPrompt.at(-1)).toBe("## Pinned\ncontract v1");
  });
  test("returns structured refusals without retrying and journals their category", async () => {
    for (const type of ["refusal", "sensitive"] as const) {
      const { brain, record, model } = setup([{
        stopReason: "error",
        stopDetails: { type, category: "safety" },
        errorMessage: "request refused",
      }]);
      const result = await brain.run("go");
      expect(result).toMatchObject({ stopped: "refused", error: "request refused", stopDetails: { type, category: "safety" } });
      expect(model.calls).toHaveLength(1);
      expect(modelCalls(record)).toHaveLength(1);
      expect(modelCalls(record)[0]).toMatchObject({ stopDetails: { type, category: "safety" }, fallbackServed: false });
    }
  });
  test("freezes family addenda before the pinned block and journals their hash with actual effort", async () => {
    const { brain, record, model } = setup([{ content: ["done"] }], 5, {
      id: "claude-fable-5-1",
      thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] },
    });
    await brain.run("go");
    const system = model.calls[0]!.context.systemPrompt as string[];
    expect(system.at(-1)).toBe("## Pinned\ncontract v1");
    expect(system.at(-2)).toContain("When you have enough information to act, act.");
    const call = modelCalls(record)[0]!;
    expect(call.addendaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(call.effortSent).toBe("high");
    if (!call.effortSent) throw new Error("model call omitted actual effort");
    const options = model.calls[0]?.options;
    if (!options) throw new Error("mock did not record request options");
    expect(String(options.reasoning)).toBe(call.effortSent);
  });
  test("costUsd is this run's own calls, and it resets between runs", async () => {
    const cost = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
    const { brain, record } = setup(
      [
        { content: [{ type: "toolCall", name: "note", arguments: { text: "n" } }], usage: { input: 1000, output: 1000 } },
        { content: ["first"], usage: { input: 1000, output: 1000 } },
        { content: ["second"], usage: { input: 1000, output: 1000 } },
      ],
      5,
      { cost },
    );
    const first = await brain.run("go");
    const calls = modelCalls(record);
    expect(first.costUsd).toBeGreaterThan(0);
    // The two calls this run made, and nothing else: the number comes from inside the brain, so a
    // concurrently running seat appending to the same journal cannot inflate it.
    expect(first.costUsd).toBeCloseTo(calls[0]!.costUsd + calls[1]!.costUsd, 12);
    const second = await brain.run("again");
    expect(second.costUsd).toBeCloseTo(modelCalls(record)[2]!.costUsd, 12);
    expect(second.costUsd).toBeLessThan(first.costUsd);
  });
  test("exit tool ends the run with stopped=exit", async () => {
    const { brain, exits, record } = setup([{ content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["r"] } }] }, { content: ["ok"] }]);
    const r = await brain.run("go");
    expect(r.stopped).toBe("exit"); expect(exits).toEqual(["underspecified"]);
    // Exit must end the run before another model call: one turn, one recorded model call, no phantom aborted call.
    expect(r.turns).toBe(1);
    expect(record.read().filter((e) => e.t === "model.call").length).toBe(1);
  });
  test("turn cap stops a looping agent", async () => {
    const loop = Array.from({ length: 20 }, () => ({ content: [{ type: "toolCall", name: "note", arguments: { text: "again" } }] }));
    const { brain, model, record } = setup(loop);
    const r = await brain.run("go");
    expect(r.stopped).toBe("turn_cap"); expect(r.turns).toBe(5);
    expect(model.calls).toHaveLength(5);
    expect(modelCalls(record)).toHaveLength(5);
  });
  test("provider contexts extend an unchanged prefix without rewriting prior messages", async () => {
    const responses = [
      ...Array.from({ length: 9 }, (_, index) => ({ content: [{ type: "toolCall", name: "note", arguments: { text: `n${index}` } }] })),
      { content: ["done"] },
    ];
    const { brain, model } = setup(responses, 12);
    await brain.run("go");
    expect(model.calls).toHaveLength(10);
    const system = JSON.stringify(model.calls[0]!.context.systemPrompt);
    for (let index = 1; index < model.calls.length; index += 1) {
      const previous = model.calls[index - 1]!.context.messages;
      const current = model.calls[index]!.context.messages;
      expect(JSON.stringify(current.slice(0, previous.length))).toBe(JSON.stringify(previous));
      expect(JSON.stringify(model.calls[index]!.context.systemPrompt)).toBe(system);
    }
  });
  test("one reminder follows a complete parallel tool-result batch", async () => {
    const calls = [1, 2, 3].map((index) => ({ type: "toolCall", id: `note-${index}`, name: "note", arguments: { text: `n${index}` } }));
    const { brain, model } = setup([{ content: calls }, { content: ["done"] }], 10, {
      id: "claude-fable-5-1",
    });
    Object.assign(model, { compat: { supportsTurnScopedSystem: true } });
    await brain.run("go");
    const roles = model.calls[1]!.context.messages.map((message: { role: string }) => message.role);
    expect(roles.slice(-4)).toEqual(["toolResult", "toolResult", "toolResult", "developer"]);
    expect(JSON.stringify(model.calls[1]!.context.messages).match(/First privately list/g)).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
  });
  test("the near-cap reminder is nonnumeric and uses the user fallback", async () => {
    const { brain, model } = setup([
      { content: [{ type: "toolCall", name: "note", arguments: { text: "n" } }] },
      { content: ["done"] },
    ], 4, { id: "claude-fable-5-1", compat: { supportsTurnScopedSystem: false } });
    await brain.run("go");
    const last = model.calls[1]!.context.messages.at(-1) as { role: string; content: unknown };
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Wrap up: finish the current step");
    expect(JSON.stringify(last.content)).not.toMatch(/\d/);
  });
  test("sends clamped reasoning without sampling or forced tool-choice options", async () => {
    const { brain, model } = setup([{ content: ["done"] }], 5, {
      thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
    });
    await brain.run("go");
    const options = model.calls[0]?.options;
    expect(options).toBeDefined();
    if (!options) throw new Error("mock did not record request options");
    expect(String(options.reasoning)).toBe("high");
    expect(options.temperature).toBeUndefined();
    expect(options.topP).toBeUndefined();
    expect(options.topK).toBeUndefined();
    expect(options.toolChoice).toBeUndefined();
  });
  test("a producer-side tool-result abort prevents the next model call", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record };
    const repeated = Array.from({ length: 5 }, () => ({ content: [{ type: "toolCall", name: "note", arguments: { text: "same" } }] }));
    const model = createMockModel({ id: "m", responses: repeated as never });
    const detector = new StallDetector(3);
    const brain = createBrain({
      model: model as never,
      tools: brainTools(ctx, "frame"),
      systemPrompt: ["kernel"],
      pinned: "contract",
      record,
      role: "brain",
      phase: "frame",
      turnCap: 10,
      streamFn: streamMock as never,
      afterTool: (event) => detector.observe(event.name, event.excerpt ?? ""),
    });
    await brain.run("go");
    expect(record.read().filter((event) => event.t === "model.call").length).toBe(3);
    expect(model.calls.length).toBe(3);
    expect(detector.tool).toBe("note");
  });
  test("pushContract appends a developer contract while the system prompt stays frozen", async () => {
    const { brain, model } = setup([{ content: ["first"] }, { content: ["second"] }]);
    const frozen = JSON.stringify(brain.agent.state.systemPrompt);
    brain.pushContract("contract v2");
    await brain.run("first feature");
    await brain.run("second feature");
    expect(JSON.stringify(brain.agent.state.systemPrompt)).toBe(frozen);
    expect(model.calls[0]!.context.systemPrompt).toEqual(model.calls[1]!.context.systemPrompt);
    expect(model.calls[0]!.context.messages.map((message: { role: string }) => message.role)).toEqual(["user", "developer"]);
    expect(JSON.stringify(model.calls[0]!.context.messages)).toContain("contract v2");
  });
  test("the turn-cap abort records no phantom model call", async () => {
    const loop = Array.from({ length: 10 }, () => ({ content: [{ type: "toolCall", name: "note", arguments: { text: "again" } }] }));
    const { brain, record, model } = setup(loop, 3);
    const r = await brain.run("go");
    expect(r.stopped).toBe("turn_cap");
    const calls = record.read().filter((e) => e.t === "model.call");
    expect(calls.length).toBe(3); // one per real turn, none for the aborted gate message
    expect(model.calls).toHaveLength(3);
    expect(calls.some((e) => e.t === "model.call" && e.stopReason === "aborted")).toBe(false);
    expect(record.read().filter((e) => e.t === "turn").length).toBe(3);
  });
  test("prior spend plus current-session cost stops at the next usd-cap boundary", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record };
    const model = createMockModel({
      id: "priced",
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      responses: [
        { content: [{ type: "toolCall", name: "note", arguments: { text: "one paid turn" } }], usage: { input: 1000, output: 1000 } },
        { content: ["must not be dispatched"], usage: { input: 1000, output: 1000 } },
      ] as never,
    });
    const brain = createBrain({
      model: model as never,
      tools: brainTools(ctx, "frame"),
      systemPrompt: ["kernel"],
      pinned: "contract",
      record,
      role: "brain",
      phase: "frame",
      turnCap: 10,
      usdCap: 0.02,
      spentUsd: () => 0.005,
      streamFn: streamMock as never,
    });
    const result = await brain.run("go");
    expect(result.stopped).toBe("usd_cap");
    expect(result.costUsd).toBeGreaterThan(0.015);
    expect(record.read().filter((event) => event.t === "model.call").length).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(record.read().some((event) => event.t === "model.call" && event.stopReason === "aborted")).toBe(false);
    expect(record.read().filter((event) => event.t === "turn").length).toBe(1);
  });
  test("inputHash is identical for two identical prompts and differs for a different one", async () => {
    const a = setup([{ content: ["done"] }]);
    await a.brain.run("go");
    const b = setup([{ content: ["done"] }]);
    await b.brain.run("go");
    const c = setup([{ content: ["done"] }]);
    await c.brain.run("something else");
    const hash = (r: RunRecord) => modelCalls(r)[0]!.inputHash;
    expect(hash(a.record)).toBe(hash(b.record));
    expect(hash(c.record)).not.toBe(hash(a.record));
    expect(hash(a.record).length).toBe(64);
  });

  test("each recorded call counts its provider attempts", async () => {
    const { brain, record } = setup([{ content: [{ type: "toolCall", name: "note", arguments: { text: "n" } }] }, { content: ["done"] }]);
    await brain.run("go");
    expect(modelCalls(record).map((e) => e.requests)).toEqual([1, 1]);
  });

  test("onTool end events carry the result excerpt", async () => {
    const { brain, tools } = setup([{ content: [{ type: "toolCall", name: "note", arguments: { text: "remember this" } }] }, { content: ["done"] }]);
    await brain.run("go");
    const end = tools.find((e) => e.phase === "end");
    expect(end?.name).toBe("note");
    expect(end?.excerpt).toContain("note");
    expect(tools.find((e) => e.phase === "start")?.excerpt).toBeUndefined();
  });

  test("context pressure is reported when the window fills", async () => {
    const under = setup([{ content: ["done"], usage: { input: 10 } }], 5, { contextWindow: 1000 });
    expect((await under.brain.run("go")).contextPressure).toBeUndefined();
    const over = setup([{ content: ["done"], usage: { input: 900 } }], 5, { contextWindow: 1000 });
    expect((await over.brain.run("go")).contextPressure).toBe(true);
  });

  test("a null context window disables the check and is noted once", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record };
    const model = createMockModel({ id: "m", responses: [{ content: [{ type: "toolCall", name: "note", arguments: { text: "n" } }], usage: { input: 900 } }, { content: ["done"], usage: { input: 900 } }] as never });
    Object.defineProperty(model, "contextWindow", { value: null });
    const brain = createBrain({ model: model as never, tools: brainTools(ctx, "frame"), systemPrompt: ["k"], pinned: "p", record, role: "brain", phase: "frame", turnCap: 5, streamFn: streamMock as never });
    const r = await brain.run("go");
    expect(r.contextPressure).toBeUndefined();
    expect(record.read().filter((e) => e.t === "note" && e.text.includes("context window")).length).toBe(1);
  });

  test("lastText does not leak from one run into the next", async () => {
    const { brain } = setup([{ content: ["first answer"] }, { content: ["never reached"] }], 1);
    const first = await brain.run("go");
    expect(first.text).toBe("first answer");
    const second = await brain.run("go again");
    expect(second.stopped).toBe("turn_cap");
    expect(second.text).toBe("");
  });

  test("a pre-cancelled ambient run never dispatches the provider", async () => {
    const { brain, model, record } = setup([{ content: ["must not run"] }]);
    const control = new RunControl();
    control.cancel("cancel before dispatch");
    await expect(withRunControl(control, () => brain.run("go"))).rejects.toBeInstanceOf(RunCancelledError);
    expect(model.calls).toHaveLength(0);
    expect(record.read().filter((event) => event.t === "turn" || event.t === "model.call")).toHaveLength(0);
    expect(control.steer("late")).toEqual([]);
  });

  test("concurrent brains emit distinct correlated source and tool events, then clean up", async () => {
    const a = setup([
      { delayMs: 20, content: [{ type: "toolCall", id: "same-call", name: "note", arguments: { text: "A note" } }] },
      { delayMs: 20, content: ["answer A"] },
    ]);
    const b = setup([
      { delayMs: 5, content: [{ type: "toolCall", id: "same-call", name: "note", arguments: { text: "B note" } }] },
      { delayMs: 5, content: ["answer B"] },
    ]);
    const control = new RunControl();
    const events: RunControlEvent[] = [];
    control.subscribe((event) => events.push(event));
    await withRunControl(control, () => Promise.all([a.brain.run("go A"), b.brain.run("go B")]));
    const aText = events.find((event) => event.type === "text" && event.text.includes("answer A"));
    const bText = events.find((event) => event.type === "text" && event.text.includes("answer B"));
    expect(aText?.sourceId).toBeTruthy();
    expect(bText?.sourceId).toBeTruthy();
    expect(aText?.sourceId).not.toBe(bText?.sourceId);
    for (const textEvent of [aText, bText]) {
      const paired = events.filter((event) => event.sourceId === textEvent?.sourceId && event.type.startsWith("tool_"));
      expect(paired.map((event) => event.type)).toEqual(["tool_start", "tool_end"]);
      expect(paired.every((event) => "toolCallId" in event && event.toolCallId === "same-call")).toBe(true);
    }
    expect(control.steer("late")).toEqual([]);
    const eventCount = events.length;
    a.model.push({ content: ["outside the control"] });
    await a.brain.run("again");
    expect(events).toHaveLength(eventCount);
  });

  test("cancellation aborts every concurrent brain and exposes only primary roles for steering", async () => {
    const primary = setup([{ delayMs: 5_000, content: ["late primary"] }]);
    const scout = setup([{ delayMs: 5_000, content: ["late scout"] }], 5, {}, "scout");
    const control = new RunControl();
    const pending = withRunControl(control, () => Promise.allSettled([primary.brain.run("go"), scout.brain.run("go")]));
    while (primary.model.calls.length === 0 || scout.model.calls.length === 0) await Bun.sleep(1);
    expect(control.steer("operator direction")).toEqual(["frame:brain:1"]);
    control.cancel("operator stop");
    const settled = await pending;
    expect(settled.every((result) => result.status === "rejected" && result.reason instanceof RunCancelledError)).toBe(true);
    expect(primary.model.calls).toHaveLength(1);
    expect(scout.model.calls).toHaveLength(1);
    expect(control.steer("late")).toEqual([]);
  });

  test("a cancelled attempt leaves no request metadata in a later run", async () => {
    const { brain, model, record } = setup([
      { delayMs: 5_000, content: ["cancelled"] },
      { content: ["recovered"] },
    ]);
    const control = new RunControl();
    const cancelled = withRunControl(control, () => brain.run("first"));
    while (model.calls.length === 0) await Bun.sleep(1);
    await Bun.sleep(1);
    control.cancel();
    await expect(cancelled).rejects.toBeInstanceOf(RunCancelledError);
    const recovered = await brain.run("second");
    expect(recovered.text).toBe("recovered");
    expect(modelCalls(record).at(-1)?.requests).toBe(1);
    expect(model.calls).toHaveLength(2);
  });

  test("rejects a second concurrent run before mutating the active run", async () => {
    const { brain } = setup([{ delayMs: 20, content: ["first"] }]);
    const first = brain.run("first");
    await expect(brain.run("second")).rejects.toThrow("already running");
    expect((await first).text).toBe("first");
  });
});

describe("contextInputHash", () => {
  const ctx = (messages: unknown[], tools = ["read"]) => ({ systemPrompt: ["sys"], messages: messages as never, tools: tools.map((name) => ({ name })) as never });

  test("ignores ids and timestamps, so two identical payloads hash alike", () => {
    const a = ctx([{ role: "user", content: "go", timestamp: 1 }, { role: "toolResult", toolCallId: "a1", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 2 }]);
    const b = ctx([{ role: "user", content: "go", timestamp: 99 }, { role: "toolResult", toolCallId: "zz", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 100 }]);
    expect(contextInputHash(a)).toBe(contextInputHash(b));
  });

  test("changes when provider-visible tool-result content changes", () => {
    const before = ctx([{ role: "toolResult", toolCallId: "a1", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 2 }]);
    const after = ctx([{ role: "toolResult", toolCallId: "a1", toolName: "read", content: [{ type: "text", text: "[pruned: re-run read if needed]" }], isError: false, timestamp: 2 }]);
    expect(contextInputHash(before)).not.toBe(contextInputHash(after));
  });

  test("changes when the tool list or the system prompt changes", () => {
    const base = ctx([{ role: "user", content: "go", timestamp: 1 }]);
    expect(contextInputHash({ ...base, tools: [{ name: "read" }, { name: "write" }] as never })).not.toBe(contextInputHash(base));
    expect(contextInputHash({ ...base, systemPrompt: ["other"] })).not.toBe(contextInputHash(base));
  });
});
