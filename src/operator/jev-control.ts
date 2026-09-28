import { createHash } from "node:crypto";
import { JEV_MODEL, type JevDecision, type JevOptions } from "../integrations/jev";
import { classifyOperatorStep } from "../routing/jev";

export const JEV_RUNTIME_STEPS = ["research", "ideate", "implement", "synthesize"] as const;
export type JevRuntimeStep = typeof JEV_RUNTIME_STEPS[number];
export interface JevControlOptions extends JevOptions {
  initialStats?: JevControlStats;
  maxCalls?: number;
  /** Stop new requests after this observed token total; the last request can cross it. */
  maxTokens?: number;
  cacheEntries?: number;
}
export interface JevControlRequest {
  fallback: JevRuntimeStep;
  allowedSteps?: readonly JevRuntimeStep[];
  /** Fixed tool/API requests bypass classification entirely. */
  explicitStep?: JevRuntimeStep;
  signal?: AbortSignal;
}
export interface JevControlDecision extends Omit<JevDecision<JevRuntimeStep>, "source" | "reason"> {
  source: "jev" | "fallback" | "local";
  reason: JevDecision<JevRuntimeStep>["reason"] | "explicit_step" | "single_choice" | "call_budget" | "token_budget" | "allocation_budget";
  cacheHit: boolean;
  inputHash: string;
  originLatencyMs?: number;
}
export interface JevControlStats {
  attempts: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  attemptsWithoutUsage: number;
}

/** One controller per operator run. It never dispatches models, persists summaries, or reviews a producer. */
export function createJevControl(options: JevControlOptions = {}) {
  // A controller owns one fixed policy; mutating the caller's options must not invalidate its cache identity.
  options = { ...options };
  const maxCalls = options.maxCalls ?? 64, maxTokens = options.maxTokens ?? 100000, capacity = options.cacheEntries ?? 128;
  if (![maxCalls, maxTokens, capacity].every(value => Number.isSafeInteger(value) && value >= 0)
    || capacity > 4096) throw new Error("Invalid Jev controller limits");
  const cache = new Map<string, JevControlDecision>();
  const emptyStats: JevControlStats = { attempts: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, attemptsWithoutUsage: 0 };
  if (options.initialStats && (Object.keys(emptyStats).some(key => !Number.isSafeInteger(options.initialStats![key as keyof JevControlStats])
    || options.initialStats![key as keyof JevControlStats] < 0) || options.initialStats.attemptsWithoutUsage > options.initialStats.attempts)) {
    throw new Error("Invalid saved Jev controller statistics");
  }
  const counters: JevControlStats = { ...(options.initialStats ?? emptyStats) };
  const model = options.model ?? JEV_MODEL;
  return {
    stats: (): JevControlStats => ({ ...counters }),
    clear: () => cache.clear(),
    async decide(summary: string, request: JevControlRequest): Promise<JevControlDecision> {
      const allowed = [...(request.allowedSteps ?? JEV_RUNTIME_STEPS)].sort();
      if (!allowed.length || new Set(allowed).size !== allowed.length
        || allowed.some(step => !JEV_RUNTIME_STEPS.includes(step)) || !allowed.includes(request.fallback)
        || (request.explicitStep !== undefined && !allowed.includes(request.explicitStep))) {
        throw new Error("Runtime Jev decisions require unique admitted non-review steps and an admitted fallback");
      }
      const inputHash = createHash("sha256").update(JSON.stringify({ version: 1, summary, allowed,
        model, confidence: options.minConfidence ?? 0.8 })).digest("hex");
      const local = (reason: JevControlDecision["reason"], choice = request.fallback, source: JevControlDecision["source"] = "fallback"): JevControlDecision =>
        ({ choice, source, reason, requestedModel: model, latencyMs: 0, cacheHit: false, inputHash });
      const signal = request.signal && options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal ?? options.signal;
      if (signal?.aborted) return local("aborted");
      if (request.explicitStep !== undefined) return local("explicit_step", request.explicitStep, "local");
      if (allowed.length === 1) return local("single_choice", allowed[0]!, "local");
      if (!options.enabled) return local("disabled");
      if (!options.apiKey?.trim()) return local("missing_key");
      const cached = cache.get(inputHash);
      if (cached) {
        counters.cacheHits++;
        cache.delete(inputHash); cache.set(inputHash, cached);
        const { usage: _usage, ...decision } = structuredClone(cached);
        return { ...decision, choice: cached.reason === "low_confidence" ? request.fallback : cached.choice,
          latencyMs: 0, originLatencyMs: cached.latencyMs, cacheHit: true };
      }
      if (counters.attempts >= maxCalls) return local("call_budget");
      if (counters.inputTokens + counters.outputTokens >= maxTokens) return local("token_budget");
      counters.attempts++;
      const decision = await classifyOperatorStep(summary, { ...options, signal, fallback: request.fallback, allowedSteps: allowed });
      if (decision.usage) { counters.inputTokens += decision.usage.input_tokens; counters.outputTokens += decision.usage.output_tokens; }
      else counters.attemptsWithoutUsage++;
      const result: JevControlDecision = { ...decision, choice: decision.choice as JevRuntimeStep, inputHash, cacheHit: false };
      // Cancellation is never converted into a cached routing decision, even if a transport won the race.
      if (signal?.aborted) return { ...local("aborted"), ...(decision.usage ? { usage: decision.usage } : {}), latencyMs: decision.latencyMs };
      if (capacity > 0 && (result.reason === "accepted" || result.reason === "low_confidence")) {
        cache.set(inputHash, structuredClone(result));
        while (cache.size > capacity) cache.delete(cache.keys().next().value!);
      }
      return result;
    },
  };
}
