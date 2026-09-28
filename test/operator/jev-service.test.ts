import { expect, test } from "bun:test";
import { createJevWorkflowService, type JevWorkflowServiceOptions, type JevWorkflowStats } from "../../src/operator/jev-service";
import type { ExternalMeterReservation, ExternalMeterSettlement, ExternalMeterTicket } from "../../src/operator/meter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const request = { operation: "research" as const, sessionId: "worker-a", state: { excerpt: "Bounded evidence" }, questions: {
  relevance: { instructions: "Choose relevance", criteria: { relevant: "Relevant", unrelated: "Unrelated" } },
  supported: { instructions: "Choose support", criteria: { relevant: "Supported", unrelated: "Unsupported" } },
} };
function response(confidences = [0.99, 0.99]) {
  return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [id,
    { type: "choice", choice: "relevant", confidence: confidences[index], probabilities: { relevant: 0.95, unrelated: 0.05 } }])),
  usage: { input_tokens: 100, output_tokens: 5 } });
}
function ticket() {
  const settlements: Array<ExternalMeterSettlement | undefined> = [];
  let dispatches = 0;
  const value: ExternalMeterTicket = { dispatch() { dispatches++; return true; }, settle(result) { settlements.push(result); } };
  return { value, settlements, dispatches: () => dispatches };
}
function fixture(patch: Partial<JevWorkflowServiceOptions> = {}) {
  const controller = new AbortController(), snapshots: JevWorkflowStats[] = [], reservations: ExternalMeterReservation[] = [];
  const tickets: ReturnType<typeof ticket>[] = [];
  let fetches = 0;
  const options: JevWorkflowServiceOptions = {
    enabled: true, apiKey: "offline", signal: () => controller.signal, onStats: stats => snapshots.push(stats),
    reserve: async reservation => { reservations.push(reservation); const t = ticket(); tickets.push(t); return t.value; },
    fetch: (async () => { fetches++; return response(); }) as unknown as typeof fetch,
    ...patch,
  };
  return { service: createJevWorkflowService(options), controller, snapshots, reservations, tickets, fetches: () => fetches };
}

test("concurrent call admission reserves the final allowance atomically before awaiting dollars", async () => {
  const gate = deferred<ExternalMeterTicket | undefined>(), admitted = deferred<void>(), t = ticket();
  const f = fixture({ maxCalls: 1, maxInputTokens: 128000, reserve: async () => { admitted.resolve(); return gate.promise; } });
  const first = f.service.evaluate(request); await admitted.promise;
  expect(f.service.stats()).toMatchObject({ attempts: 1, reservedInputTokens: 64000 });
  expect(f.snapshots.at(-1)?.reservedInputTokens).toBe(64000);
  const second = await f.service.evaluate({ ...request, sessionId: "worker-b", state: "different task" });
  expect(second.reason).toBe("call_budget"); expect(f.fetches()).toBe(0);
  gate.resolve(t.value);
  expect((await first).reason).toBe("accepted"); expect(f.fetches()).toBe(1);
  expect(f.service.stats()).toMatchObject({ attempts: 1, inputTokens: 100, reservedInputTokens: 0, unknownInputTokens: 0 });
});

test("concurrent token reservations prevent two workers sharing one remaining input allowance", async () => {
  const gate = deferred<ExternalMeterTicket | undefined>(), admitted = deferred<void>(), t = ticket();
  const f = fixture({ maxCalls: 3, maxInputTokens: 64000, reserve: async () => { admitted.resolve(); return gate.promise; } });
  const first = f.service.evaluate(request); await admitted.promise;
  expect((await f.service.evaluate({ ...request, sessionId: "worker-b", state: "different task" })).reason).toBe("token_budget");
  gate.resolve(t.value); await first;
  expect(f.fetches()).toBe(1); expect(f.service.stats().attempts).toBe(1);
});

test("timeout after dispatch retains unknown dollar and token exposure", async () => {
  const f = fixture({ timeoutMs: 5, maxInputTokens: 100000, fetch: (() => new Promise(() => {})) as unknown as typeof fetch });
  expect((await f.service.evaluate(request)).reason).toBe("timeout");
  expect(f.tickets[0]!.dispatches()).toBe(1);
  expect(f.tickets[0]!.settlements).toHaveLength(1);
  expect(f.tickets[0]!.settlements[0]!.costUsd).toBeUndefined();
  expect(f.service.stats()).toMatchObject({ inputTokens: 0, reservedInputTokens: 0, unknownInputTokens: 64000 });
  expect((await f.service.evaluate(request)).reason).toBe("token_budget");
});

test("cancellation before admission causes no transport or reservation", async () => {
  const f = fixture(); f.controller.abort();
  expect((await f.service.evaluate(request)).reason).toBe("aborted");
  expect(f.fetches()).toBe(0); expect(f.reservations).toHaveLength(0);
  expect(f.service.stats()).toEqual({ attempts: 0, inputTokens: 0, outputTokens: 0, reservedInputTokens: 0, unknownInputTokens: 0 });
});

test.each(["timeout", "aborted"] as const)("late dollar admission after %s settles zero without dispatch or leaked token reserve", async reason => {
  const gate = deferred<ExternalMeterTicket | undefined>(), admitted = deferred<void>(), t = ticket();
  const f = fixture({ timeoutMs: reason === "timeout" ? 5 : 1000,
    reserve: async () => { admitted.resolve(); return gate.promise; } });
  const pending = f.service.evaluate(request); await admitted.promise;
  if (reason === "aborted") f.controller.abort();
  expect((await pending).reason).toBe(reason);
  expect(f.service.stats().reservedInputTokens).toBe(0);
  gate.resolve(t.value);
  // Drain the late reservation continuation and its caught transport rejection.
  await gate.promise; await Promise.resolve(); await Promise.resolve();
  expect(t.dispatches()).toBe(0); expect(f.fetches()).toBe(0);
  expect(t.settlements).toHaveLength(1); expect(t.settlements[0]!.costUsd).toBe(0);
  expect(f.service.stats()).toMatchObject({ reservedInputTokens: 0, unknownInputTokens: 0 });
});

test("interrupted reservations become durable unknown exposure on resume", async () => {
  const initialStats: JevWorkflowStats = { attempts: 2, inputTokens: 100, outputTokens: 5, reservedInputTokens: 64000, unknownInputTokens: 0 };
  const f = fixture({ initialStats, maxInputTokens: 100000 });
  expect(f.snapshots[0]).toEqual({ ...initialStats, reservedInputTokens: 0, unknownInputTokens: 64000 });
  expect(initialStats.reservedInputTokens).toBe(64000);
  expect((await f.service.evaluate(request)).reason).toBe("token_budget");
  expect(f.fetches()).toBe(0); expect(f.reservations).toHaveLength(0);
});

test.each(["disabled", "missing_key"] as const)("%s produces zero network and zero admission", async reason => {
  const f = fixture(reason === "disabled" ? { enabled: false } : { apiKey: undefined });
  expect((await f.service.evaluate(request)).reason).toBe(reason);
  expect(f.fetches()).toBe(0); expect(f.reservations).toHaveLength(0); expect(f.service.stats().attempts).toBe(0);
});

test("partial low-confidence batch charges validated usage and leaves per-head acceptance visible", async () => {
  const f = fixture({ fetch: (async () => response([0.99, 0.2])) as unknown as typeof fetch });
  const result = await f.service.evaluate(request);
  expect(result.reason).toBe("low_confidence"); expect(result.answers?.relevance?.accepted).toBe(true);
  expect(result.answers?.supported?.accepted).toBe(false);
  expect(f.tickets[0]!.settlements[0]).toMatchObject({ inputTokens: 100, outputTokens: 5, costUsd: 100 * 0.042 / 1e6 });
  expect(f.service.stats()).toMatchObject({ inputTokens: 100, outputTokens: 5, reservedInputTokens: 0, unknownInputTokens: 0 });
});

test("denied dollar admission releases reserved tokens and never dispatches", async () => {
  const f = fixture({ reserve: async () => undefined });
  expect((await f.service.evaluate(request)).reason).toBe("allocation_budget");
  expect(f.fetches()).toBe(0); expect(f.service.stats()).toMatchObject({ attempts: 1, reservedInputTokens: 0, unknownInputTokens: 0 });
});

test("three identical concurrent evaluations require one physical request, one settlement, and one usage charge", async () => {
  const gate = deferred<Response>(), called = deferred<void>(); let calls = 0;
  const reuse: Array<Parameters<NonNullable<JevWorkflowServiceOptions["onReuse"]>>[0]> = [];
  const f = fixture({ maxCalls: 1, onReuse: event => reuse.push(event), fetch: (async () => { calls++; called.resolve(); return gate.promise; }) as unknown as typeof fetch });
  const tasks = ["first", "second", "third"].map(sessionId => f.service.evaluate({ ...request, sessionId }));
  await called.promise; expect(calls).toBe(1); expect(f.reservations).toHaveLength(1);
  gate.resolve(response()); const results = await Promise.all(tasks);
  expect(results.map(result => result.reuse?.kind)).toEqual(["origin", "inflight", "inflight"]);
  expect(new Set(results.map(result => result.reuse?.requestId)).size).toBe(1);
  expect(results.filter(result => result.usage)).toHaveLength(1);
  expect(results.slice(1).every(result => result.dispatched === false && result.costUsd === 0)).toBe(true);
  expect(f.tickets[0]!.settlements).toHaveLength(1);
  expect(f.service.stats()).toMatchObject({ attempts: 1, inputTokens: 100, outputTokens: 5 });
  const cached = await f.service.evaluate(request);
  expect(cached.reuse?.kind).toBe("cache"); expect(cached.usage).toBeUndefined(); expect(cached.costUsd).toBe(0);
  expect(calls).toBe(1); // Exact-answer reuse still works after the physical-call cap is reached.
  expect(reuse.map(event => event.kind)).toEqual(["inflight", "inflight", "cache"]);
  expect(reuse.every(event => event.requestId === results[0]!.reuse!.requestId)).toBe(true);
  expect(reuse.map(event => event.sessionId)).toEqual(["second", "third", request.sessionId]);
  expect(JSON.stringify(reuse)).not.toContain(request.state.excerpt);
});

test("origin cancellation does not cancel a live follower or lose physical accounting", async () => {
  const gate = deferred<Response>(), called = deferred<void>(), leader = new AbortController(); let transportSignal: AbortSignal | null | undefined;
  const physicalEvents: unknown[] = [];
  const f = fixture({ onDecision: event => physicalEvents.push(event), fetch: (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    transportSignal = init?.signal; called.resolve(); return gate.promise;
  }) as unknown as typeof fetch });
  const first = f.service.evaluate({ ...request, signal: leader.signal });
  const second = f.service.evaluate({ ...request, sessionId: "follower" });
  await called.promise; leader.abort();
  expect((await first).reason).toBe("aborted"); expect(transportSignal?.aborted).toBe(false);
  gate.resolve(response()); const result = await second;
  expect(result.reason).toBe("accepted"); expect(result.reuse?.kind).toBe("inflight"); expect(result.usage).toBeUndefined();
  expect(f.service.stats().inputTokens).toBe(100); expect(physicalEvents).toHaveLength(1);
  expect(f.tickets[0]!.settlements[0]!.costUsd).toBe(100 * 0.042 / 1e6);
});

test("follower cancellation is independent; cancelling all waiters aborts transport and retains exposure once", async () => {
  const called = deferred<void>(), a = new AbortController(), b = new AbortController(); let physicalSignal: AbortSignal | null | undefined;
  const reuse: unknown[] = [];
  const f = fixture({ onReuse: event => reuse.push(event), fetch: ((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    physicalSignal = init?.signal; called.resolve(); return new Promise(() => {});
  }) as unknown as typeof fetch });
  const first = f.service.evaluate({ ...request, signal: a.signal });
  const second = f.service.evaluate({ ...request, sessionId: "follower", signal: b.signal });
  await called.promise; b.abort(); expect((await second).reason).toBe("aborted"); expect(physicalSignal?.aborted).toBe(false);
  a.abort(); expect((await first).reason).toBe("aborted"); expect(physicalSignal?.aborted).toBe(true);
  expect(f.service.stats()).toMatchObject({ attempts: 1, reservedInputTokens: 0, unknownInputTokens: 64000 });
  expect(f.tickets[0]!.settlements).toHaveLength(1);
  expect(reuse).toHaveLength(0);
});

test("request snapshots resist caller mutation and cached answers resist consumer mutation", async () => {
  const gate = deferred<ExternalMeterTicket | undefined>(), admitted = deferred<void>(), t = ticket(); let received: any;
  const f = fixture({ reserve: async () => { admitted.resolve(); return gate.promise; }, fetch: (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    received = JSON.parse(init!.body as string); return response();
  }) as unknown as typeof fetch });
  const mutable = structuredClone(request);
  const first = f.service.evaluate(mutable); mutable.state.excerpt = "changed by caller";
  mutable.questions.relevance.instructions = "different instructions";
  await admitted.promise; gate.resolve(t.value); const result = await first;
  expect(received.state.excerpt).toBe(request.state.excerpt);
  expect(received.questions.relevance.instructions).toBe(request.questions.relevance.instructions);
  result.answers!.relevance!.choice = "poisoned";
  const hit = await f.service.evaluate(request); expect(hit.reuse?.kind).toBe("cache"); expect(hit.answers!.relevance!.choice).toBe("relevant");
});

test("invalid state cannot invoke accessors or collide with cached JSON values", async () => {
  const f = fixture(); await f.service.evaluate({ ...request, state: { x: null } });
  let getterCalls = 0;
  const malformed = { get x() { getterCalls++; return null; } };
  expect((await f.service.evaluate({ ...request, state: malformed })).reason).toBe("invalid_input");
  expect(getterCalls).toBe(0);
  expect((await f.service.evaluate({ ...request, state: { x: NaN } })).reason).toBe("invalid_input");
  const cycle: any = {}; cycle.self = cycle;
  expect((await f.service.evaluate({ ...request, state: cycle })).reason).toBe("invalid_input");
  expect(f.fetches()).toBe(1);
});

test("operation, exact criteria and state changes do not reuse a previous answer", async () => {
  const f = fixture(); await f.service.evaluate(request);
  await f.service.evaluate({ ...request, operation: "browser" });
  await f.service.evaluate({ ...request, state: "different" });
  await f.service.evaluate({ ...request, questions: { ...request.questions, relevance: { ...request.questions.relevance, instructions: "Changed rubric" } } });
  expect(f.fetches()).toBe(4);
});

test("aborted or replaced run generation cannot reuse old cache or join old work", async () => {
  let run = new AbortController();
  const f = fixture({ signal: () => run.signal });
  await f.service.evaluate(request); expect((await f.service.evaluate(request)).reuse?.kind).toBe("cache");
  run.abort(); expect((await f.service.evaluate(request)).reason).toBe("aborted");
  run = new AbortController(); await f.service.evaluate(request);
  expect(f.fetches()).toBe(2);
  run = new AbortController(); await f.service.evaluate(request);
  expect(f.fetches()).toBe(3);
});

test("low confidence and unknown usage are not cached; entry and byte bounds evict safely", async () => {
  let calls = 0;
  const low = fixture({ fetch: (async () => { calls++; return response([0.2, 0.99]); }) as unknown as typeof fetch });
  await low.service.evaluate(request); await low.service.evaluate(request); expect(calls).toBe(2);
  const unknown = fixture({ fetch: (async () => { const body = await response().json() as any; delete body.usage; return Response.json(body); }) as unknown as typeof fetch });
  await unknown.service.evaluate(request); await unknown.service.evaluate(request); expect(unknown.service.stats().attempts).toBe(2);
  const bounded = fixture({ cacheEntries: 1 });
  await bounded.service.evaluate(request); await bounded.service.evaluate({ ...request, state: "other" }); await bounded.service.evaluate(request);
  expect(bounded.fetches()).toBe(3);
  const noRoom = fixture({ cacheBytes: 1 }); await noRoom.service.evaluate(request); await noRoom.service.evaluate(request);
  expect(noRoom.fetches()).toBe(2);
});

test("new steering generation aborts old in-flight work and starts a separately accounted request", async () => {
  let run = new AbortController(), calls = 0; const called = deferred<void>();
  const f = fixture({ signal: () => run.signal, fetch: (async () => {
    if (++calls === 1) { called.resolve(); return new Promise<Response>(() => {}); }
    return response();
  }) as unknown as typeof fetch });
  const old = f.service.evaluate(request); await called.promise;
  run = new AbortController();
  const fresh = await f.service.evaluate(request);
  expect((await old).reason).toBe("aborted"); expect(fresh.reason).toBe("accepted");
  expect(calls).toBe(2);
  expect(f.service.stats()).toMatchObject({ attempts: 2, inputTokens: 100, reservedInputTokens: 0, unknownInputTokens: 64000 });
  expect(f.tickets.flatMap(value => value.settlements)).toHaveLength(2);
});
