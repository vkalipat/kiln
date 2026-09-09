import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { hashInput } from "../core/record";
import { redactText, secretValues } from "../core/secrets";

/** The request fields that determine the model-visible input, excluding provider bookkeeping. */
function canonicalMessage(value: unknown): unknown {
  const message = value as { role?: string; toolName?: string; content?: unknown; providerPayload?: unknown };
  const content = message.content;
  const blocks = typeof content === "string" ? content : Array.isArray(content)
    ? content.map((value) => {
        const block = value as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
        if (block.type === "toolCall") return { type: "toolCall", name: block.name, arguments: block.arguments };
        if (typeof block.text === "string") return { type: block.type ?? "text", text: block.text };
        if (typeof block.thinking === "string") return { type: "thinking", text: block.thinking };
        return { type: block.type ?? "unknown" };
      })
    : "";
  return { role: message.role, tool: message.toolName, content: blocks, providerPayload: message.providerPayload };
}

export function contextInputHash(context: Pick<Context, "systemPrompt" | "messages" | "tools">): string {
  return hashInput({
    system: context.systemPrompt ?? [],
    tools: (context.tools ?? []).map((tool) => tool.name),
    messages: context.messages.map(canonicalMessage),
  });
}

/** Flattened, redacted result text for live progress displays. */
export function toolExcerpt(result: unknown, maxChars = 400): string | undefined {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "")
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
  return text.length === 0 ? undefined : redactText(text.slice(0, maxChars), secretValues());
}

/** Detects both the served-model rewrite and Anthropic's explicit fallback boundary block. */
export function fallbackWasServed(message: Pick<AssistantMessage, "model" | "content">, requestedModel: string): boolean {
  return message.model !== requestedModel || message.content.some((block) => block.type === "fallback");
}

/**
 * Pi prices a fallback response from its per-attempt usage and served model. Top-level token
 * totals cannot reconstruct waived attempts or fallback credits, so only malformed fallback
 * telemetry may fall back to requested-model catalog pricing.
 */
export function fallbackCostUsd(
  message: Pick<AssistantMessage, "model" | "content" | "usage">,
  requestedModel: string,
): number | undefined {
  if (!fallbackWasServed(message, requestedModel)) return undefined;
  const total = message.usage.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}
