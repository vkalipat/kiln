import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { KilnConfig, Role } from "../core/config";
import { modelFamily } from "./models";

export type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

/** Run-scoped provider mechanics shared by every seat. The caller supplies role/model per brain. */
export interface ShapingOptions {
  cfg: KilnConfig;
  runId: string;
  /** Optional caller hook composed before kiln's payload rewrite. */
  onPayload?: PayloadHook;
}

export interface ShapingSeat extends ShapingOptions {
  role: Role;
  model: Model;
}

const PRODUCER_ROLES = new Set<Role>(["brain", "builder"]);
const OPUS_FALLBACKS = ["claude-opus-5", "claude-opus-4-8"] as const;

const DECISION_TOOLS = new Set([
  "audit",
  "axis_map",
  "bws",
  "collision",
  "conflict",
  "critique",
  "novelty",
  "playbook_delta",
  "probe_request",
  "probe_spec",
  "verdict",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SINGLE_SCHEMA_KEYS = ["contains", "else", "if", "items", "not", "propertyNames", "then"] as const;
const ARRAY_SCHEMA_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const MAP_SCHEMA_KEYS = ["$defs", "definitions", "dependentSchemas", "patternProperties"] as const;
const STRICT_INCOMPATIBLE_SCHEMA_KEYS = ["$ref", "allOf", "oneOf", "patternProperties", "propertyNames"] as const;

function isDecisionToolName(name: string): boolean {
  if (DECISION_TOOLS.has(name)) return true;
  // Anthropic OAuth and escaped built-in transports add pi-ai's `_` wire prefix after kiln's
  // AgentTool has been converted. The payload hook runs after that conversion.
  return name.startsWith("_") && DECISION_TOOLS.has(name.slice(1));
}

/**
 * Anthropic strict tools require every object node to be closed and every declared property to be
 * required. Keep this predicate conservative: an unrecognizable subschema is safer left non-strict
 * than optimistically promoted into a request that the provider rejects.
 */
export function isStrictCompatibleSchema(schema: unknown, requireObjectRoot = true): boolean {
  const visiting = new Set<object>();

  const visit = (node: unknown, root: boolean): boolean => {
    if (!record(node) || visiting.has(node)) return false;
    visiting.add(node);

    if (STRICT_INCOMPATIBLE_SCHEMA_KEYS.some((key) => node[key] !== undefined)) return false;

    const types = Array.isArray(node.type) ? node.type : [node.type];
    const isObject = types.includes("object") || record(node.properties);
    if (root && !isObject) return false;

    if (isObject) {
      if (node.additionalProperties !== false || !record(node.properties) || !Array.isArray(node.required)) return false;
      const properties = Object.keys(node.properties);
      const required = node.required;
      if (required.some((key) => typeof key !== "string")) return false;
      const requiredNames = new Set(required as string[]);
      if (requiredNames.size !== required.length || requiredNames.size !== properties.length) return false;
      if (properties.some((key) => !requiredNames.has(key))) return false;
      for (const child of Object.values(node.properties)) if (!visit(child, false)) return false;
    }

    for (const key of SINGLE_SCHEMA_KEYS) {
      if (node[key] === undefined) continue;
      const value = node[key];
      if (key === "items" && Array.isArray(value)) {
        for (const child of value) if (!visit(child, false)) return false;
      } else if (!visit(value, false)) return false;
    }
    for (const key of ARRAY_SCHEMA_KEYS) {
      const value = node[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((child) => !visit(child, false))) return false;
    }
    for (const key of MAP_SCHEMA_KEYS) {
      const value = node[key];
      if (value === undefined) continue;
      if (!record(value)) return false;
      for (const child of Object.values(value)) if (!visit(child, false)) return false;
    }

    visiting.delete(node);
    return true;
  };

  return visit(schema, requireObjectRoot);
}

function withThinkingUpdates(payload: Record<string, unknown>, model: Model, cfg: KilnConfig): Record<string, unknown> | undefined {
  if (cfg.provider.thinkingDisplay !== "updates" || modelFamily(model) !== "fable" || !record(payload.thinking)) return undefined;
  if (payload.thinking.display === "updates") return undefined;
  return { ...payload, thinking: { ...payload.thinking, display: "updates" } };
}

function withStrictDecisionTools(payload: Record<string, unknown>, model: Model, cfg: KilnConfig): Record<string, unknown> | undefined {
  if (!cfg.provider.strictDecisionTools || model.api !== "anthropic-messages" || !Array.isArray(payload.tools)) return undefined;
  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (
      !record(tool) ||
      typeof tool.name !== "string" ||
      !isDecisionToolName(tool.name) ||
      tool.strict === true ||
      !isStrictCompatibleSchema(tool.input_schema)
    ) return tool;
    changed = true;
    return { ...tool, strict: true };
  });
  return changed ? { ...payload, tools } : undefined;
}

/**
 * Pure wire-body rewrite. `display: "updates"` intentionally changes only `thinking.display`:
 * pi-ai 18.1.3 has no supported option for the upstream beta header, so kiln must not fabricate an
 * `anthropic-beta` header here. The transport dependency can add support when the gap closes.
 */
export function shapeProviderPayload(payload: unknown, model: Model, cfg: KilnConfig): unknown | undefined {
  if (!record(payload)) return undefined;
  const thinking = withThinkingUpdates(payload, model, cfg);
  const current = thinking ?? payload;
  const strict = withStrictDecisionTools(current, model, cfg);
  return strict ?? thinking;
}

/** Payload callback bound to the seated model, with the provider-supplied model taking precedence. */
export function shapingOnPayload(seat: Pick<ShapingSeat, "cfg" | "model">): PayloadHook {
  return (payload, model) => shapeProviderPayload(payload, model ?? seat.model, seat.cfg);
}

function composePayloadHooks(hooks: readonly (PayloadHook | undefined)[]): PayloadHook {
  const active = hooks.filter((hook, index) => hook !== undefined && hooks.indexOf(hook) === index) as PayloadHook[];
  return async (payload, model) => {
    let current = payload;
    let changed = false;
    for (const hook of active) {
      const next = await hook(current, model);
      if (next === undefined) continue;
      current = next;
      changed = true;
    }
    return changed ? current : undefined;
  };
}

function supportsExplicitOpenAIResponsesCache(model: Model): boolean {
  return model.api === "openai-responses" &&
    model.compat !== undefined &&
    "supportsPromptCacheBreakpoints" in model.compat &&
    model.compat.supportsPromptCacheBreakpoints === true;
}

function fallbackChain(seat: ShapingSeat): Array<{ model: string }> | undefined {
  if (seat.cfg.provider.fallbacks !== "opus" || modelFamily(seat.model) !== "fable" || !PRODUCER_ROLES.has(seat.role)) return undefined;
  const chain = OPUS_FALLBACKS.filter((model) => model !== seat.model.id).map((model) => ({ model }));
  return chain.length > 0 ? chain : undefined;
}

/**
 * Merge run/seat request mechanics over a call without dropping caller-owned options. Fallbacks
 * are deliberately untouched: Task 4 owns construction and isolation policy for that chain.
 */
export function shapingStreamFn(seat: ShapingSeat, inner: StreamFn = streamSimple): StreamFn {
  const kilnPayload = shapingOnPayload(seat);
  return (model, context, options) => {
    // Provider policy owns fallbacks: stripping a caller value prevents an isolation seat from
    // silently crossing onto the producer's model.
    const { fallbacks: _callerFallbacks, ...original } = options ?? {};
    const eligiblePromptCache = seat.cfg.provider.promptCache && supportsExplicitOpenAIResponsesCache(seat.model);
    const fallbacks = fallbackChain(seat);
    const merged: SimpleStreamOptions = {
      ...original,
      cacheRetention: seat.cfg.provider.cacheRetention[seat.role] ?? "short",
      ...(fallbacks ? { fallbacks } : {}),
      ...(eligiblePromptCache ? {
        promptCacheKey: `${seat.runId}:${seat.role}`,
        promptCache: { mode: "explicit", ttl: "30m" },
      } : {}),
      ...(seat.cfg.provider.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: seat.cfg.provider.streamIdleTimeoutMs }
        : {}),
      onPayload: composePayloadHooks([original.onPayload, seat.onPayload, kilnPayload]),
    };
    return inner(model, context, merged);
  };
}
