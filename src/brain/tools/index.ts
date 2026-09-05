import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Phase } from "../../core/config";
import type { SearchStatus } from "../../core/events";
import type { Limiter } from "../../core/limiter";
import type { RunRecord } from "../../core/record";
import type { RunPaths } from "../../core/run";
import { throwIfRunCancelled } from "../../core/run-control";
import { redactText, redactValue, secretValues } from "../../core/secrets";
import { readTool } from "./read";
import { writeTool } from "./write";
import { editTool } from "./edit";
import { bashTool } from "./bash";
import { searchTool } from "./search";
import { webFetchTool, webSearchTool } from "./web";
import { noteTool } from "./note";
import { exitTool } from "./exit";
import { scoutTool } from "./scout";
import { scholarSearchTool } from "./scholar";
import { probeRequestTool } from "./probe-request";

export type ExitKind = "underspecified" | "no_idea_clears_bar" | "not_formable" | "cannot_be_satisfied";
export const EXIT_KINDS: ExitKind[] = ["underspecified", "no_idea_clears_bar", "not_formable", "cannot_be_satisfied"];

export interface ToolContext {
  cwd: string;
  /** Writable roots; write and edit refuse anything outside them. */
  roots: string[];
  run: RunPaths;
  record: RunRecord;
  fetchImpl?: typeof fetch;
  spawnScout?: (question: string) => Promise<string>;
  onExit?: (kind: ExitKind, reasons: string[]) => void;
  bashTimeoutMs?: number;
  /** Deadline for a single `web_search`/`web_fetch` request. Default 30s. */
  webTimeoutMs?: number;
  /** Contact address `scholar_search` sends to OpenAlex's polite pool; default `ideation.mailto`. */
  mailto?: string;
  /** Current ideate round, stamped on probe requests. */
  round?: number;
  /** Fired when the brain nominates ideas for probing; the phase collects them for the prober batch. */
  onProbeRequest?: (ideas: { ideaId: string; rationale: string }[]) => void;
  /** A gate separate from the model-work limiter. Network requests acquire it inside the tool. */
  searchLimiter?: Limiter;
  /** Maximum randomized delay before a gated request; tests may set it to zero. */
  searchJitterMs?: number;
  /** Direct per-scout health channel; the journal remains the run-level audit trail. */
  onSearchHealth?: (status: SearchStatus) => void;
  /** Ids the archive has accepted; their `ideas/<id>.md` files become harness-owned (record §10). */
  protectedIdeas?: Set<string>;
  /** Additional harness-owned files supplied by a phase (for example project.json in form). */
  protectedPaths?: string[];
  /** Additional harness-owned directory trees supplied by a phase. */
  protectedDirs?: string[];
  /** Per-phase honest exits. When absent, the historical global allowlist remains in force. */
  allowedExitKinds?: ExitKind[];
}

export { shapeResult } from "./shape";
export { insideRoots, isProtectedRunFile } from "./write";

/**
 * Wrap execute so every call is recorded with duration and a result excerpt. The record is a
 * durable file the user will read and paste around, so credentials are stripped from both the
 * arguments and the excerpt on the way in — the model still sees the unredacted result.
 */
export function recorded(ctx: ToolContext, tool: AgentTool<any>): AgentTool<any> {
  const inner = tool.execute;
  return {
    ...tool,
    intent: "omit",
    async execute(id, params, signal, onUpdate, c) {
      const t0 = Date.now();
      throwIfRunCancelled();
      const r = await inner.call(this, id, params, signal, onUpdate, c);
      throwIfRunCancelled();
      const text = r.content.map((b) => ("text" in b ? b.text : "")).join("\n");
      const values = secretValues();
      ctx.record.append({
        t: "tool.call",
        name: tool.name,
        args: redactValue(params, values),
        ok: r.isError !== true,
        durationMs: Date.now() - t0,
        excerpt: redactText(text.slice(0, 400), values),
      });
      return r;
    },
  };
}

type ToolFactory = (ctx: ToolContext) => AgentTool<any>;

/**
 * Every tool the harness can hand out, by name. The allowlists below are written in terms of these
 * names, so a tool a later task adds (`probe_request`, `scholar_search`) only has to be registered
 * here to appear in the phases that already reserve it.
 */
const FACTORIES: Record<string, ToolFactory> = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
  search: searchTool,
  web_search: webSearchTool,
  web_fetch: webFetchTool,
  scholar_search: scholarSearchTool,
  probe_request: probeRequestTool,
  scout: scoutTool,
  note: noteTool,
  exit: exitTool,
};

/**
 * Which tools the brain gets in each phase (record §10). `bash` is out of ideate — the loop's
 * artifacts are harness-owned and a shell is the one tool that can rewrite them out of band — and
 * returns in form and build with a scratch cwd. `scout` is for the two phases that research;
 * `probe_request` only for ideate, where probes exist.
 */
export const BUILDER_TOOL_NAMES: readonly string[] = ["read", "write", "edit", "bash", "search", "exit"];

export const PHASE_TOOLS: Record<Phase, readonly string[]> = {
  frame: ["read", "write", "edit", "bash", "search", "web_search", "web_fetch", "note", "exit"],
  discover: ["read", "write", "edit", "bash", "search", "web_search", "web_fetch", "scout", "note", "exit"],
  ideate: ["read", "write", "edit", "search", "web_search", "web_fetch", "scout", "probe_request", "note", "exit"],
  form: ["read", "write", "edit", "bash", "search", "web_search", "web_fetch", "note", "exit"],
  build: BUILDER_TOOL_NAMES,
  reflect: ["read", "write", "edit", "search", "note", "exit"],
};

/** A scout is read-only and researches: file reads and the three search paths. */
export const SCOUT_TOOL_NAMES: readonly string[] = ["read", "search", "web_search", "web_fetch", "scholar_search"];

/** Builds the named tools that exist today, in list order, each wrapped in the journal recorder. */
function build(ctx: ToolContext, names: readonly string[]): AgentTool<any>[] {
  return names.flatMap((n) => {
    const factory = FACTORIES[n];
    return factory ? [recorded(ctx, factory(ctx))] : [];
  });
}

export function brainTools(ctx: ToolContext, phase: Phase): AgentTool<any>[] {
  return build(ctx, PHASE_TOOLS[phase]);
}

export function scoutTools(ctx: ToolContext): AgentTool<any>[] {
  return build(ctx, SCOUT_TOOL_NAMES);
}

export function builderTools(ctx: ToolContext): AgentTool<any>[] {
  return build(ctx, BUILDER_TOOL_NAMES);
}
