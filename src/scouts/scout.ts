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
  contextPressure: boolean;
  error?: string;
  errorStatus?: number;
  errorId?: string;
  stopDetails?: BrainResult["stopDetails"];
}

/** Runs one stateless, read-only researcher and returns its final text. A scout keeps no state between calls. */
export async function runScout(o: ScoutOptions): Promise<ScoutResult> {
  const role = o.role ?? "scout";
  const brain = createBrain({
    model: o.model,
    apiKey: o.apiKey,
    getApiKey: o.getApiKey,
    tools: o.tools,
    systemPrompt: [loadPrompt(o.home, "kernel"), loadPrompt(o.home, "scout")],
    pinned: `Brief:\n${o.brief}`,
    record: o.record,
    role,
    phase: o.phase ?? "discover",
    turnCap: o.turnCap ?? DEFAULT_SCOUT_TURN_CAP,
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
    contextPressure: r.contextPressure === true,
    error: r.error,
    errorStatus: r.errorStatus,
    errorId: r.errorId,
    stopDetails: r.stopDetails,
  };
}
