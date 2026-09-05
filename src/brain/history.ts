import { filterProviderReplayMessages, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ProviderConfig } from "../core/config";

export type ReminderKind = "batch" | "finish" | "budget";

export const BATCH_REMINDER = "First privately list what you need next; then request every item that doesn't depend on another's result in this one response.";
export const FINISH_REMINDER = "Wrap up: finish the current step, then call exit or deliver now";
export const BUDGET_REMINDER = "You have ample context remaining. Do not stop, summarize, or suggest a new session on account of context limits. Continue the work.";

const REMINDER_TEXT: Record<ReminderKind, string> = {
  batch: BATCH_REMINDER,
  finish: FINISH_REMINDER,
  budget: BUDGET_REMINDER,
};

type ReminderConfig = { provider: Pick<ProviderConfig, "reminders"> };

function isProviderMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "developer" || message.role === "assistant" || message.role === "toolResult";
}

/** Keep only provider-visible history, excluding terminal provider refusals. */
export function toProviderMessages(messages: AgentMessage[]): Message[] {
  return filterProviderReplayMessages(messages.filter(isProviderMessage));
}

/** Build a transient reminder in the strongest form supported by the selected seat. */
export function reminder(kind: ReminderKind, model: Model, cfg: ReminderConfig): AgentMessage {
  const message = { content: REMINDER_TEXT[kind], timestamp: Date.now() };
  const turnScoped = model.compat && "supportsTurnScopedSystem" in model.compat && model.compat.supportsTurnScopedSystem;
  if (turnScoped && cfg.provider.reminders !== "text_block") {
    return {
      role: "developer",
      ...message,
      providerPayload: { type: "anthropicMessage", clearAt: "next_user_message" },
    };
  }
  return { role: "user", ...message };
}

/** Build a durable mid-conversation contract that is never cleared automatically. */
export function contractMessage(text: string): AgentMessage {
  return {
    role: "developer",
    content: text,
    providerPayload: { type: "anthropicMessage", clearAt: "never" },
    timestamp: Date.now(),
  };
}
