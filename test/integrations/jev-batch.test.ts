import { expect, test } from "bun:test";
import { evaluateWithJev, JEV_MODEL, type JevState } from "../../src/integrations/jev";

const questions = {
  action: { instructions: "Choose the operation from the page state.", criteria: { click: "Navigate", type: "Enter text" } },
  target: { instructions: "Choose the visible element.", criteria: { item_0: "Search box", item_1: "Result link" } },
};
const valid = () => ({ model: JEV_MODEL, answers: {
  action: { type: "choice", choice: "click", confidence: 0.95, probabilities: { click: 0.9, type: 0.1 } },
  target: { type: "choice", choice: "item_1", confidence: 0.95, probabilities: { item_0: 0.1, item_1: 0.9 } },
}, usage: { input_tokens: 120, output_tokens: 35 } });
const options = (value: unknown) => ({ enabled: true, apiKey: "test",
  fetch: (async () => Response.json(value)) as unknown as typeof fetch });

test("independent heads share one immutable structured state in one request", async () => {
  let calls = 0;
  const state = { page: { epoch: 2, title: "Search", elements: ["box", "result"] }, goal: "Open result" };
  const original = structuredClone(state);
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    const request = JSON.parse(init!.body as string);
    expect(request.state).toEqual(state);
    expect(Object.keys(request.questions)).toEqual(["action", "target"]);
    expect(request.questions.action).toEqual({ type: "choice", ...questions.action });
    expect(request.questions.target).toEqual({ type: "choice", ...questions.target });
    return Response.json(valid());
  }) as unknown as typeof globalThis.fetch;
  const result = await evaluateWithJev(state, questions, { enabled: true, apiKey: "test", fetch });
  expect(calls).toBe(1);
  expect(state).toEqual(original);
  expect(result).toMatchObject({ source: "jev", reason: "accepted", requestedModel: JEV_MODEL,
    returnedModel: JEV_MODEL, usage: { input_tokens: 120, output_tokens: 35 },
    answers: { action: { choice: "click", accepted: true }, target: { choice: "item_1", accepted: true } } });
});

test("weak speculative head preserves accepted heads and whole-request usage", async () => {
  const body = valid(); body.answers.target.confidence = 0.2;
  const result = await evaluateWithJev("state", questions, options(body));
  expect(result).toMatchObject({ source: "fallback", reason: "low_confidence", usage: body.usage,
    answers: { action: { accepted: true, choice: "click" }, target: { accepted: false, choice: "item_1" } } });
});

test.each(["missing", "extra", "malformed", "cross_head_choice"])("rejects %s answer map without exposing partial decisions", async variant => {
  const body: any = valid();
  if (variant === "missing") delete body.answers.target;
  if (variant === "extra") body.answers.command = { type: "text", text: "execute" };
  if (variant === "malformed") body.answers.target.probabilities.item_1 = 0.2;
  if (variant === "cross_head_choice") body.answers.target.choice = "click";
  const result = await evaluateWithJev("state", questions, options(body));
  expect(result.reason).toBe("invalid_response");
  expect(result.answers).toBeUndefined();
});

test("single-option head is validated explicitly rather than assumed from provider confidence", async () => {
  const single = { only: { instructions: "Only admitted target", criteria: { target_0: "Visible input" } } };
  const body = { model: JEV_MODEL, answers: { only: { type: "choice", choice: "target_0", confidence: 1, probabilities: { target_0: 1 } } } };
  expect((await evaluateWithJev("state", single, options(body))).answers?.only).toMatchObject({ accepted: true, choice: "target_0" });
  body.answers.only.probabilities.target_0 = 0.5;
  expect((await evaluateWithJev("state", single, options(body))).reason).toBe("invalid_response");
});

test("invalid JSON state and question contracts never reach network", async () => {
  let calls = 0, getterCalls = 0;
  const fetch = (async () => { calls++; return Response.json(valid()); }) as unknown as typeof globalThis.fetch;
  const cyclic: any = {}; cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { getterCalls++; return "data"; } });
  const sparse = Array(1); (sparse as any).other = "data";
  const invalidStates = [undefined, NaN, Infinity, 1n, { nested: undefined }, cyclic, new Date(), accessor, sparse,
    { toJSON: () => "changed" }, "x".repeat(16001)];
  for (const state of invalidStates) expect((await evaluateWithJev(state as JevState, questions, { enabled: true, apiKey: "test", fetch })).reason).toBe("invalid_input");
  for (const invalid of [{}, { "bad-id": questions.action }, { a: { instructions: "", criteria: { a: "A" } } },
    { a: { instructions: "Choose", criteria: {} } }, { a: { ...questions.action, executable: "command" } },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q_${i}`, questions.action]))]) {
    expect((await evaluateWithJev("state", invalid as any, { enabled: true, apiKey: "test", fetch })).reason).toBe("invalid_input");
  }
  expect(calls).toBe(0); expect(getterCalls).toBe(0);
});

test("serialized batch byte bound applies across all questions", async () => {
  let calls = 0;
  const fetch = (async () => { calls++; return Response.json(valid()); }) as unknown as typeof globalThis.fetch;
  const large = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q_${i}`, {
    instructions: "💡".repeat(1700), criteria: { a: "A" },
  }]));
  expect((await evaluateWithJev("state", large, { enabled: true, apiKey: "test", fetch })).reason).toBe("invalid_input");
  expect(calls).toBe(0);
});

test("late uncooperative fetch response is cancelled after whole-call timeout", async () => {
  let resolve!: (response: Response) => void;
  let cancelled = false;
  const fetch = (() => new Promise<Response>(done => { resolve = done; })) as unknown as typeof globalThis.fetch;
  const result = await evaluateWithJev("state", questions, { enabled: true, apiKey: "test", fetch, timeoutMs: 5 });
  expect(result.reason).toBe("timeout");
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(done => setTimeout(done, 0));
  expect(cancelled).toBe(true);
});

test("caller abort cancels active response reader without partial decisions", async () => {
  const controller = new AbortController(); let cancelled = false;
  const fetch = (async () => new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 0); },
    cancel() { cancelled = true; } }))) as unknown as typeof globalThis.fetch;
  const result = await evaluateWithJev("state", questions, { enabled: true, apiKey: "test", fetch, signal: controller.signal });
  expect(result.reason).toBe("aborted"); expect(result.answers).toBeUndefined(); expect(cancelled).toBe(true);
});

test("malformed usage remains unknown even when decisions validate", async () => {
  const body = valid(); body.usage.input_tokens = -1;
  const result = await evaluateWithJev("state", questions, options(body));
  expect(result.source).toBe("jev"); expect(result.usage).toBeUndefined();
});
