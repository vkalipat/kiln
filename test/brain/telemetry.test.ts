import { describe, expect, test } from "bun:test";
import { contextInputHash, fallbackWasServed, toolExcerpt } from "../../src/brain/telemetry";

describe("brain telemetry", () => {
  test("hashes model-visible content and developer payload semantics, not transport ids", () => {
    const context = (id: string, clearAt: "never" | "next_user_message") => ({
      systemPrompt: ["kernel"],
      tools: [{ name: "read" }],
      messages: [{ role: "developer", content: "contract", id, providerPayload: { type: "anthropicMessage", clearAt } }],
    }) as never;
    expect(contextInputHash(context("a", "never"))).toBe(contextInputHash(context("b", "never")));
    expect(contextInputHash(context("a", "never"))).not.toBe(contextInputHash(context("a", "next_user_message")));
  });

  test("flattens and caps text blocks while ignoring non-text blocks", () => {
    expect(toolExcerpt({ content: [{ type: "text", text: "abc" }, { type: "image" }, { type: "text", text: "def" }] }, 5)).toBe("abc\nd");
    expect(toolExcerpt({ content: [] })).toBeUndefined();
  });

  test("detects served-model rewrites and fallback boundary blocks", () => {
    expect(fallbackWasServed({ model: "claude-opus-5", content: [] } as never, "claude-fable-5-1")).toBe(true);
    expect(fallbackWasServed({ model: "claude-fable-5-1", content: [{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } }] } as never, "claude-fable-5-1")).toBe(true);
    expect(fallbackWasServed({ model: "claude-fable-5-1", content: [] } as never, "claude-fable-5-1")).toBe(false);
  });
});
