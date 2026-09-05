import { describe, expect, test } from "bun:test";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { defaultConfig } from "../../src/core/config";
import {
  isStrictCompatibleSchema,
  shapeProviderPayload,
  shapingStreamFn,
} from "../../src/providers/shaping";

function fakeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-fable-5-1",
    api: "anthropic-messages",
    provider: "anthropic",
    compat: {},
    ...overrides,
  } as Model;
}

const context: Context = { systemPrompt: ["system"], messages: [] };

function captureStream() {
  let call: { model: Model; context: Context; options: SimpleStreamOptions } | undefined;
  const sentinel = {} as ReturnType<StreamFn>;
  const inner = ((model: Model, value: Context, options?: SimpleStreamOptions) => {
    call = { model, context: value, options: options ?? {} };
    return sentinel;
  }) as StreamFn;
  return { inner, sentinel, call: () => call! };
}

describe("shapingStreamFn", () => {
  test("adds producer fallbacks on a Fable seat and preserves non-policy caller options", () => {
    const cfg = defaultConfig();
    const model = fakeModel();
    const capture = captureStream();
    const fallback = [{ model: "caller-owned-fallback" }];
    const options = {
      apiKey: "test-key",
      maxTokens: 123,
      metadata: { trace: "kept" },
      headers: { "x-test": "kept" },
      fallbacks: fallback,
    } satisfies SimpleStreamOptions;

    const result = shapingStreamFn({ cfg, runId: "run-7", role: "brain", model }, capture.inner)(model, context, options);

    expect(result).toBe(capture.sentinel);
    expect(capture.call().model).toBe(model);
    expect(capture.call().context).toBe(context);
    expect(capture.call().options).toEqual({
      ...options,
      fallbacks: [{ model: "claude-opus-5" }, { model: "claude-opus-4-8" }],
      cacheRetention: "short",
      onPayload: expect.any(Function),
    });
    expect(capture.call().options.fallbacks).not.toBe(fallback);
    expect(capture.call().options.headers).toEqual({ "x-test": "kept" });
  });

  test("disables caller and configured fallbacks on isolation, non-Fable, and opted-out seats", () => {
    const cases: Array<{ role: "auditor" | "brain"; model: Model; off?: boolean }> = [
      { role: "auditor", model: fakeModel() },
      { role: "brain", model: fakeModel({ id: "claude-opus-4-8" }) },
      { role: "brain", model: fakeModel(), off: true },
    ];
    for (const item of cases) {
      const cfg = defaultConfig();
      if (item.off) cfg.provider.fallbacks = "off";
      const capture = captureStream();
      shapingStreamFn({ cfg, runId: "r", role: item.role, model: item.model }, capture.inner)(item.model, context, {
        fallbacks: [{ model: "caller-must-not-cross-isolation" }],
      });
      expect(capture.call().options.fallbacks).toBeUndefined();
    }
  });

  test("omits a producer seat from its own fallback chain", () => {
    const cfg = defaultConfig();
    const model = fakeModel({ id: "claude-opus-5" });
    const capture = captureStream();
    shapingStreamFn({ cfg, runId: "r", role: "builder", model }, capture.inner)(model, context, {});
    expect(capture.call().options.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
  });

  test("sets role retention, stable cache identity, explicit 30m caching, and the configured idle timeout on an eligible Responses seat", () => {
    const cfg = defaultConfig();
    cfg.provider.cacheRetention = { builder: "long" };
    cfg.provider.streamIdleTimeoutMs = 456_000;
    const model = fakeModel({
      id: "gpt-5.6",
      api: "openai-responses",
      provider: "openai",
      compat: { supportsPromptCacheBreakpoints: true } as Model["compat"],
    });
    const capture = captureStream();

    shapingStreamFn({ cfg, runId: "01HX", role: "builder", model }, capture.inner)(model, context, { maxTokens: 987 });

    expect(capture.call().options).toEqual({
      maxTokens: 987,
      cacheRetention: "long",
      promptCacheKey: "01HX:builder",
      promptCache: { mode: "explicit", ttl: "30m" },
      streamIdleTimeoutMs: 456_000,
      onPayload: expect.any(Function),
    });
  });

  test("does not opt Codex or an incompatible Responses model into explicit prompt caching", () => {
    for (const model of [
      fakeModel({ id: "gpt-6-astra", api: "openai-codex-responses", provider: "openai-codex", compat: { supportsPromptCacheBreakpoints: true } as Model["compat"] }),
      fakeModel({ id: "gpt-5.5", api: "openai-responses", provider: "openai", compat: { supportsPromptCacheBreakpoints: false } as Model["compat"] }),
    ]) {
      const cfg = defaultConfig();
      const capture = captureStream();
      shapingStreamFn({ cfg, runId: "r", role: "judge", model }, capture.inner)(model, context, {});
      expect(capture.call().options).toEqual({ cacheRetention: "short", onPayload: expect.any(Function) });
    }
  });

  test("the prompt-cache flag disables kiln's cache fields without deleting caller-owned options", () => {
    const cfg = defaultConfig();
    cfg.provider.promptCache = false;
    cfg.provider.fallbacks = "off";
    const model = fakeModel({ api: "openai-responses", provider: "openai", compat: { supportsPromptCacheBreakpoints: true } as Model["compat"] });
    const capture = captureStream();
    const callerPromptCache = { mode: "implicit" as const };
    shapingStreamFn({ cfg, runId: "r", role: "brain", model }, capture.inner)(model, context, {
      promptCacheKey: "caller",
      promptCache: callerPromptCache,
    });
    expect(capture.call().options).toEqual({
      promptCacheKey: "caller",
      promptCache: callerPromptCache,
      cacheRetention: "short",
      onPayload: expect.any(Function),
    });
  });

  test("composes caller hooks before the built-in payload rewrite", async () => {
    const cfg = defaultConfig();
    cfg.provider.thinkingDisplay = "updates";
    const model = fakeModel();
    const capture = captureStream();
    const seen: string[] = [];
    const callHook: NonNullable<SimpleStreamOptions["onPayload"]> = (payload) => {
      seen.push("call");
      return { ...(payload as object), call: true };
    };
    const seatHook: NonNullable<SimpleStreamOptions["onPayload"]> = async (payload) => {
      seen.push("seat");
      return { ...(payload as object), seat: true };
    };
    shapingStreamFn({ cfg, runId: "r", role: "brain", model, onPayload: seatHook }, capture.inner)(model, context, { onPayload: callHook });

    const shaped = await capture.call().options.onPayload?.({ thinking: { type: "adaptive", display: "summarized" } }, model);
    expect(seen).toEqual(["call", "seat"]);
    expect(shaped).toEqual({ thinking: { type: "adaptive", display: "updates" }, call: true, seat: true });
  });
});

describe("provider payload shaping", () => {
  const validSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string" },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { ref: { type: "string" }, weight: { type: "number" } },
          required: ["ref", "weight"],
        },
      },
    },
    required: ["verdict", "evidence"],
  };

  test("recognizes recursively closed schemas with complete required lists", () => {
    expect(isStrictCompatibleSchema(validSchema)).toBe(true);
    expect(isStrictCompatibleSchema({ ...validSchema, additionalProperties: true })).toBe(false);
    expect(isStrictCompatibleSchema({ ...validSchema, required: ["verdict"] })).toBe(false);
    expect(isStrictCompatibleSchema({ $ref: "#/$defs/input", $defs: { input: validSchema } })).toBe(false);
    expect(isStrictCompatibleSchema({ ...validSchema, properties: {
      ...validSchema.properties,
      evidence: { type: "array", items: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
    } })).toBe(false);
  });

  test("strict-marks only schema-compatible Anthropic decision tools and leaves every invalid/non-decision tool exact", () => {
    const cfg = defaultConfig();
    const invalidSchema = {
      type: "object",
      additionalProperties: false,
      properties: { decision: { type: "string" }, optionalReason: { type: "string" } },
      required: ["decision"],
    };
    const payload = {
      model: "claude-fable-5-1",
      tools: [
        { name: "verdict", description: "decide", input_schema: validSchema },
        { name: "_collision", description: "OAuth-prefixed decision", input_schema: validSchema },
        { name: "audit", description: "invalid", input_schema: invalidSchema },
        { name: "read", description: "not a decision", input_schema: validSchema },
        { type: "web_search_20250305", name: "web_search" },
      ],
      thinking: { type: "adaptive", display: "summarized" },
      max_tokens: 1024,
    };

    expect(shapeProviderPayload(payload, fakeModel(), cfg)).toEqual({
      model: "claude-fable-5-1",
      tools: [
        { name: "verdict", description: "decide", input_schema: validSchema, strict: true },
        { name: "_collision", description: "OAuth-prefixed decision", input_schema: validSchema, strict: true },
        { name: "audit", description: "invalid", input_schema: invalidSchema },
        { name: "read", description: "not a decision", input_schema: validSchema },
        { type: "web_search_20250305", name: "web_search" },
      ],
      thinking: { type: "adaptive", display: "summarized" },
      max_tokens: 1024,
    });
    expect(payload.tools[0]).not.toHaveProperty("strict");
    expect(payload.tools[2]).toEqual({ name: "audit", description: "invalid", input_schema: invalidSchema });
  });

  test("returns undefined when every decision schema is invalid or the transport is not Anthropic", () => {
    const cfg = defaultConfig();
    const invalid = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const payload = { tools: [{ name: "verdict", input_schema: invalid }] };
    expect(shapeProviderPayload(payload, fakeModel(), cfg)).toBeUndefined();
    expect(shapeProviderPayload(payload, fakeModel({ api: "openai-responses", provider: "openai" }), cfg)).toBeUndefined();
  });

  test("thinking updates are family-governed, preserve the body, and never synthesize a beta header", () => {
    const cfg = defaultConfig();
    cfg.provider.thinkingDisplay = "updates";
    cfg.provider.strictDecisionTools = false;
    const payload = {
      thinking: { type: "adaptive", display: "summarized", extra: "kept" },
      headers: { "anthropic-beta": "caller-owned" },
      metadata: { kept: true },
    };
    expect(shapeProviderPayload(payload, fakeModel(), cfg)).toEqual({
      thinking: { type: "adaptive", display: "updates", extra: "kept" },
      headers: { "anthropic-beta": "caller-owned" },
      metadata: { kept: true },
    });
    expect(shapeProviderPayload(payload, fakeModel({ id: "claude-opus-4-8" }), cfg)).toBeUndefined();
    expect(payload.thinking.display).toBe("summarized");
  });
});
