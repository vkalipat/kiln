import { expect, test } from "bun:test";
import { createJevControl, type JevRuntimeStep } from "../../src/operator/jev-control";

function transport(counter: { calls: number }, confidence = 0.95): typeof fetch {
  return (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    counter.calls++;
    const payload = JSON.parse(init!.body as string);
    const choices = Object.keys(payload.questions.route.criteria);
    const choice = choices.includes("implement") ? "implement" : choices[0];
    return Response.json({ model: payload.model, answers: { route: { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(choices.map(key => [key, key === choice ? 1 : 0])) } }, usage: { input_tokens: 10, output_tokens: 2 } });
  }) as unknown as typeof fetch;
}
const request = { fallback: "synthesize" as const };
test("reuses identical policy decisions without double-counting usage or retaining input", async () => {
  const counter = { calls: 0 };
  const control = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter) });
  const first = await control.decide("private task summary", request);
  const second = await control.decide("private task summary", request);
  expect(first).toMatchObject({ choice: "implement", source: "jev", cacheHit: false, usage: { input_tokens: 10, output_tokens: 2 } });
  expect(second).toMatchObject({ choice: "implement", source: "jev", cacheHit: true, latencyMs: 0 });
  expect(second.usage).toBeUndefined(); expect(counter.calls).toBe(1);
  expect(control.stats()).toEqual({ attempts: 1, cacheHits: 1, inputTokens: 10, outputTokens: 2, attemptsWithoutUsage: 0 });
  expect(JSON.stringify([first, second, control.stats()])).not.toContain("private task summary");
});
test("policy changes invalidate cached decision and explicit steps bypass calls", async () => {
  const counter = { calls: 0 };
  const control = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter) });
  await control.decide("task", request);
  await control.decide("task", { fallback: "research" });
  await control.decide("task", { fallback: "research", allowedSteps: ["research", "synthesize"] });
  expect(counter.calls).toBe(2);
  expect(await control.decide("task", { ...request, explicitStep: "ideate" })).toMatchObject({ choice: "ideate", source: "local", reason: "explicit_step" });
  expect(await control.decide("task", { fallback: "research", allowedSteps: ["research"] })).toMatchObject({ choice: "research", reason: "single_choice" });
  expect(counter.calls).toBe(2);
});
test("disabled and missing-key runtime policies make no requests", async () => {
  const counter = { calls: 0 };
  expect((await createJevControl({ enabled: false, apiKey: "offline", fetch: transport(counter) }).decide("task", request)).reason).toBe("disabled");
  expect((await createJevControl({ enabled: true, fetch: transport(counter) }).decide("task", request)).reason).toBe("missing_key");
  expect(counter.calls).toBe(0);
});
test("call and observed-token budgets stop new calls but permit cache hits", async () => {
  const counter = { calls: 0 };
  const calls = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter), maxCalls: 1 });
  await calls.decide("task", request);
  expect((await calls.decide("other", request)).reason).toBe("call_budget");
  expect((await calls.decide("task", request)).cacheHit).toBe(true);
  const tokens = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter), maxTokens: 12 });
  await tokens.decide("task", request);
  expect((await tokens.decide("other", request)).reason).toBe("token_budget");
  expect(counter.calls).toBe(2);
});
test("timeouts and cancellation are not cached; cancellation overrides a previous hit", async () => {
  let calls = 0;
  const fetch = (() => { calls++; return new Promise(() => {}); }) as unknown as typeof globalThis.fetch;
  const control = createJevControl({ enabled: true, apiKey: "offline", fetch, timeoutMs: 2 });
  expect((await control.decide("task", request)).reason).toBe("timeout");
  expect((await control.decide("task", request)).reason).toBe("timeout");
  expect(calls).toBe(2);
  const counter = { calls: 0 };
  const cached = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter) });
  await cached.decide("task", request);
  const cancelled = new AbortController(); cancelled.abort();
  expect((await cached.decide("task", { ...request, signal: cancelled.signal })).reason).toBe("aborted");
  expect(cached.stats().cacheHits).toBe(0);
});
test("low confidence is safely cached and caller mutation cannot poison cache", async () => {
  const counter = { calls: 0 };
  const control = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter, 0.2) });
  const first = await control.decide("task", request); first.choice = "research";
  const second = await control.decide("task", request);
  expect(second).toMatchObject({ choice: "synthesize", source: "fallback", reason: "low_confidence", cacheHit: true });
  expect(counter.calls).toBe(1);
  expect(await control.decide("task", { fallback: "research" })).toMatchObject({ choice: "research", reason: "low_confidence", cacheHit: true });
});
test("rejects review without producer context and evicts bounded cache entries", async () => {
  const counter = { calls: 0 };
  const control = createJevControl({ enabled: true, apiKey: "offline", fetch: transport(counter), cacheEntries: 1 });
  await expect(control.decide("task", { fallback: "review" as JevRuntimeStep })).rejects.toThrow("non-review");
  await control.decide("one", request); await control.decide("two", request); await control.decide("one", request);
  expect(counter.calls).toBe(3);
});
test("resume restores consumed caps and rejects malformed accounting", async () => {
  const counter = { calls: 0 };
  const options = { enabled: true, apiKey: "offline", fetch: transport(counter), maxCalls: 1 };
  const first = createJevControl(options); await first.decide("first", request);
  const resumed = createJevControl({ ...options, initialStats: first.stats() });
  expect((await resumed.decide("next", request)).reason).toBe("call_budget");
  expect(counter.calls).toBe(1);
  expect(() => createJevControl({ initialStats: { ...first.stats(), attempts: -1 } })).toThrow("statistics");
  expect(() => createJevControl({ initialStats: { ...first.stats(), inputTokens: Infinity } })).toThrow("statistics");
});
