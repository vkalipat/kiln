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
  /** URLs observed in successful retrieval tool results, never model-authored synthesis alone. */
  observedUrls: string[];
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
  const ownSection = section.split(/^##\s+/m)[0] ?? section;
  const at = ownSection.indexOf("Template:");
  const body = (at === -1 ? ownSection : ownSection.slice(at + "Template:".length)).trim();
  return body === "" ? DEFAULT_TEMPLATE : body;
}

/** Fill the facet query from dossier fields: purpose from the claim and audience, mechanism, evaluation from the cheapest test. */
export function facetQuery(d: Dossier, shape: IdeaShape, template = DEFAULT_TEMPLATE): string {
  const who = d.axisValues["who it serves"] ?? Object.values(d.axisValues)[0] ?? "";
  const purpose = who ? `${d.testableClaim} (for ${who})` : d.testableClaim;
  return template
    .replaceAll("{purpose}", purpose)
    .replaceAll("{mechanism}", `${d.title}: ${d.mechanism}`)
    .replaceAll("{evaluation}", d.cheapestTest)
    .replaceAll("{shape}", shape);
}

export interface CollisionVerdict {
  same: boolean;
  /** False means the arbiter never produced a decision; it must not be persisted as distinct. */
  conclusive: boolean;
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
  const result = await brain.run(prompt);
  if (!captured) {
    const category = result.stopDetails?.category?.trim();
    const reason = result.stopped === "refused" ? `arbiter refused${category ? `:${category}` : ""}`
      : result.stopped === "error" ? `arbiter failed: ${result.error ?? "provider error"}`
      : "arbiter gave no verdict";
    return { same: false, conclusive: false, reason, costUsd: result.costUsd };
  }
  return { ...captured, conclusive: true, costUsd: result.costUsd };
}

/** A collision may cite only a valid web URL that is present in the scout's retrieved findings. */
export function verifiedArtifactUrl(candidate: string | undefined, observed: string | readonly string[]): string | undefined {
  const raw = candidate?.trim();
  const seen = typeof observed === "string" ? observed.includes(raw ?? "") : observed.includes(raw ?? "");
  if (!raw || !seen) return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? raw : undefined;
  } catch {
    return undefined;
  }
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
  const marker = deps.record.read().at(-1)?.seq ?? 0;
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
  const observedUrls = [...new Set(deps.record.read().flatMap((event) => {
    if (event.seq <= marker || event.t !== "tool.call" || !event.ok || !["scholar_search", "web_search", "web_fetch"].includes(event.name)) return [];
    return event.excerpt.match(/https?:\/\/[^\s<>"'\])}]+/gi) ?? [];
  }))];
  // This is deliberately scout-local. A sequence-window scan of the journal attributes another
  // concurrently running scout's successful search to this one (carry-forward ruling 25).
  const searchOk = scout.stopped === "done" && scout.searchHealth.length > 0 && scout.searchHealth.every((status) => status === "ok");
  const scoutCost = scout.costUsd;
  if (!searchOk) {
    return { status: "search_failed", findings: scout.findings, searchOk: false, costUsd: scoutCost, contextPressure: scout.contextPressure, observedUrls };
  }
  if (opts.arbiter === false) return { status: "not_falsified", findings: scout.findings, searchOk: true, costUsd: scoutCost, contextPressure: scout.contextPressure, observedUrls };
  const v = await collisionVerdict(deps, d, scout.findings);
  if (!v.conclusive) {
    deps.record.append({ t: "arbiter.verdict", kind: "collision", id: d.id, verdict: "inconclusive", costUsd: v.costUsd });
    return { status: "search_failed", findings: scout.findings, searchOk: false, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
  }
  const artifactUrl = verifiedArtifactUrl(v.artifactUrl, observedUrls);
  const collided = v.same && artifactUrl !== undefined;
  deps.record.append({ t: "arbiter.verdict", kind: "collision", id: d.id, against: artifactUrl, verdict: collided ? "collided" : v.same ? "same_without_artifact" : "distinct", costUsd: v.costUsd });
  if (collided) {
    return { status: "collided", artifact: { title: v.artifactTitle ?? artifactUrl, url: artifactUrl }, distance: v.reason, findings: scout.findings, searchOk: true, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
  }
  return { status: "not_falsified", distance: v.reason || undefined, findings: scout.findings, searchOk: true, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
}
