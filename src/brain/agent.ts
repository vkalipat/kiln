import { Agent, AppendOnlyContextManager, TERMINAL_TOOL_RESULT_ABORT_REASON, type AgentMessage, type AgentState, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { Effort, Phase, ReminderPolicy, Role } from "../core/config";
import type { FailureStopDetails } from "../core/failure";
import { excerpt, hashInput, type RunRecord } from "../core/record";
import { currentRunControl, throwIfRunCancelled, type RunSourceRegistration } from "../core/run-control";
import { clampEffort, modelCostUsd, modelFamily } from "../providers/models";
import { shapingStreamFn, type ShapingOptions } from "../providers/shaping";
import { composeAddenda, type ComposedAddenda } from "./addenda";
import { contextPressure } from "./context";
import { contractMessage, reminder, toProviderMessages } from "./history";
import { contextInputHash, fallbackWasServed, toolExcerpt } from "./telemetry";

export { contextInputHash } from "./telemetry";

export interface BrainOptions {
  model: Model;
  apiKey?: string;
  getApiKey?: () => Promise<string | undefined>;
  tools: AgentTool<any>[];
  systemPrompt: string[];
  pinned: string;
  record: RunRecord;
  role: Role;
  phase: Phase;
  turnCap: number;
  /** Dollar dispatch threshold checked at turn boundaries; the crossing turn is allowed to finish. */
  usdCap?: number;
  /** Spend from earlier completed sessions that share this capped unit. */
  spentUsd?: () => number;
  /** Turns from earlier durable sessions that share this capped unit. */
  priorTurns?: () => number;
  effort?: string;
  streamFn?: StreamFn;
  onText?: (delta: string) => void;
  onTool?: (e: { toolCallId: string; name: string; args: unknown; phase: "start" | "end"; ok?: boolean; excerpt?: string }) => void;
  /** Producer-side tool-result hook. Returning true aborts before another model turn can start. */
  afterTool?: (e: { name: string; args: unknown; ok: boolean; excerpt?: string }) => boolean | void;
  /** Overrides for the context-pressure check; the defaults come from `src/brain/context.ts`. */
  context?: { thresholdPercent?: number; keepRecentTokens?: number };
  /** Tools whose successful call ends the run immediately, like `exit` but reported as `done`. */
  terminalTools?: string[];
  /** Frozen model-family prompt material; composed by the addenda layer. */
  addenda?: ComposedAddenda;
  shaping?: ShapingOptions;
  reminders?: ReminderPolicy;
}

export interface BrainResult {
  text: string;
  turns: number;
  stopped: "done" | "turn_cap" | "usd_cap" | "exit" | "error" | "refused";
  /** What this `run` actually cost: the sum of `modelCostUsd` over the model calls it made.
   *  Attribution has to happen here, where the usage is known — a consumer diffing the shared
   *  journal by sequence number cannot tell its own calls from a concurrently running seat's. */
  costUsd: number;
  error?: string;
  /** HTTP status the provider reported for a failed call, so failure classification reads a field, not wording. */
  errorStatus?: number;
  /** The provider's structured error classifier for that call, stringified for the journal. */
  errorId?: string;
  stopDetails?: FailureStopDetails;
  /** True once the library's `shouldCompact` fired for any assistant message in this run (record §3). */
  contextPressure?: boolean;
}

const ABORT_TURN_CAP = "kiln:turn-cap";
const ABORT_USD_CAP = "kiln:usd-cap";

/**
 * Wraps a pi `Agent` with the run-level concerns kiln needs on every role: recording each model
 * call, counting turns against the phase cap, nudging then stopping the agent at the cap, honoring
 * the exit tool, and pruning stale tool output.
 */
export function createBrain(o: BrainOptions) {
  let turns = o.priorTurns?.() ?? 0;
  let lastText = "";
  let exited = false;
  let cappedAt = 0;
  let usdCapped = false;
  let reminded = false;
  let error: string | undefined;
  let errorStatus: number | undefined;
  let errorId: string | undefined;
  let stopDetails: FailureStopDetails | undefined;
  let refused = false;
  let pressure = false;
  let windowNoted = false;
  let runCost = 0;
  // One slot per assistant message: `transformProviderContext` is the only hook that sees the
  // payload actually dispatched, and it runs once per provider attempt, so the last hash written
  // is the one that produced the message and the count is that message's attempts.
  let pendingHash: string | undefined;
  let pendingRequests = 0;
  let pendingResponseStatus: number | undefined;
  let pendingResponseId: string | undefined;
  const pendingArgs = new Map<string, unknown>();
  const loopNormalizedTerminalErrors = new Set<string>();
  const pinnedBlock = (p: string) => `## Pinned\n${p}`;
  let runSource: RunSourceRegistration | undefined;
  let running = false;
  let pendingContract: string | undefined;
  const reminderConfig = { provider: { reminders: o.reminders ?? o.shaping?.cfg.provider.reminders ?? "auto" } };
  const addenda = o.addenda ?? (o.shaping
    ? composeAddenda(o.model, o.phase === "form" ? "form" : o.role, o.shaping.cfg)
    : { family: modelFamily(o.model), ids: [], text: "", hash: hashInput({ ids: [], text: "" }) });
  const rawEffort = o.effort ? clampEffort(o.model, o.effort) : undefined;
  const effortSent: Effort | undefined = rawEffort === undefined ? undefined
    : rawEffort === "low" || rawEffort === "medium" || rawEffort === "high" || rawEffort === "xhigh" ? rawEffort
    : (() => { throw new Error(`model ${o.model.id} resolved unsupported kiln effort ${rawEffort}`); })();
  const shapedStream = o.shaping
    ? shapingStreamFn({ ...o.shaping, role: o.role, model: o.model }, o.streamFn)
    : o.streamFn;

  const agent = new Agent({
    initialState: {
      systemPrompt: [...o.systemPrompt, ...(addenda.text ? [addenda.text] : []), pinnedBlock(o.pinned)],
      model: o.model,
      tools: o.tools,
      // `clampEffort` returns the same strings as the catalog's `Effort` const enum, which
      // structurally-identical string unions cannot be assigned to without a cast.
      thinkingLevel: effortSent as AgentState["thinkingLevel"],
    },
    streamFn: shapedStream,
    getApiKey: async () => (o.getApiKey ? await o.getApiKey() : o.apiKey),
    convertToLlm: toProviderMessages,
    appendOnlyContext: new AppendOnlyContextManager(),
    transformProviderContext: (context) => {
      pendingHash = contextInputHash(context);
      pendingRequests += 1;
      return context;
    },
    onResponse: (response) => {
      pendingResponseStatus = response.status;
      pendingResponseId = response.requestId ?? undefined;
    },
  });

  agent.setBeforeModelCall(() => {
    if (turns >= o.turnCap) {
      cappedAt = Math.max(1, turns);
      return { stop: true, reason: ABORT_TURN_CAP };
    }
    if (o.usdCap !== undefined && (o.spentUsd?.() ?? 0) + runCost >= o.usdCap) {
      usdCapped = true;
      return { stop: true, reason: ABORT_USD_CAP };
    }
    return undefined;
  });

  const family = modelFamily(o.model);
  const nonTerminalTools = o.tools.filter((tool) => tool.name !== "exit" && !o.terminalTools?.includes(tool.name)).length;
  agent.setOnTurnEnd((_messages, _signal, context) => {
    if (!context?.willContinue || context.toolResults.length === 0 || exited) return;
    if (!reminded && turns >= o.turnCap - 3) {
      reminded = true;
      agent.steer(reminder("finish", o.model, reminderConfig));
      return;
    }
    if ((o.shaping?.cfg.provider.batchNudge ?? true) && family !== "other" && nonTerminalTools > 1) {
      agent.steer(reminder("batch", o.model, reminderConfig));
    }
  });

  // The exit tool ends the run. This producer-side hook runs before the loop emits the result and
  // moves on, so it is what actually prevents the next model call; the `tool_execution_end`
  // listener below is delivered too late to stop one. The abort reason must be the library's
  // terminal-tool-result symbol: any other reason lets the loop open one more turn and record a
  // phantom aborted model call.
  agent.afterToolCall = (c) => {
    const abortAfterResult = o.afterTool?.({ name: c.toolCall.name, args: c.args, ok: !c.isError, excerpt: toolExcerpt(c.result) }) === true;
    if (abortAfterResult) {
      agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
      // pi-agent-core only honors its terminal-result abort after an error tool when the post-hook
      // result itself is non-error. The recorded wrapper has already persisted the real `ok:false`
      // outcome, so normalize only the loop-facing copy to stop before another paid call.
      if (c.isError) {
        loopNormalizedTerminalErrors.add(c.toolCall.id);
        return { isError: false };
      }
    }
    if (c.isError) return undefined;
    if (c.toolCall.name === "exit") {
      exited = true;
      agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
    } else if (o.terminalTools?.includes(c.toolCall.name)) {
      // A decision tool (verdict, probe_spec, collision, ...) is the whole answer: stop before the
      // loop spends another model call narrating it.
      agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
    }
    return undefined;
  };

  const handleEvent: Parameters<typeof agent.subscribe>[0] = (e) => {
    if (e.type === "turn_start") {
      turns += 1;
      o.record.append({ t: "turn", role: o.role, phase: o.phase, n: turns });
    }
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      o.onText?.(e.assistantMessageEvent.delta);
      runSource?.text(e.assistantMessageEvent.delta);
    }
    if (e.type === "tool_execution_start") {
      pendingArgs.set(e.toolCallId, e.args);
      o.onTool?.({ toolCallId: e.toolCallId, name: e.toolName, args: e.args, phase: "start" });
      runSource?.toolStart(e.toolCallId, e.toolName, e.args);
    }
    if (e.type === "tool_execution_end") {
      // `tool_execution_end` carries the result but not the arguments, so they are held from the
      // matching start event.
      const args = pendingArgs.get(e.toolCallId);
      pendingArgs.delete(e.toolCallId);
      const normalizedError = loopNormalizedTerminalErrors.delete(e.toolCallId);
      const ok = normalizedError ? false : !e.isError;
      const resultExcerpt = toolExcerpt(e.result);
      o.onTool?.({ toolCallId: e.toolCallId, name: e.toolName, args, phase: "end", ok, excerpt: resultExcerpt });
      runSource?.toolEnd(e.toolCallId, e.toolName, ok, resultExcerpt);
      if (exited) return;
    }
    if (e.type === "message_end" && e.message.role === "assistant") {
      const m = e.message;
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const messageErrorStatus = m.errorStatus ?? (m.errorMessage ? pendingResponseStatus : undefined);
      // pi's bitfield uses zero for "no classified error". Prefer a real provider request id
      // captured at response time when that sentinel is all the message carries.
      const nativeErrorId = m.errorId === undefined || m.errorId === 0 ? undefined : String(m.errorId);
      const messageErrorId = (m.errorMessage ? pendingResponseId : undefined) ?? nativeErrorId;
      const details = m.stopDetails && typeof m.stopDetails.type === "string"
        ? { type: m.stopDetails.type, ...(m.stopDetails.category === undefined ? {} : { category: m.stopDetails.category }) }
        : undefined;
      if (text.trim()) lastText = text;
      if (m.errorMessage) error = m.errorMessage;
      if (details) stopDetails = details;
      if (m.stopReason === "error" && (details?.type === "refusal" || details?.type === "sensitive")) refused = true;
      if (messageErrorStatus !== undefined) errorStatus = messageErrorStatus;
      // The journal wants the provider request id. When a transport supplied none, retain a
      // non-zero library classification id as a textual fallback rather than losing all identity.
      if (messageErrorId !== undefined) errorId = String(messageErrorId);
      // The slot is consumed even for a message that is not recorded below, so the next assistant
      // message can never inherit a stale hash or attempt count.
      const inputHash = pendingHash ?? hashInput({ system: agent.state.systemPrompt, messages: agent.state.messages.length });
      const requests = pendingRequests;
      pendingHash = undefined;
      pendingRequests = 0;
      pendingResponseStatus = undefined;
      pendingResponseId = undefined;
      // A turn-cap abort makes the loop synthesize a gate-stop assistant message that never
      // reached a provider (stopReason "aborted", zero usage). The `turn` event already records
      // that the cap was hit; a `model.call` for it would be a call that never happened.
      const u = m.usage;
      if (m.stopReason === "aborted" && u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0) return;
      const filling = windowNoted ? undefined : contextPressure(o.model, m.usage, o.context);
      if (filling === undefined && !windowNoted) {
        windowNoted = true;
        o.record.append({ t: "note", text: `${o.model.id} declares no context window; the compaction trigger is disabled for this run` });
      } else if (filling === true) {
        pressure = true;
      }
      const callCost = modelCostUsd(o.model, m.usage);
      runCost += callCost;
      o.record.append({
        t: "model.call",
        role: o.role,
        provider: m.provider,
        model: m.model,
        effort: o.effort,
        effortSent,
        addendaHash: addenda.hash,
        inputHash,
        usage: { input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite },
        costUsd: callCost,
        durationMs: m.duration,
        stopReason: m.stopReason,
        excerpt: excerpt(text).text,
        error: m.errorMessage,
        errorStatus: messageErrorStatus,
        errorId: messageErrorId,
        requests: requests > 0 ? requests : undefined,
        stopDetails: details,
        fallbackServed: fallbackWasServed(m, o.model.id),
        reasoningTokens: m.usage.reasoningTokens,
        ttftMs: m.ttft,
      });
    }
  };

  return {
    agent,
    pushContract(contract: string) {
      if (running) throw new Error("cannot push a contract while the brain is running");
      if (pendingContract !== undefined) throw new Error("a contract is already pending");
      pendingContract = contract;
    },
    async run(prompt: string): Promise<BrainResult> {
      if (running) throw new Error("brain is already running");
      const control = currentRunControl();
      const signal = control?.signal;
      throwIfRunCancelled(signal);
      running = true;
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;
      const abort = () => {
        cancelled = true;
        agent.abort(signal?.reason);
      };
      exited = false;
      cappedAt = 0;
      usdCapped = false;
      error = undefined;
      errorStatus = undefined;
      errorId = undefined;
      stopDetails = undefined;
      refused = false;
      pressure = false;
      // Per-run state: without this, a run that produces no assistant text (an immediate cap or
      // error) would return the previous run's answer as if the model had just said it, and a
      // second `run` on the same brain would re-bill the first one's calls.
      lastText = "";
      runCost = 0;
      pendingHash = undefined;
      pendingRequests = 0;
      pendingResponseStatus = undefined;
      pendingResponseId = undefined;
      const before = turns;
      pendingArgs.clear();
      loopNormalizedTerminalErrors.clear();
      // `Agent` swallows abort and provider errors into the transcript, but a bad prompt
      // (e.g. AgentBusyError) still rejects; either way the classification below is the same.
      try {
        runSource = control?.registerSource({
          role: o.role,
          phase: o.phase,
          steer: (text) => agent.steer({ role: "user", content: text, steering: true, attribution: "user", timestamp: Date.now() }),
        });
        unsubscribe = agent.subscribe(handleEvent);
        signal?.addEventListener("abort", abort, { once: true });
        throwIfRunCancelled(signal);
        const contract = pendingContract;
        pendingContract = undefined;
        if (contract === undefined) {
          await agent.prompt(prompt);
        } else {
          const user: AgentMessage = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
          await agent.prompt([user, contractMessage(contract)]);
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        signal?.removeEventListener("abort", abort);
        unsubscribe?.();
        runSource?.dispose();
        runSource = undefined;
        running = false;
      }
      if (cancelled || signal?.aborted) throwIfRunCancelled(signal);
      const n = turns - before;
      const pressed = pressure ? { contextPressure: true as const } : {};
      const base = { text: lastText, turns: n, costUsd: runCost, ...pressed };
      if (exited) return { ...base, stopped: "exit" };
      if (cappedAt > 0) return { ...base, stopped: "turn_cap" };
      if (usdCapped) return { ...base, stopped: "usd_cap" };
      if (refused) return { ...base, stopped: "refused", error, errorStatus, errorId, stopDetails };
      if (error) return { ...base, stopped: "error", error, errorStatus, errorId, stopDetails };
      return { ...base, stopped: "done" };
    },
  };
}
