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
  const retrievalNames = new Set(["web_search", "web_fetch", "scholar_search"]);
  const tools = o.tools.map((tool): AgentTool<any> => ({
    ...tool,
    async execute(...args) {
      if (retrievalNames.has(tool.name)) {
        if (retrievals >= retrievalLimit) {
          o.record.append({ t: "note", text: "Scout retrieval limit reached; an additional network request was not dispatched." });
          return { content: [{ type: "text", text: "Retrieval budget is exhausted. No request was made. Return the supported findings from existing results and explicitly list what remains unknown." }], isError: true };
        }
        retrievals += 1;
      }
      const result = await tool.execute(...args);
      if (tool.name === "web_fetch" && result.isError !== true) successfulFetches += 1;
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
    finalizeWithoutTools: () => retrievals >= retrievalLimit,
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
    contextPressure: r.contextPressure === true,
    error: r.error,
    errorStatus: r.errorStatus,
    errorId: r.errorId,
    stopDetails: r.stopDetails,
  };
}
