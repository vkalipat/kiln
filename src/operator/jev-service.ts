import { createHash, randomUUID } from "node:crypto";
import { evaluateWithJev, JEV_MODEL, type JevBatchDecision, type JevChoiceQuestion, type JevOptions, type JevState } from "../integrations/jev";
import type { ExternalMeterReservation, ExternalMeterTicket } from "./meter";

const MAX_REQUEST_INPUT_TOKENS = 64_000;
const INPUT_USD_PER_MILLION = 0.042;

export interface JevWorkflowStats {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  reservedInputTokens: number;
  unknownInputTokens: number;
}
export interface JevWorkflowDecision extends Omit<JevBatchDecision, "reason"> {
  reason: JevBatchDecision["reason"] | "call_budget" | "token_budget" | "allocation_budget";
  stateHash: string;
  dispatched: boolean;
  /** Zero only for a confirmed non-dispatch; missing after dispatch means unknown. */
  costUsd?: number;
  /** Consumer attribution: reused results have no additional dispatch, usage or charge. */
  reuse?: { kind: "origin" | "inflight" | "cache"; requestId: string };
}
export interface JevWorkflowServiceOptions {
  enabled: boolean;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  minConfidence?: number;
  maxCalls?: number;
  maxInputTokens?: number;
  initialStats?: JevWorkflowStats;
  cacheEntries?: number;
  cacheBytes?: number;
  signal: () => AbortSignal;
  reserve: (request: ExternalMeterReservation) => Promise<ExternalMeterTicket | undefined>;
  onStats: (stats: JevWorkflowStats) => void;
  onDecision?: (event: { operation: string; sessionId: string; stateHash: string; source: string; reason: string; latencyMs: number; usage?: JevBatchDecision["usage"]; requestId?: string }) => void;
  onReuse?: (event: { operation: string; sessionId: string; stateHash: string; kind: "inflight" | "cache"; requestId: string; reason: string; latencyMs: number }) => void;
}

type WorkflowRequest = { operation: "browser" | "research"; sessionId: string; state: JevState;
  questions: Record<string, JevChoiceQuestion>; signal?: AbortSignal };

/** Descriptor checks precede serialization: no getters, toJSON, cycles, or lossy JSON identities. */
function snapshotInput(request: WorkflowRequest): { state: JevState; questions: Record<string, JevChoiceQuestion> } {
  let remaining = 32000;
  const active = new Set<object>();
  function check(value: unknown, depth: number): void {
    if (--remaining < 0 || depth > 64) throw new Error("oversized input");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || active.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      || Object.getOwnPropertySymbols(value).length) throw new Error("non-JSON input");
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value) && (Object.keys(value).length !== value.length
      || Object.keys(value).some((key, index) => key !== String(index)))) throw new Error("sparse input");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("accessor input");
      check(descriptor.value, depth + 1);
    }
    active.delete(value);
  }
  const input = { state: request.state, questions: request.questions };
  check(input, 0);
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 65536) throw new Error("oversized input");
  return JSON.parse(serialized);
}

/** Run-owned service. Unknown and interrupted requests retain token and dollar exposure. */
export function createJevWorkflowService(options: JevWorkflowServiceOptions) {
  options = { ...options };
  const maxCalls = options.maxCalls ?? 64, maxInputTokens = options.maxInputTokens ?? 1_000_000;
  const capacity = options.cacheEntries ?? 32, byteCap = options.cacheBytes ?? 262144;
  if (![capacity, byteCap].every(n => Number.isSafeInteger(n) && n >= 0) || capacity > 1024 || byteCap > 16777216) throw new Error("Invalid Jev cache limits");
  if (![maxCalls, maxInputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid Jev workflow limits");
  const empty: JevWorkflowStats = { attempts: 0, inputTokens: 0, outputTokens: 0, reservedInputTokens: 0, unknownInputTokens: 0 };
  const counters: JevWorkflowStats = { ...(options.initialStats ?? empty) };
  if (Object.keys(empty).some(key => !Number.isSafeInteger(counters[key as keyof JevWorkflowStats]) || counters[key as keyof JevWorkflowStats] < 0)) {
    throw new Error("Invalid saved Jev workflow statistics");
  }
  // A saved in-flight request may have been billed. Its reservation cannot disappear on resume.
  counters.unknownInputTokens += counters.reservedInputTokens;
  counters.reservedInputTokens = 0;
  const stats = () => ({ ...counters });
  const persist = () => options.onStats(stats());
  persist();

  type Pending = { controller: AbortController; waiters: number; dispatched: boolean; requestId: string; promise: Promise<JevWorkflowDecision> };
  const pending = new Map<string, Pending>();
  const cache = new Map<string, { result: JevWorkflowDecision; bytes: number }>();
  let cacheBytes = 0, generation: AbortSignal | undefined;
  const clearCache = () => { cache.clear(); cacheBytes = 0; };
  const cancelled = (stateHash: string, entry?: Pending, origin = false): JevWorkflowDecision => ({
    source: "fallback", reason: "aborted", requestedModel: JEV_MODEL, stateHash, latencyMs: 0,
    dispatched: origin && !!entry?.dispatched, ...(origin && entry?.dispatched ? {} : { costUsd: 0 }),
    ...(entry ? { reuse: { kind: origin ? "origin" : "inflight", requestId: entry.requestId } as const } : {}),
  });
  async function execute(request: WorkflowRequest, stateHash: string, signal: AbortSignal, entry: Pending): Promise<JevWorkflowDecision> {
      let ticket: ExternalMeterTicket | undefined, reserved = false, dispatched = false;
      let denied: JevWorkflowDecision["reason"] | undefined;
      const start = performance.now();
      const transport: typeof fetch = (async (url, init) => {
        // Admission and counter reservation are synchronous before awaiting dollar admission.
        // Concurrent workers therefore cannot each consume the same final allowance.
        if (counters.attempts >= maxCalls) { denied = "call_budget"; throw new Error("Jev call allocation exhausted"); }
        if (counters.inputTokens + counters.unknownInputTokens + counters.reservedInputTokens + MAX_REQUEST_INPUT_TOKENS > maxInputTokens) {
          denied = "token_budget"; throw new Error("Jev input allocation exhausted");
        }
        counters.attempts++;
        counters.reservedInputTokens += MAX_REQUEST_INPUT_TOKENS;
        reserved = true;
        persist();
        ticket = await options.reserve({ provider: "typesafe", model: JEV_MODEL, sessionId: request.sessionId,
          reservedUsd: MAX_REQUEST_INPUT_TOKENS * INPUT_USD_PER_MILLION / 1e6, signal: init?.signal ?? signal });
        if (!ticket) { denied = "allocation_budget"; throw new Error("Jev dollar allocation exhausted"); }
        if (signal.aborted || init?.signal?.aborted) {
          ticket.settle({ costUsd: 0, reason: "Jev deadline expired before admission completed" });
          throw new Error("Jev request stopped before dispatch");
        }
        if (!ticket.dispatch()) throw new Error("Jev request cancelled before dispatch");
        dispatched = true;
        entry.dispatched = true;
        return (options.fetch ?? fetch)(url, init);
      }) as typeof fetch;
      let decision: JevBatchDecision | undefined;
      try {
        const config: JevOptions = { enabled: options.enabled, apiKey: options.apiKey, model: JEV_MODEL,
          timeoutMs: options.timeoutMs ?? 1500, minConfidence: options.minConfidence ?? 0.8, signal, fetch: transport };
        decision = await evaluateWithJev(request.state, request.questions, config);
        const result: JevWorkflowDecision = { ...decision, stateHash, dispatched, reuse: { kind: "origin", requestId: entry.requestId },
          ...(!dispatched ? { costUsd: 0 } : decision.usage ? { costUsd: decision.usage.input_tokens * INPUT_USD_PER_MILLION / 1e6 } : {}),
          ...(denied ? { source: "fallback", reason: denied } : {}),
          ...(signal.aborted ? { source: "fallback", reason: "aborted" as const, answers: undefined } : {}) };
        options.onDecision?.({ operation: request.operation, sessionId: request.sessionId, stateHash, source: result.source,
          reason: result.reason, requestId: entry.requestId, latencyMs: Math.round(performance.now() - start), ...(result.usage ? { usage: result.usage } : {}) });
        return result;
      } finally {
        const usage = decision?.usage;
        ticket?.settle(dispatched ? { ...(usage ? { costUsd: usage.input_tokens * INPUT_USD_PER_MILLION / 1e6,
          inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}), reason: `Jev ${request.operation}: ${denied ?? decision?.reason ?? "interrupted"}; pricing 2026-09-28` }
          : { costUsd: 0, reason: "Jev workflow was not dispatched" });
        if (reserved) {
          counters.reservedInputTokens -= MAX_REQUEST_INPUT_TOKENS;
          if (dispatched && usage) { counters.inputTokens += usage.input_tokens; counters.outputTokens += usage.output_tokens; }
          else if (dispatched) counters.unknownInputTokens += MAX_REQUEST_INPUT_TOKENS;
          persist();
        }
      }
  }
  return {
    stats,
    evaluate(request: WorkflowRequest): Promise<JevWorkflowDecision> {
      const runSignal = options.signal();
      if (runSignal !== generation) {
        generation?.removeEventListener("abort", clearCache);
        clearCache();
        for (const entry of pending.values()) entry.controller.abort();
        pending.clear();
        generation = runSignal;
        runSignal.addEventListener("abort", clearCache, { once: true });
      }
      if (runSignal.aborted || request.signal?.aborted) return Promise.resolve(cancelled(""));
      let snapshot: ReturnType<typeof snapshotInput>, stateHash: string;
      try {
        snapshot = snapshotInput(request);
        stateHash = createHash("sha256").update(JSON.stringify({ version: 1, ...snapshot,
          operation: request.operation, model: JEV_MODEL, minConfidence: options.minConfidence ?? 0.8 })).digest("hex");
      } catch {
        return Promise.resolve({ source: "fallback", reason: "invalid_input", requestedModel: JEV_MODEL,
          stateHash: "", latencyMs: 0, dispatched: false, costUsd: 0 });
      }
      const cached = cache.get(stateHash);
      if (cached) {
        cache.delete(stateHash); cache.set(stateHash, cached);
        const { usage: _usage, ...value } = structuredClone(cached.result);
        const result: JevWorkflowDecision = { ...value, dispatched: false, costUsd: 0, latencyMs: 0,
          reuse: { kind: "cache", requestId: cached.result.reuse!.requestId } };
        options.onReuse?.({ operation: request.operation, sessionId: request.sessionId, stateHash,
          kind: "cache", requestId: result.reuse!.requestId, reason: result.reason, latencyMs: 0 });
        return Promise.resolve(result);
      }
      let entry = pending.get(stateHash), origin = false;
      if (!entry || entry.controller.signal.aborted) {
        origin = true;
        entry = { controller: new AbortController(), waiters: 0, dispatched: false, requestId: randomUUID(), promise: undefined! };
        pending.set(stateHash, entry);
        const current = entry;
        const physicalSignal = AbortSignal.any([runSignal, current.controller.signal]);
        current.promise = Promise.resolve().then(() => execute({ ...request, ...snapshot, signal: undefined }, stateHash, physicalSignal, current))
          .then(result => {
            if (result.source === "jev" && result.reason === "accepted" && result.usage && current.waiters > 0
              && !physicalSignal.aborted && generation === runSignal && capacity > 0) {
              const value = structuredClone(result), bytes = Buffer.byteLength(JSON.stringify(value)) + stateHash.length;
              if (bytes <= byteCap) {
                const old = cache.get(stateHash); if (old) cacheBytes -= old.bytes;
                cache.set(stateHash, { result: value, bytes }); cacheBytes += bytes;
                while (cache.size > capacity || cacheBytes > byteCap) {
                  const key = cache.keys().next().value!; cacheBytes -= cache.get(key)!.bytes; cache.delete(key);
                }
              }
            }
            return result;
          }).finally(() => { if (pending.get(stateHash) === current) pending.delete(stateHash); });
      }
      const current = entry;
      current.waiters++;
      const callerSignal = request.signal ? AbortSignal.any([runSignal, request.signal]) : runSignal;
      return new Promise((resolve, reject) => {
        let done = false;
        const cleanup = () => { done = true; callerSignal.removeEventListener("abort", abort); current.waiters--; };
        const abort = () => {
          if (done) return;
          cleanup();
          if (current.waiters === 0) {
            current.controller.abort();
            // Last waiter waits for bounded physical cleanup before releasing its scope.
            void current.promise.then(() => resolve(cancelled(stateHash, current, origin)), () => resolve(cancelled(stateHash, current, origin)));
          } else resolve(cancelled(stateHash, current, origin));
        };
        callerSignal.addEventListener("abort", abort, { once: true });
        current.promise.then(result => {
          if (done) return;
          if (callerSignal.aborted) { abort(); return; }
          cleanup();
          const value = structuredClone(result);
          if (origin) resolve(value);
          else {
            delete value.usage;
            const result: JevWorkflowDecision = { ...value, dispatched: false, costUsd: 0, reuse: { kind: "inflight", requestId: current.requestId } };
            try {
              if (result.reason !== "aborted") options.onReuse?.({ operation: request.operation, sessionId: request.sessionId, stateHash,
                kind: "inflight", requestId: current.requestId, reason: result.reason, latencyMs: result.latencyMs });
            } catch (error) { reject(error); return; }
            resolve(result);
          }
        }, error => { if (!done) { cleanup(); reject(error); } });
        if (callerSignal.aborted) abort();
      });
    },
  };
}
