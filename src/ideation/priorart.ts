import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import { scoutTools, type ToolContext } from "../brain/tools";
import type { IdeaShape } from "../core/config";
import type { SearchStatus } from "../core/events";
import type { Limiter } from "../core/limiter";
import type { PhaseDeps } from "../phases/frame";
import { effortFor } from "../providers/models";
import { runScout } from "../scouts/scout";
import type { Dossier } from "./dossier";

/**
 * Prior-art falsification (record §5). A templated facet query is answered by a short scout; an
 * arbiter then answers exactly one question: is some named artifact already this idea? Retrieval
 * is a falsifier, never a novelty score, and a search that did not work is `search_failed`, not
 * "novel".
 */

export type PriorArtStatus = "collided" | "not_falsified" | "search_failed";

export interface PriorArtFinding {
  status: PriorArtStatus;
  artifact?: { title: string; url: string };
  distance?: string;
  findings: string;
  searchOk: boolean;
  costUsd: number;
  contextPressure: boolean;
}

const DEFAULT_TEMPLATE = [
  "- Purpose: {purpose}",
  "- Mechanism: {mechanism}",
  "- How it would be evaluated: {evaluation}",
  "- Idea shape: {shape}",
  "Question: Does an existing artifact already implement this mechanism for this purpose? Name the closest ones with URLs.",
].join("\n");

/** The `## prior art` template from the scout prompt, or the built-in one when the section is missing. */
export function priorArtTemplate(home: string): string {
  const md = loadPrompt(home, "scout");
  const section = md.split(/^## prior art\s*$/mi)[1];
  if (!section) return DEFAULT_TEMPLATE;
  const at = section.indexOf("Template:");
  const body = (at === -1 ? section : section.slice(at + "Template:".length)).trim();
  return body === "" ? DEFAULT_TEMPLATE : body;
}

/** Fill the facet query from dossier fields: purpose from the claim and audience, mechanism, evaluation from the cheapest test. */
export function facetQuery(d: Dossier, shape: IdeaShape, template = DEFAULT_TEMPLATE): string {
  const who = d.axisValues["who it serves"] ?? Object.values(d.axisValues)[0] ?? "";
  const purpose = who ? `${d.testableClaim} (for ${who})` : d.testableClaim;
  return template
    .replace("{purpose}", purpose)
    .replace("{mechanism}", `${d.title}: ${d.mechanism}`)
    .replace("{evaluation}", d.cheapestTest)
    .replace("{shape}", shape);
}

export interface CollisionVerdict {
  same: boolean;
  artifactTitle?: string;
  artifactUrl?: string;
  reason: string;
  costUsd: number;
}

/** One arbiter call: is a named artifact with a URL already this idea? A `same` without a URL is not a collision. */
export async function collisionVerdict(deps: PhaseDeps, d: Dossier, findings: string): Promise<CollisionVerdict> {
  const { model } = deps.models("arbiter");
  let captured: { same: boolean; artifactTitle?: string; artifactUrl?: string; reason: string } | undefined;
  const tool: AgentTool<any> = {
    name: "collision",
    label: "Collision",
    intent: "omit",
    description: "Say whether a specific existing artifact (with a URL) already is this idea: same mechanism for the same purpose.",
    parameters: {
      type: "object",
      properties: { same: { type: "boolean" }, artifactTitle: { type: "string" }, artifactUrl: { type: "string" }, reason: { type: "string" } },
      required: ["same", "reason"],
    },
    examples: [{ caption: "A collision", call: { same: true, artifactTitle: "Foo", artifactUrl: "https://example.com/foo", reason: "Foo does exactly this for the same users." } }],
    async execute(_id, p: { same?: boolean; artifactTitle?: string; artifactUrl?: string; reason?: string }) {
      captured = { same: p.same === true, artifactTitle: p.artifactTitle?.trim() || undefined, artifactUrl: p.artifactUrl?.trim() || undefined, reason: String(p.reason ?? "").trim() };
      return { content: [{ type: "text" as const, text: "collision verdict recorded" }] };
    },
  };
  const brain = createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "arbiter")],
    pinned: `Collision question for idea ${d.id}.`,
    record: deps.record,
    role: "arbiter",
    phase: "ideate",
    turnCap: 2,
    effort: effortFor(deps.cfg, "arbiter", model),
    streamFn: deps.streamFn,
    terminalTools: ["collision"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const prompt = ["## Idea", `Title: ${d.title}`, `Mechanism: ${d.mechanism}`, `Testable claim: ${d.testableClaim}`, "", "## What the prior-art search found", findings.trim() || "(nothing)", "", "Call the collision tool."].join("\n");
  const { costUsd } = await brain.run(prompt);
  if (!captured) return { same: false, reason: "arbiter gave no verdict", costUsd };
  return { ...captured, costUsd };
}

export interface PriorArtOptions {
  shape: IdeaShape;
  fetchImpl?: typeof fetch;
  /** Set false to skip the arbiter (e.g. the collision cap is spent); the status is then `not_falsified` with the findings attached. */
  arbiter?: boolean;
  /** Separate from the shared model-work limiter; acquired inside web/scholar tools. */
  searchLimiter?: Limiter;
  searchJitterMs?: number;
}

/** Scout for prior art, then let the arbiter decide; records `arbiter.verdict` and returns the finding. */
export async function runPriorArtScout(deps: PhaseDeps, d: Dossier, opts: PriorArtOptions): Promise<PriorArtFinding> {
  const { model } = deps.models("scout");
  const searchHealth: SearchStatus[] = [];
  const ctx: ToolContext = {
    cwd: deps.run.dir,
    roots: [deps.run.dir],
    run: deps.run,
    record: deps.record,
    fetchImpl: opts.fetchImpl ?? deps.fetchImpl,
    mailto: deps.cfg.ideation.mailto,
    webTimeoutMs: deps.cfg.ideation.webTimeoutMs,
    searchLimiter: opts.searchLimiter,
    searchJitterMs: opts.searchJitterMs,
    onSearchHealth: (status) => searchHealth.push(status),
  };
  const question = facetQuery(d, opts.shape, priorArtTemplate(deps.home));
  const scout = await runScout({
    question,
    brief: `Prior-art check for one idea. Shape: ${opts.shape}.`,
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: scoutTools(ctx),
    record: deps.record,
    home: deps.home,
    cfg: deps.cfg,
    runId: deps.run.id,
    role: "scout",
    phase: "ideate",
    turnCap: deps.cfg.ideation.scoutTurnCap,
    streamFn: deps.streamFn,
    searchHealth,
  });
  // This is deliberately scout-local. A sequence-window scan of the journal attributes another
  // concurrently running scout's successful search to this one (carry-forward ruling 25).
  const searchOk = scout.stopped === "done" && scout.searchHealth.some((status) => status === "ok");
  const scoutCost = scout.costUsd;
  if (!searchOk) {
    return { status: "search_failed", findings: scout.findings, searchOk: false, costUsd: scoutCost, contextPressure: scout.contextPressure };
  }
  if (opts.arbiter === false) return { status: "not_falsified", findings: scout.findings, searchOk: true, costUsd: scoutCost, contextPressure: scout.contextPressure };
  const v = await collisionVerdict(deps, d, scout.findings);
  const hasUrl = v.artifactUrl !== undefined && /^https?:\/\//i.test(v.artifactUrl);
  const collided = v.same && hasUrl;
  deps.record.append({ t: "arbiter.verdict", kind: "collision", id: d.id, against: v.artifactUrl, verdict: collided ? "collided" : v.same ? "same_without_artifact" : "distinct", costUsd: v.costUsd });
  if (collided) {
    return { status: "collided", artifact: { title: v.artifactTitle ?? v.artifactUrl!, url: v.artifactUrl! }, distance: v.reason, findings: scout.findings, searchOk: true, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure };
  }
  return { status: "not_falsified", distance: v.reason || undefined, findings: scout.findings, searchOk: true, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure };
}
