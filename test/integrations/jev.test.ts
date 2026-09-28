import { expect, test } from "bun:test";
import { chooseWithJev, JEV_ENDPOINT, JEV_MODEL } from "../../src/integrations/jev";
const criteria = { fast: "Simple", deep: "Complex" };
const body = (patch: Record<string, unknown> = {}) => ({ model: JEV_MODEL, answers: { route: {
  type: "choice", choice: "deep", confidence: 0.95, probabilities: { fast: 0.1, deep: 0.9 }, ...patch,
} } });
const mock = (value: unknown, status = 200) => (async () => new Response(JSON.stringify(value), { status })) as unknown as typeof fetch;
test("disabled and missing credentials never call fetch", async () => {
  const fetch = (() => { throw new Error("must not call"); }) as unknown as typeof globalThis.fetch;
  expect((await chooseWithJev("summary", criteria, "fast", { fetch, apiKey: "present" })).reason).toBe("disabled");
  expect((await chooseWithJev("summary", criteria, "fast", { fetch, enabled: true })).reason).toBe("missing_key");
});
test("valid bounded choice preserves confidence and model provenance", async () => {
  const fetch = (async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(url).toBe(JEV_ENDPOINT); expect(init?.redirect).toBe("error");
    const sent = JSON.parse(init!.body as string);
    expect(sent.questions.route.criteria).toEqual(criteria); expect(sent.model).toBe(JEV_MODEL);
    return new Response(JSON.stringify(body()));
  }) as unknown as typeof globalThis.fetch;
  const result = await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch });
  expect(result).toMatchObject({ source: "jev", choice: "deep", confidence: 0.95, returnedModel: JEV_MODEL });
});
test.each([
  { choice: "execute_shell" }, { confidence: 2 }, { probabilities: { fast: 0.1, deep: 0.4 } },
  { probabilities: { fast: 0.1, deep: 0.9, injected: 0 } }, { probabilities: { fast: 0.9, deep: 0.1 } }, { type: "text" },
])("malformed responses use deterministic fallback", async (patch) => {
  const result = await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch: mock(body(patch)) });
  expect(result).toMatchObject({ source: "fallback", choice: "fast", reason: "invalid_response" });
});
test("low confidence preserves distribution but does not apply choice", async () => {
  expect(await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch: mock(body({ confidence: 0.2 })) }))
    .toMatchObject({ choice: "fast", reason: "low_confidence", confidence: 0.2 });
});
test("outages are not retried and provider error text is not exposed", async () => {
  let count = 0;
  const fetch = (async () => { count++; throw new Error("secret-private-data"); }) as unknown as typeof globalThis.fetch;
  const result = await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch });
  expect(result.reason).toBe("unavailable"); expect(count).toBe(1); expect(JSON.stringify(result)).not.toContain("secret");
  expect((await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch: mock({}, 429) })).reason).toBe("unavailable");
});
test("deadline bounds even an uncooperative transport and aborts it", async () => {
  let signal: AbortSignal | null | undefined;
  const fetch = ((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => { signal = init?.signal; return new Promise(() => {}); }) as unknown as typeof globalThis.fetch;
  const result = await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch, timeoutMs: 5 });
  expect(result.reason).toBe("timeout"); expect(signal?.aborted).toBe(true);
});
test("caller cancellation wins without network retry", async () => {
  const controller = new AbortController(); controller.abort();
  expect((await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", signal: controller.signal })).reason).toBe("aborted");
});
test("rejects changed model identity and oversized bodies", async () => {
  const options = { enabled: true, apiKey: "test" };
  expect((await chooseWithJev("summary", criteria, "fast", { ...options, fetch: mock({ ...body(), model: "jev-other" }) })).reason).toBe("invalid_response");
  expect((await chooseWithJev("summary", criteria, "fast", { ...options, fetch: mock({ ...body(), padding: "x".repeat(65536) }) })).reason).toBe("invalid_response");
});
test("timeout includes stalled response body and cancels its reader", async () => {
  let cancelled = false;
  const fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as unknown as typeof globalThis.fetch;
  const result = await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch, timeoutMs: 5 });
  expect(result.reason).toBe("timeout"); expect(cancelled).toBe(true);
});
test("validated token usage is reported without a cost claim", async () => {
  const result = await chooseWithJev("summary", criteria, "fast", { enabled: true, apiKey: "test", fetch: mock({ ...body(), usage: { input_tokens: 22, output_tokens: 3 } }) });
  expect(result.usage).toEqual({ input_tokens: 22, output_tokens: 3 });
});
test("aliases and oversized criteria fail before transmission", async () => {
  const fetch = (() => { throw new Error("must not call"); }) as unknown as typeof globalThis.fetch;
  const options = { enabled: true, apiKey: "test", fetch };
  expect((await chooseWithJev("summary", criteria, "fast", { ...options, model: "jev-latest" })).reason).toBe("invalid_input");
  expect((await chooseWithJev<"fast" | "deep">("summary", { fast: "🌱".repeat(20000), deep: "Complex" }, "fast", options)).reason).toBe("invalid_input");
});
