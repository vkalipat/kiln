import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel, type Model } from "@oh-my-pi/pi-catalog";
import { createAssistantMessageEventStream, streamSimple } from "@oh-my-pi/pi-ai";
import { createOmpSession } from "../../src/operator/session";
import { createOperatorMeter, operatorReservation } from "../../src/operator/meter";
import { OperatorBudget, OperatorBudgetError } from "../../src/operator/budget";

const model = { ...getBundledModel("anthropic", "claude-opus-5")!, maxTokens: 100, contextWindow: 1000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } as Model;
const billed = () => ({ input: 10, output: 10, cacheRead: 2, cacheWrite: 0, totalTokens: 22,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function setup(limit: number | null = 1, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kiln-operator-meter-")); const violations: Error[] = [];
  const meter = createOperatorMeter({ run: { id: "test", dir }, limitUsd: limit, models: [model], onViolation: e => violations.push(e), ...extra });
  const attach = (sid: string) => {
    const handlers = new Map<string, Function>(); const entries: any[] = [];
    let aborted = false;
    const ctx: any = { model, abort: () => { aborted = true; }, sessionManager: { getSessionId: () => sid, getEntries: () => entries } };
    meter.extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as never);
    const emit = (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
    return { emit, entries, ctx, aborted: () => aborted };
  };
  return { meter, attach, dir, violations };
}
const request = { payload: { model: model.id, max_tokens: 100, messages: [{ content: "PRIVATE_SENTINEL" }] } };
const response = () => ({ message: { role: "assistant", model: model.id, provider: model.provider, usage: billed(), stopReason: "stop" } });

test("parent and rebound child extensions share one exposure ledger without payload leakage", async () => {
  const s = setup(), parent = s.attach("parent"), child = s.attach("child");
  await parent.emit("before_provider_request", request); await child.emit("before_provider_request", request);
  expect(s.meter.usage().rows).toHaveLength(2);
  expect(s.meter.usage().chargedUsd).toBeCloseTo(operatorReservation(model, request.payload).reservedUsd * 2);
  await parent.emit("message_end", response()); await child.emit("message_end", response());
  expect(s.meter.usage().rows.every(row => row.state === "settled")).toBe(true);
  expect(s.meter.usage().knownCostUsd).toBeCloseTo(0.0000604);
  expect(readFileSync(join(s.dir, "operator-meter.json"), "utf8")).not.toContain("PRIVATE_SENTINEL");
  expect(s.violations).toHaveLength(0); await s.meter.close();
});
test("Codex output reserve ignores requested2048 and tool-free payloads remain valid", () => {
  const astra = getBundledModel("openai-codex", "gpt-6-astra")!;
  expect(operatorReservation(astra, { model: astra.id, max_tokens: 2048, tools: [] }).reservedUsd).toBeGreaterThan(6.4);
  expect(() => operatorReservation(model, { model: "wrong" })).toThrow();
});
test("errors retain worst reservation and resumes cannot reset charges", async () => {
  const s = setup(), session = s.attach("session");
  await session.emit("before_provider_request", request);
  const reserved = s.meter.usage().chargedUsd;
  const error = response(); error.message.stopReason = "error";
  await session.emit("message_end", error); expect(s.meter.usage().chargedUsd).toBe(reserved);
  expect(s.violations).toHaveLength(0); // Native refusal/error policy remains authoritative.
  await s.meter.close();
  const resumed = createOperatorMeter({ run: { id: "test", dir: s.dir }, limitUsd: 1, models: [model], onViolation: () => {} });
  expect(resumed.usage().chargedUsd).toBe(reserved); await resumed.close();
});
test("growing JSON context no longer mistakes bytes for tokens or resets prior charges", async () => {
  const astra = getBundledModel("openai-codex", "gpt-6-astra")!;
  const payload = { model: astra.id, context: { messages: [{ role: "user", content: "scientific context ".repeat(40000) }] } };
  const estimate = operatorReservation(astra, payload), prior = 7.4992415;
  const oldReserve = ((Buffer.byteLength(JSON.stringify(payload)) + 65536 + 8192) * 20 + 128000 * 50) / 1e6;
  expect(oldReserve).toBeGreaterThan(25 - prior); expect(estimate.reservedUsd).toBeLessThan(25 - prior);
  expect(estimate.reservedOutputTokens).toBe(128000);
  expect(estimate.inputTokensEstimated).toBe(Math.ceil(estimate.inputTokensCounted * 1.25) + 8192);
  expect(estimate.inputEstimateMethod).toContain("o200k_base-proxy");
  expect(operatorReservation({ ...astra, contextWindow: 10 }, payload).reservedUsd).toBe(estimate.reservedUsd);
  const budget = new OperatorBudget(25, prior), ticket = await budget.acquire(estimate.reservedUsd);
  ticket.settle(0.2); expect(budget.chargedUsd).toBeCloseTo(prior + 0.2);
});
test("budget denial exposes requested and available estimated exposure", async () => {
  const budget = new OperatorBudget(25, 7.4992415);
  try { await budget.acquire(18); throw new Error("expected denial"); }
  catch (error) {
    expect(error).toBeInstanceOf(OperatorBudgetError);
    expect((error as OperatorBudgetError).details).toEqual({ requestedUsd: 18, availableUsd: 17.5007585, chargedUsd: 7.4992415, limitUsd: 25 });
    expect((error as Error).message).toContain("requested $18.000000, available $17.500758");
  }
});
test("denial aborts session AND host instead of relying on swallowed extension exceptions", async () => {
  const s = setup(0.00001), session = s.attach("session");
  await expect(session.emit("before_provider_request", request)).rejects.toThrow();
  expect(session.aborted()).toBe(true); expect(s.violations).toHaveLength(1); expect(s.meter.usage().rows).toHaveLength(0);
  await s.meter.close();
});
test("FIFO waits for in-flight headroom and cancelled queued work takes no reservation", async () => {
  const budget = new OperatorBudget(1), first = await budget.acquire(0.8), abort = new AbortController();
  const waiting = budget.acquire(0.5, abort.signal); abort.abort(new Error("child cancelled"));
  await expect(waiting).rejects.toThrow("child cancelled"); first.settle(0.1);
  expect(budget.chargedUsd).toBe(0.1); expect(budget.activeCount).toBe(0);
});
test("native queued child cancellation does not abort unrelated sessions or retain a new ticket", async () => {
  const s = setup(0.025), parent = s.attach("parent"), child = s.attach("child"), cancelled = new AbortController();
  expect(await s.meter.beforeModelCall(parent.ctx, { messages: [] })).toBe(true);
  const waiting = s.meter.beforeModelCall(child.ctx, { messages: [] }, cancelled.signal);
  cancelled.abort(new Error("child scope stopped")); expect(await waiting).toBe(false);
  expect(s.meter.signal.aborted).toBe(false); expect(s.violations).toHaveLength(0); expect(s.meter.usage().rows).toHaveLength(1);
  await s.meter.close();
});
test("payload-hook queue watchdog aborts before the SDK can swallow its30second timeout", async () => {
  const s = setup(0.025, { hookWaitMs: 5 }), parent = s.attach("parent"), child = s.attach("child");
  await parent.emit("before_provider_request", request);
  await expect(child.emit("before_provider_request", request)).rejects.toThrow();
  expect(s.violations[0]?.message).toContain("hook deadline"); expect(child.aborted()).toBe(true);
  await s.meter.close();
});
test("compaction pre-reserve covers before hook and durable usage once", async () => {
  const s = setup(), session = s.attach("session");
  await session.emit("session_before_compact");
  const before = s.meter.usage().chargedUsd;
  await session.emit("before_provider_request", request);
  expect(s.meter.usage().rows).toHaveLength(1); // Exact payload top-up reuses pre-reserve, never takes a second full slot.
  expect(s.meter.usage().chargedUsd).toBeGreaterThan(before);
  session.entries.push({ id: "maintenance1", type: "model_usage", provider: model.provider, model: model.id, usage: billed(), stopReason: "stop" });
  await session.emit("session_compact", { compactionEntry: { id: "compact1" }, fromExtension: false });
  expect(s.meter.usage().rows).toHaveLength(1);
  expect(s.meter.usage().chargedUsd).toBeCloseTo(0.0000302);
  await session.emit("session_compact", { compactionEntry: { id: "compact1" }, fromExtension: true });
  expect(s.meter.usage().chargedUsd).toBeCloseTo(0.0000302); await s.meter.close();
});
test("legacy workers share SDK FIFO and account final wire without double counting", async () => {
  let dispatched = 0;
  const s = setup(0.025, {
    fetchImpl: async () => { dispatched++; return new Response("ok"); },
    streamImpl: (_model: any, _context: any, options: any) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try { await options.fetch("https://example.invalid", { body: JSON.stringify(request.payload) });
          stream.push({ type: "done", reason: "stop", message: response().message as never });
        } catch (error) { stream.fail(error); }
      }); return stream;
    },
  });
  const parent = s.attach("parent"); await parent.emit("before_provider_request", request);
  const legacy = await s.meter.streamFn(model, { messages: [] } as never, {});
  await Promise.resolve(); expect(dispatched).toBe(0);
  await parent.emit("message_end", response()); await legacy.result();
  expect(dispatched).toBe(1); expect(s.meter.usage().rows.map(row => row.lane)).toEqual(["sdk", "legacy"]);
  await s.meter.close(); expect(s.meter.usage().chargedUsd).toBeCloseTo(0.0000604);
});
test("multiple admitted compaction calls reconcile durable usage without double-counting", async () => {
  const s = setup(), session = s.attach("compact-multi"); await session.emit("session_before_compact");
  await session.emit("before_provider_request", request); await session.emit("before_provider_request", request);
  for (const id of ["a", "b"]) session.entries.push({ id, type: "model_usage", provider: model.provider, model: model.id, usage: billed(), stopReason: "stop" });
  await session.emit("session_compact", { compactionEntry: {}, fromExtension: false });
  expect(s.meter.usage().rows).toHaveLength(2); expect(s.meter.usage().rows.every(row => row.state === "settled")).toBe(true);
  expect(s.meter.usage().chargedUsd).toBeCloseTo(0.0000604); expect(s.violations).toHaveLength(0); await s.meter.close();
});
test("multiple request hooks before one response retain earlier retry exposure", async () => {
  const s = setup(), session = s.attach("retry");
  await session.emit("before_provider_request", request); await session.emit("before_provider_request", request);
  await session.emit("message_end", response());
  expect(s.meter.usage().rows.map(row => row.state)).toEqual(["unknown", "settled"]);
  expect(s.meter.usage().chargedUsd).toBeGreaterThan(operatorReservation(model, request.payload).reservedUsd);
  await s.meter.close();
});
test("uncovered maintenance costs are recorded and flagged instead of inventing a hard ceiling", async () => {
  const s = setup(), session = s.attach("session");
  session.entries.push({ id: "outside", type: "model_usage", provider: model.provider, model: model.id, usage: billed(), stopReason: "stop" });
  await session.emit("session_start");
  expect(s.meter.usage().chargedUsd).toBeCloseTo(0.0000302); expect(s.meter.usage().gaps).toHaveLength(1);
  expect(s.violations).toHaveLength(1); await s.meter.close();
  const saved = JSON.parse(readFileSync(join(s.dir, "operator-meter.json"), "utf8")); expect(saved.chargedUsd).toBeCloseTo(0.0000302);
});
test("unknown compaction retains its maximum reservation and stops with a coverage gap", async () => {
  const s = setup(), session = s.attach("session"); await session.emit("session_before_compact");
  const reserved = s.meter.usage().chargedUsd;
  await session.emit("session_compact", { compactionEntry: {}, fromExtension: false });
  expect(s.meter.usage().chargedUsd).toBe(reserved); expect(s.meter.usage().gaps.length).toBeGreaterThan(0); await s.meter.close();
});
test("real native gate prevents provider fetch at exhausted budget; admitted request uses actual payload hook", async () => {
  for (const allowed of [false, true]) {
    const s = setup(allowed ? 10 : 0.000001);
    let fetches = 0;
    const session = await createOmpSession({ cwd: s.dir, stateDir: join(s.dir, "sdk"), model: model as never,
      modelRef: `${model.provider}/${model.id}`, effort: "low", connectedProviders: [String(model.provider)], contextFiles: [],
      auth: { apiKeyFor: async () => "synthetic-test-key", configuredProviders: providers => [...providers] },
      extensions: [s.meter.extension], onBeforeModelCall: s.meter.beforeModelCall,
      streamFn: (m, c, options) => streamSimple(m, c, { ...options, maxTokens: 100, fetch: async () => {
        fetches++;
        const events = [
          ["message_start", { type: "message_start", message: { id: "test", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } } as never),
    });
    try {
      await session.session.prompt("Reply ok for a provider-free meter test");
      expect(fetches).toBe(allowed ? 1 : 0);
      if (allowed) { expect(s.meter.usage().rows).toHaveLength(1); expect(s.meter.usage().rows[0]!.state).toBe("settled"); }
    } finally { await session.dispose(); await s.meter.close(); }
  }
}, 20000);

const externalRequest = { provider: "jev", model: "jev-1.13.0", reservedUsd: 0.002688 };
test("external admission persists before dispatch and settles validated usage in the shared ledger", async () => {
  const s = setup();
  const ticket = await s.meter.reserveExternal(externalRequest);
  expect(ticket).toBeDefined();
  const durable = JSON.parse(readFileSync(join(s.dir, "operator-meter.json"), "utf8"));
  expect(durable.rows[0]).toMatchObject({ lane: "external", provider: "jev", model: "jev-1.13.0", state: "reserved", chargedUsd: 0.002688 });
  expect(ticket!.dispatch()).toBe(true);
  expect(ticket!.dispatch()).toBe(false); // One ticket authorizes only one transport.
  ticket!.settle({ costUsd: 1000 * 0.042 / 1e6, inputTokens: 1000, outputTokens: 0 });
  expect(s.meter.usage()).toMatchObject({ chargedUsd: 0.000042, knownCostUsd: 0.000042 });
  expect(s.meter.usage().rows[0]).toMatchObject({ state: "settled", usage: { input: 1000, output: 0, totalTokens: 1000 } });
  ticket!.settle({ costUsd: 1 }); // Duplicate completion cannot charge twice.
  expect(s.violations).toHaveLength(0); await s.meter.close();
});
test("optional external admission never waits for an in-flight parent or aborts on insufficient funds", async () => {
  const s = setup(0.02), parent = s.attach("parent");
  expect(await s.meter.beforeModelCall(parent.ctx, { messages: [] })).toBe(true);
  const charged = s.meter.usage().chargedUsd;
  const result = await Promise.race([
    s.meter.reserveExternal({ ...externalRequest, reservedUsd: 0.01 }),
    Bun.sleep(100).then(() => "waited"),
  ]);
  expect(result).toBeUndefined();
  expect(s.meter.usage().chargedUsd).toBe(charged);
  expect(s.meter.usage().rows).toHaveLength(1);
  expect(s.meter.signal.aborted).toBe(false); expect(s.violations).toHaveLength(0);
  await s.meter.close();
});
test("concurrent external reservations share headroom and do not jump a queued native request", async () => {
  const s = setup(0.02);
  const [first, second] = await Promise.all([
    s.meter.reserveExternal({ ...externalRequest, reservedUsd: 0.015 }),
    s.meter.reserveExternal({ ...externalRequest, reservedUsd: 0.015 }),
  ]);
  expect(first).toBeDefined(); expect(second).toBeUndefined();
  const parent = s.attach("parent");
  const pending = s.meter.beforeModelCall(parent.ctx, { messages: [] });
  expect(await s.meter.reserveExternal({ ...externalRequest, reservedUsd: 0.001 })).toBeUndefined();
  first!.settle({ costUsd: 0 });
  expect(await pending).toBe(true);
  expect(s.meter.usage().chargedUsd).toBeLessThanOrEqual(0.02);
  expect(s.violations).toHaveLength(0); await s.meter.close();
});
test("external cancellation releases only pre-dispatch exposure and retains dispatched unknown costs", async () => {
  const s = setup(); const before = new AbortController(), after = new AbortController();
  const first = await s.meter.reserveExternal({ ...externalRequest, signal: before.signal });
  before.abort();
  expect(first!.dispatch()).toBe(false);
  expect(s.meter.usage().rows[0]).toMatchObject({ state: "settled", costUsd: 0, chargedUsd: 0 });
  const second = await s.meter.reserveExternal({ ...externalRequest, signal: after.signal });
  expect(second!.dispatch()).toBe(true); after.abort();
  expect(s.meter.usage().rows[1]).toMatchObject({ state: "unknown", chargedUsd: externalRequest.reservedUsd });
  expect(s.meter.signal.aborted).toBe(false); expect(s.violations).toHaveLength(0);
  expect(await s.meter.reserveExternal({ ...externalRequest, signal: before.signal })).toBeUndefined();
  await s.meter.close();
});
test("missing and invalid external usage retain exposure across close and resume", async () => {
  const s = setup();
  for (const result of [{}, { costUsd: NaN }, { costUsd: -1 }, { costUsd: 0, inputTokens: -1 }]) {
    const ticket = await s.meter.reserveExternal(externalRequest); ticket!.dispatch(); ticket!.settle(result);
  }
  expect(s.meter.usage().rows.every(row => row.state === "unknown")).toBe(true);
  expect(s.meter.usage().chargedUsd).toBeCloseTo(4 * externalRequest.reservedUsd);
  const pending = await s.meter.reserveExternal(externalRequest); pending!.dispatch();
  await s.meter.close();
  const resumed = createOperatorMeter({ run: { id: "test", dir: s.dir }, limitUsd: 1, onViolation: () => {} });
  expect(resumed.usage().rows).toHaveLength(5);
  expect(resumed.usage().rows.every(row => row.state === "unknown")).toBe(true);
  expect(resumed.usage().chargedUsd).toBeCloseTo(5 * externalRequest.reservedUsd);
  expect(resumed.usage().knownCostUsd).toBe(0); await resumed.close();
});
test("external observed overspend is recorded and triggers the common budget violation", async () => {
  const s = setup(0.01); const ticket = await s.meter.reserveExternal(externalRequest);
  ticket!.dispatch(); ticket!.settle({ costUsd: 0.02, inputTokens: 10 });
  expect(s.meter.usage().chargedUsd).toBe(0.02);
  expect(s.violations).toHaveLength(1); expect(s.meter.signal.aborted).toBe(true);
  await s.meter.close();
});
test("external zero reservations are supported while invalid or unavailable admission creates no rows", async () => {
  const s = setup();
  for (const reservedUsd of [NaN, -1, Infinity]) await expect(s.meter.reserveExternal({ ...externalRequest, reservedUsd })).rejects.toThrow("Invalid external");
  expect(await s.meter.reserveExternal({ ...externalRequest, reservedUsd: 2 })).toBeUndefined();
  expect(s.meter.usage().rows).toHaveLength(0);
  const ticket = await s.meter.reserveExternal({ ...externalRequest, reservedUsd: 0 });
  expect(ticket!.dispatch()).toBe(true); ticket!.settle({ costUsd: 0 });
  expect(s.meter.usage().chargedUsd).toBe(0); expect(s.violations).toHaveLength(0);
  await s.meter.close(); expect(await s.meter.reserveExternal(externalRequest)).toBeUndefined();
});

test("only explicit null removes the budget limit; accounting and cancellation remain active", async () => {
  for (const limit of [undefined, NaN, Infinity, -1, 0]) {
    expect(() => new OperatorBudget(limit as number)).toThrow("Invalid operator budget");
  }
  const budget = new OperatorBudget(null, 17);
  const [first, second] = await Promise.all([budget.acquire(100), budget.acquire(200)]);
  expect(budget.queuedCount).toBe(0);
  expect(budget.activeCount).toBe(2);
  expect(budget.chargedUsd).toBe(317);
  first.settle(130); second.settle();
  expect(budget.chargedUsd).toBe(347);
  const cancellation = new AbortController(); cancellation.abort(new Error("unlimited cancelled"));
  await expect(budget.acquire(50, cancellation.signal)).rejects.toThrow("unlimited cancelled");
  expect(budget.chargedUsd).toBe(347);
  expect(budget.activeCount).toBe(0);
});

test("unlimited native and external requests keep known costs and interrupted exposure across resume", async () => {
  const s = setup(null), native = s.attach("parent");
  await native.emit("before_provider_request", request);
  const nativeReserve = s.meter.usage().chargedUsd;
  const [known, interrupted] = await Promise.all([
    s.meter.reserveExternal({ ...externalRequest, reservedUsd: 100 }),
    s.meter.reserveExternal({ ...externalRequest, reservedUsd: 200 }),
  ]);
  expect(known!.dispatch()).toBe(true); expect(interrupted!.dispatch()).toBe(true);
  known!.settle({ costUsd: 150, inputTokens: 10, outputTokens: 2 });
  expect(s.meter.usage().knownCostUsd).toBe(150);
  expect(s.meter.usage().chargedUsd).toBeCloseTo(350 + nativeReserve);
  expect(s.violations).toHaveLength(0);
  expect(s.meter.signal.aborted).toBe(false);
  const persisted = JSON.parse(readFileSync(join(s.dir, "operator-meter.json"), "utf8"));
  expect(persisted.limitUsd).toBeNull();
  expect(persisted.rows.filter((row: { state: string }) => row.state === "reserved")).toHaveLength(2);
  // Simulate restart from the durable in-flight ledger, before the old process closes.
  const resumed = createOperatorMeter({ run: { id: "test", dir: s.dir }, limitUsd: null, models: [model], onViolation: () => {} });
  expect(resumed.usage().chargedUsd).toBeCloseTo(350 + nativeReserve);
  expect(resumed.usage().rows.filter(row => row.state === "unknown")).toHaveLength(2);
  const next = await resumed.reserveExternal(externalRequest);
  expect(next).toBeDefined(); next!.settle({ costUsd: 0 });
  expect(() => createOperatorMeter({ run: { id: "test", dir: s.dir }, limitUsd: 500, onViolation: () => {} })).toThrow("mismatched");
  await s.meter.close(); await resumed.close();
});

test("unlimited cancellation releases undispatched reservations and retains dispatched unknown exposure", async () => {
  const s = setup(null), before = new AbortController(), after = new AbortController();
  const first = await s.meter.reserveExternal({ ...externalRequest, signal: before.signal });
  before.abort(); expect(first!.dispatch()).toBe(false);
  const second = await s.meter.reserveExternal({ ...externalRequest, signal: after.signal });
  expect(second!.dispatch()).toBe(true); after.abort();
  expect(s.meter.usage().rows[0]).toMatchObject({ state: "settled", chargedUsd: 0 });
  expect(s.meter.usage().rows[1]).toMatchObject({ state: "unknown", chargedUsd: externalRequest.reservedUsd });
  expect(await s.meter.reserveExternal({ ...externalRequest, signal: before.signal })).toBeUndefined();
  expect(s.violations).toHaveLength(0); await s.meter.close();
});

test("finite ledgers cannot silently resume as unlimited", async () => {
  const s = setup(1); await s.meter.close();
  expect(() => createOperatorMeter({ run: { id: "test", dir: s.dir }, limitUsd: null, onViolation: () => {} })).toThrow("mismatched");
});
