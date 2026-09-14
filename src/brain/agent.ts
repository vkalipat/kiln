import { Agent, AppendOnlyContextManager, TERMINAL_TOOL_RESULT_ABORT_REASON, type AgentMessage, type AgentState, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { Phase, ReminderPolicy, Role } from "../core/config";
import type { FailureStopDetails } from "../core/failure";
import { excerpt, hashInput, type RunRecord } from "../core/record";
import { currentRunControl, throwIfRunCancelled, type RunSourceRegistration } from "../core/run-control";
import { redactText, redactValue, secretValues } from "../core/secrets";
import { clampEffort, modelCostUsd, modelFamily, usesKilnCodeMode, type EffortName } from "../providers/models";
import { shapingStreamFn, type ShapingOptions } from "../providers/shaping";
import { composeAddenda, type ComposedAddenda } from "./addenda";
import { adaptiveEvidencePrompt } from "./adaptive-evidence";
import { contextPressure } from "./context";
import { contractMessage, reminder, toProviderMessages } from "./history";
import { contextInputHash, fallbackCostUsd, fallbackWasServed, toolExcerpt } from "./telemetry";
import { createCodeModeTool, type CodeModeToolEvent } from "./code-mode";

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
  /** Non-operator cancellation such as a phase wall deadline. Its reason is rethrown unchanged. */
  signal?: AbortSignal;
  streamFn?: StreamFn;
  onText?: (delta: string) => void;
  onTool?: (e: { toolCallId: string; name: string; args: unknown; phase: "start" | "end"; ok?: boolean; excerpt?: string }) => void;
  /** Producer-side tool-result hook. Returning true aborts before another model turn can start. */
  afterTool?: (e: { name: string; args: unknown; ok: boolean; excerpt?: string }) => boolean | void;
  /**
   * Opts a retrieval-heavy brain into a tool-free finishing window. Returning true after a tool
   * batch starts synthesis immediately; otherwise the final two available turns are reserved.
   */
  finalizeWithoutTools?: () => boolean;
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

function throwIfOptionSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "brain aborted");
}

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
  let finalizingWithoutTools = false;
  const reminderConfig = { provider: { reminders: o.reminders ?? o.shaping?.cfg.provider.reminders ?? "auto" } };
  const addenda = o.addenda ?? (o.shaping
    ? composeAddenda(o.model, o.phase === "form" ? "form" : o.role, o.shaping.cfg)
    : { family: modelFamily(o.model), ids: [], text: "", hash: hashInput({ ids: [], text: "" }) });
  const adaptiveEvidence = o.shaping ? adaptiveEvidencePrompt({
    cfg: o.shaping.cfg,
    role: o.role,
    phase: o.phase,
    toolNames: o.tools.map((tool) => tool.name),
    systemPrompt: o.systemPrompt,
    recordPath: o.record.path,
  }) : undefined;
  const rawEffort = o.effort ? clampEffort(o.model, o.effort) : undefined;
  const effortSent: EffortName | undefined = rawEffort;
  const shapedStream = o.shaping
    ? shapingStreamFn({ ...o.shaping, role: o.role, model: o.model }, o.streamFn)
    : o.streamFn;
  // Pi awaits its outer getApiKey callback before it reaches the signal-aware resolver path. Keep
  // that callback synchronous and defer credential work into the resolver, where the actual loop
  // signal covers RunControl cancellation, direct Agent.abort(), and provider request deadlines.
  const credentialResolver: ApiKeyResolver | undefined = o.getApiKey ? ({ signal }) => {
    signal?.throwIfAborted();
    return raceWithSignal(Promise.resolve().then(o.getApiKey!), signal);
  } : undefined;

  const terminalToolNames = new Set(["exit", ...(o.terminalTools ?? [])]);
  let agent!: Agent;
  const codeMode = usesKilnCodeMode(o.model);
  if (codeMode && o.tools.some((tool) => tool.name === "exec")) throw new Error("exec is reserved for the Code Mode host");
  let codeModeExit = false;
  const toolStarted = (id: string, name: string, args: unknown) => {
    pendingArgs.set(id, args);
    o.onTool?.({ toolCallId: id, name, args, phase: "start" });
    runSource?.toolStart(id, name, args);
  };
  const toolEnded = (id: string, name: string, result: Parameters<typeof toolExcerpt>[0], isError: boolean) => {
    const args = pendingArgs.get(id);
    pendingArgs.delete(id);
    const normalizedError = loopNormalizedTerminalErrors.delete(id);
    const ok = normalizedError ? false : !isError;
    const resultExcerpt = toolExcerpt(result);
    o.onTool?.({ toolCallId: id, name, args, phase: "end", ok, excerpt: resultExcerpt });
    runSource?.toolEnd(id, name, ok, resultExcerpt);
  };
  const guardedTools = o.tools.map((tool) => {
    if (!terminalToolNames.has(tool.name)) return tool;
    const execute = tool.execute;
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, context) {
        // Terminal work must not strand a user message in pi's queue. Defer the side effect and
        // let the loop inject that message at the boundary; the model can decide again afterward.
        if (agent.peekSteeringQueue().length > 0) {
          return { content: [{ type: "text" as const, text: "Deferred because new user steering is pending; reconsider this terminal decision after handling it." }], isError: true };
        }
        return execute.call(tool, toolCallId, params, signal, onUpdate, context);
      },
    } as AgentTool<any>;
  });
  const execTool = codeMode ? createCodeModeTool({
    getTools: () => agent.state.tools.filter((tool) => tool.name !== "exec"),
    onToolStart: ({ toolCallId, name, args }) => toolStarted(toolCallId, name, args),
    onToolEnd: ({ toolCallId, name, result, ok }) => toolEnded(toolCallId, name, result!, ok === false),
    onAfterTool: (event) => agent.peekSteeringQueue().length === 0
      && o.afterTool?.({ name: event.name, args: event.args, ok: event.ok === true, excerpt: toolExcerpt(event.result!) }) === true
      && agent.peekSteeringQueue().length === 0,
    isTerminal: (event: CodeModeToolEvent) => {
      if (!event.ok || agent.peekSteeringQueue().length > 0 || !terminalToolNames.has(event.name)) return false;
      if (event.name === "exit") codeModeExit = true;
      return true;
    },
  }) : undefined;
  if (execTool) {
    const execute = execTool.execute;
    execTool.execute = async (...args) => {
      const started = performance.now();
      const result = await execute.apply(execTool, args);
      const values = secretValues();
      const output = redactText(result.content.map((part) => "text" in part ? part.text : "").join("\n"), values);
      o.record.append({ t: "tool.call", name: "exec", args: redactValue(args[1], values), ok: result.isError !== true,
        durationMs: performance.now() - started, excerpt: output.slice(0, 400), resultChars: output.length, excerptTruncated: output.length > 400 });
      return result;
    };
  }
  const registeredTools = execTool ? [...guardedTools, execTool] : guardedTools;
  agent = new Agent({
    initialState: {
      systemPrompt: [...o.systemPrompt, ...(adaptiveEvidence ? [adaptiveEvidence] : []), ...(addenda.text ? [addenda.text] : []), pinnedBlock(o.pinned)],
      model: o.model,
      tools: registeredTools,
      // `clampEffort` returns the same strings as the catalog's `Effort` const enum, which
      // structurally-identical string unions cannot be assigned to without a cast.
      thinkingLevel: effortSent as AgentState["thinkingLevel"],
    },
    streamFn: shapedStream,
    getApiKey: () => credentialResolver ?? o.apiKey,
    convertToLlm: toProviderMessages,
    appendOnlyContext: new AppendOnlyContextManager(),
    // A live TUI message belongs at the next model boundary. Pi's immediate mode skips
    // not-yet-started calls from an already-completed assistant tool batch, which can turn a
    // repeated seed into synthetic failures and a needless paid retry. Wait mode preserves the
    // full tool/result pairing and still delivers the queued steering before the next model call;
    // external cancellation uses the separate abort signal and remains immediate.
    interruptMode: "wait",
    // Deliver all pending direction in order at the same boundary. A batching reminder must
    // not sit behind a user correction and defer an otherwise completed terminal decision.
    steeringMode: "all",
    transformProviderContext: (context) => {
      // Keep the original tools installed for phase withdrawals and validated host dispatch,
      // but send only the custom executor on the Code Mode wire. No JSON function tools leak.
      const allowed = context.tools?.filter((tool) => tool.name !== "exec") ?? [];
      const offered = codeMode && execTool ? {
        ...context,
        tools: allowed.length === 0 ? [] : [{
          ...execTool,
          description: `${execTool.description}\n\nAvailable tools (only these capabilities exist; schemas are binding; examples illustrate syntax, not task results):\n${JSON.stringify(allowed.map(({ name, description, parameters, examples }) => ({ name, description, parameters, ...(examples ? { examples } : {}) })))}\n\nAwait tools[toolName](arguments) with one of the names above. Use text(result) to retain useful output for the next model turn. Call terminal decision tools last.`,
        }],
      } : context;
      pendingHash = contextInputHash(offered);
      pendingRequests += 1;
      return offered;
    },
    onResponse: (response) => {
      pendingResponseStatus = response.status;
      pendingResponseId = response.requestId ?? undefined;
    },
  });
  if (execTool) {
    const setTools = agent.setTools.bind(agent);
    agent.setTools = (tools) => {
      const permitted = tools.filter((tool) => tool.name !== "exec");
      setTools(permitted.length > 0 ? [...permitted, execTool] : []);
    };
  }

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
    if (!finalizingWithoutTools && o.finalizeWithoutTools !== undefined
      && (o.finalizeWithoutTools() || turns >= o.turnCap - 2)) {
      finalizingWithoutTools = true;
      agent.setTools([]);
      agent.steer(contractMessage(
        "Stop retrieving now. Synthesize and return the requested findings from only the evidence already observed. "
        + "State material unknowns and failed retrievals explicitly; do not infer that missing evidence proves absence.",
      ));
      return;
    }
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
    if (codeMode && c.toolCall.name === "exec") {
      const terminal = (c.result.details as { codeMode?: { terminal?: boolean } } | undefined)?.codeMode?.terminal;
      if (terminal && !c.isError && agent.peekSteeringQueue().length === 0) {
        if (codeModeExit) exited = true;
        agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
      }
      codeModeExit = false;
      return undefined;
    }
    const abortAfterResult = agent.peekSteeringQueue().length === 0
      && o.afterTool?.({ name: c.toolCall.name, args: c.args, ok: !c.isError, excerpt: toolExcerpt(c.result) }) === true
      && agent.peekSteeringQueue().length === 0;
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
      toolStarted(e.toolCallId, e.toolName, e.args);
    }
    if (e.type === "tool_execution_end") {
      // `tool_execution_end` carries the result but not the arguments, so they are held from the
      // matching start event.
      toolEnded(e.toolCallId, e.toolName, e.result, e.isError === true);
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
      if (m.stopReason === "length") {
        error = "model reached its output-token limit before completing the response";
        stopDetails = { type: "output_limit" };
      }
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
      const fallbackServed = fallbackWasServed(m, o.model.id);
      const callCost = fallbackCostUsd(m, o.model.id) ?? modelCostUsd(o.model, m.usage);
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
        fallbackServed,
        reasoningTokens: m.usage.reasoningTokens,
        ttftMs: m.ttft,
      });
    }
  };

  return {
    agent,
    /** Usage owned by this brain's current run, never inferred from a concurrent journal. */
    get costUsd(): number { return runCost; },
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
      throwIfOptionSignalAborted(o.signal);
      running = true;
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;
      const abortForOperator = () => {
        cancelled = true;
        agent.abort(signal?.reason);
      };
      const abortForOption = () => agent.abort(o.signal?.reason);
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
      codeModeExit = false;
      if (o.finalizeWithoutTools !== undefined) {
        finalizingWithoutTools = false;
        agent.setTools(registeredTools);
      }
      // `Agent` swallows abort and provider errors into the transcript, but a bad prompt
      // (e.g. AgentBusyError) still rejects; either way the classification below is the same.
      try {
        runSource = control?.registerSource({
          role: o.role,
          phase: o.phase,
          steer: (text) => agent.steer({ role: "user", content: text, steering: true, attribution: "user", timestamp: Date.now() }),
        });
        unsubscribe = agent.subscribe(handleEvent);
        signal?.addEventListener("abort", abortForOperator, { once: true });
        o.signal?.addEventListener("abort", abortForOption, { once: true });
        throwIfRunCancelled(signal);
        throwIfOptionSignalAborted(o.signal);
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
        signal?.removeEventListener("abort", abortForOperator);
        o.signal?.removeEventListener("abort", abortForOption);
        unsubscribe?.();
        runSource?.dispose();
        runSource = undefined;
        running = false;
      }
      if (cancelled || signal?.aborted) throwIfRunCancelled(signal);
      throwIfOptionSignalAborted(o.signal);
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
