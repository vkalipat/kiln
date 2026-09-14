import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import type { KilnConfig, Phase, Role } from "../core/config";
import type { SearchStatus } from "../core/events";
import type { RunRecord } from "../core/record";
import { effortFor } from "../providers/models";

export interface ScoutOptions {
  question: string;
  brief: string;
  model: Model;
  apiKey?: string;
  getApiKey?: () => Promise<string | undefined>;
  tools: AgentTool<any>[];
  record: RunRecord;
  home: string;
  cfg: KilnConfig;
  runId: string;
  turnCap?: number;
  usdCap?: number;
  spentUsd?: () => number;
  signal?: AbortSignal;
  /** Cooperative retrieval cutoff; unlike signal, leaves the model alive to summarize evidence. */
  retrievalSignal?: AbortSignal;
  /** Bound external retrieval fanout while reserving an answer turn. */
  retrievalLimit?: number;
  streamFn?: StreamFn;
  /** Which seat this research is billed to; a prior-art scout runs under `arbiter` or `scout`. */
  role?: Role;
  /** The phase the journal should attribute the turns to; prior-art scouts run inside ideate. */
  phase?: Phase;
  /** Mutable collector owned by this scout's tool context. It is copied into the result, so
   *  callers never recover health from a shared journal sequence window. */
  searchHealth?: SearchStatus[];
}

/** Findings go straight into the brain's context, so they are capped rather than spilled to a file. */
const FINDINGS_LIMIT = 6000;

/** Default turn budget for one scout; a scout that hasn't answered in this many turns won't. */
const DEFAULT_SCOUT_TURN_CAP = 20;

/** Planning floor, not a guarantee: two retrieval turns and one supported answer. Inputs
 *  allow for prompts/brief plus retrieved context; the first turn covers cache-write pricing,
 *  later turns use uncached list rates (no assumed cache discount). Output assumptions include
 *  reasoning, not just the final 6k-character findings. Large briefs raise the input estimates. */
export function scoutCompletionBudget(model: Model, brief: string): { minimumUsd: number; retrievalUsd: number; answerUsd: number } {
  const promptInput = Math.max(8_000, Math.ceil(brief.length / 3) + 4_000);
  const answerInput = Math.max(10_000, promptInput + 2_000);
  const rate = model.cost;
  const firstRetrieval = (promptInput * Math.max(rate.input, rate.cacheWrite) + 1_500 * rate.output) / 1_000_000;
  const nextRetrieval = (promptInput * rate.input + 1_500 * rate.output) / 1_000_000;
  const answer = (answerInput * rate.input + 4_000 * rate.output) / 1_000_000;
  const margin = 1.1;
  return { minimumUsd: (firstRetrieval + nextRetrieval + answer) * margin, retrievalUsd: firstRetrieval * margin, answerUsd: answer * margin };
}

export interface ScoutResult {
  findings: string;
  turns: number;
  /** Why the scout stopped. `error` and `turn_cap` mean the findings are missing or partial and
   *  the caller has to decide what that costs the phase. */
  stopped: BrainResult["stopped"];
  /** What this scout's model calls cost, measured inside the brain rather than diffed off the
   *  shared journal, which a concurrent seat would poison. */
  costUsd: number;
  /** Network-search outcomes made by this scout alone, in call order. */
  searchHealth: SearchStatus[];
  /** Direct source retrieval is separate from search-engine health. */
  successfulFetches?: number;
  /** URLs observed by this scout's successful retrievals, never sibling journal entries. */
  observedUrls: string[];
  /** Retrieval closed cooperatively for wall or dollars; an answer still needs observed evidence. */
  retrievalCutoff?: boolean;
  contextPressure: boolean;
  error?: string;
  errorStatus?: number;
  errorId?: string;
  stopDetails?: BrainResult["stopDetails"];
}

/** Runs one stateless, read-only researcher and returns its final text. A scout keeps no state between calls. */
export async function runScout(o: ScoutOptions): Promise<ScoutResult> {
  const role = o.role ?? "scout";
  const retrievalLimit = o.retrievalLimit ?? 12;
  if (!Number.isInteger(retrievalLimit) || retrievalLimit < 1) throw new Error("scout retrievalLimit must be a positive integer");
  let retrievals = 0;
  let successfulFetches = 0;
  const observedUrls = new Set<string>();
  const observeUrl = (candidate: string) => {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") observedUrls.add(candidate);
    } catch { /* Malformed strings are not observed web URLs. */ }
  };
  const completionBudget = scoutCompletionBudget(o.model, o.brief);
  let dollarFinishing = false;
  const ownedSpend = (): number => (o.spentUsd?.() ?? 0) + brain.costUsd;
  const finishForDollars = (): boolean => {
    if (o.usdCap !== undefined && ownedSpend() + completionBudget.retrievalUsd + completionBudget.answerUsd > o.usdCap) dollarFinishing = true;
    return dollarFinishing;
  };
  const retrievalNames = new Set(["web_search", "web_fetch", "scholar_search"]);
  const tools = o.tools.map((tool): AgentTool<any> => ({
    ...tool,
    async execute(...args) {
      if (retrievalNames.has(tool.name)) {
        if (o.retrievalSignal?.aborted || dollarFinishing || (o.usdCap !== undefined && ownedSpend() >= o.usdCap) || retrievals >= retrievalLimit) {
          o.record.append({ t: "note", text: "Scout retrieval allowance closed; an additional network request was not dispatched." });
          return { content: [{ type: "text", text: "Retrieval budget is exhausted. No request was made. Return the supported findings from existing results and explicitly list what remains unknown." }], isError: true };
        }
        retrievals += 1;
        // The tool may queue behind a search limiter. Propagate the soft cutoff so it checks
        // again before network dispatch, without aborting the scout's subsequent answer turn.
        if (o.retrievalSignal) args[2] = args[2] ? AbortSignal.any([args[2], o.retrievalSignal]) : o.retrievalSignal;
      }
      const result = await tool.execute(...args);
      if (result.isError !== true && retrievalNames.has(tool.name)) {
        if (tool.name === "web_fetch") {
          successfulFetches += 1;
          const url = (args[1] as { url?: unknown } | undefined)?.url;
          if (typeof url === "string") observeUrl(url);
        } else {
          for (const part of result.content) {
            if (part.type !== "text") continue;
            for (const url of part.text.match(/https?:\/\/[^\s<>"'\])}]+/gi) ?? []) observeUrl(url);
          }
        }
      }
      return result;
    },
  }));
  const brain = createBrain({
    model: o.model,
    apiKey: o.apiKey,
    getApiKey: o.getApiKey,
    tools,
    systemPrompt: [loadPrompt(o.home, "kernel"), loadPrompt(o.home, "scout")],
    pinned: `You have at most ${retrievalLimit} external retrieval calls and ${o.turnCap ?? DEFAULT_SCOUT_TURN_CAP} model turns. Answer this one question, not the entire project. Prefer a few directly relevant primary sources; then synthesize supported findings and explicitly report gaps. Do not keep trying blocked mirrors indefinitely.\n\nBrief:\n${o.brief}`,
    record: o.record,
    role,
    phase: o.phase ?? "discover",
    turnCap: o.turnCap ?? DEFAULT_SCOUT_TURN_CAP,
    usdCap: o.usdCap,
    spentUsd: o.spentUsd,
    signal: o.signal,
    finalizeWithoutTools: () => o.retrievalSignal?.aborted === true || finishForDollars() || retrievals >= retrievalLimit,
    effort: effortFor(o.cfg, role, o.model),
    streamFn: o.streamFn,
    shaping: { cfg: o.cfg, runId: o.runId },
  });
  const r = await brain.run(`Question: ${o.question}\n\nReturn your findings now.`);
  return {
    findings: r.text.trim().slice(0, FINDINGS_LIMIT),
    turns: r.turns,
    stopped: r.stopped,
    costUsd: r.costUsd,
    searchHealth: [...(o.searchHealth ?? [])],
    successfulFetches,
    observedUrls: [...observedUrls],
    ...(o.retrievalSignal?.aborted || dollarFinishing ? { retrievalCutoff: true } : {}),
    contextPressure: r.contextPressure === true,
    error: r.error,
    errorStatus: r.errorStatus,
    errorId: r.errorId,
    stopDetails: r.stopDetails,
  };
}
