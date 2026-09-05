import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import {
  BATCH_REMINDER,
  BUDGET_REMINDER,
  FINISH_REMINDER,
  contractMessage,
  reminder,
  toProviderMessages,
} from "../../src/brain/history";
import { defaultConfig } from "../../src/core/config";

const model = (supportsTurnScopedSystem: boolean): Model => ({
  compat: { supportsTurnScopedSystem },
} as unknown as Model);

const assistant = (text: string, stopType?: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "mock",
  provider: "mock",
  model: "mock",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: stopType ? "error" : "stop",
  stopDetails: stopType ? { type: stopType, category: "test" } : undefined,
  timestamp: 3,
} as Message);

describe("toProviderMessages", () => {
  test("keeps provider history in order and removes refusal assistant messages", () => {
    const user = { role: "user", content: "request", timestamp: 1 } satisfies Message;
    const developer = { role: "developer", content: "contract", timestamp: 2 } satisfies Message;
    const accepted = assistant("answer");
    const retryableError = assistant("keep retryable failure", "overloaded");
    const refused = assistant("must not replay", "refusal");
    const sensitive = assistant("must not replay either", "sensitive");
    const custom = { role: "custom", content: "host-only", timestamp: 5 } as unknown as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 6,
    } satisfies Message;

    const result = toProviderMessages([user, developer, accepted, retryableError, refused, sensitive, custom, toolResult]);

    expect(result).toEqual([user, developer, accepted, retryableError, toolResult]);
    expect(result[0]).toBe(user);
    expect(result[1]).toBe(developer);
    expect(result[2]).toBe(accepted);
    expect(result[3]).toBe(retryableError);
    expect(result[4]).toBe(toolResult);
  });
});

describe("reminder", () => {
  test("uses a turn-scoped developer message when the model and policy support it", () => {
    const cfg = defaultConfig();
    const before = Date.now();
    const message = reminder("batch", model(true), cfg);
    const after = Date.now();

    expect(message).toEqual({
      role: "developer",
      content: BATCH_REMINDER,
      providerPayload: { type: "anthropicMessage", clearAt: "next_user_message" },
      timestamp: expect.any(Number),
    });
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  test("falls back to a user text block when turn-scoped system messages are unsupported", () => {
    const message = reminder("finish", model(false), defaultConfig());

    expect(message).toEqual({ role: "user", content: FINISH_REMINDER, timestamp: expect.any(Number) });
    expect(FINISH_REMINDER).toBe("Wrap up: finish the current step, then call exit or deliver now");
    expect(FINISH_REMINDER).not.toMatch(/\d/);
  });

  test("text_block policy forces the user fallback even on a supporting model", () => {
    const cfg = defaultConfig();
    cfg.provider.reminders = "text_block";

    expect(reminder("budget", model(true), cfg)).toEqual({
      role: "user",
      content: BUDGET_REMINDER,
      timestamp: expect.any(Number),
    });
    expect(BUDGET_REMINDER).toBe("You have ample context remaining. Do not stop, summarize, or suggest a new session on account of context limits. Continue the work.");
    expect(BUDGET_REMINDER).not.toMatch(/\d/);
  });
});

describe("contractMessage", () => {
  test("builds a durable developer message", () => {
    expect(contractMessage("Feature: f02")).toEqual({
      role: "developer",
      content: "Feature: f02",
      providerPayload: { type: "anthropicMessage", clearAt: "never" },
      timestamp: expect.any(Number),
    });
  });
});
