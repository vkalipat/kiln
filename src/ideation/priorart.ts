import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import { composeAddenda } from "../brain/addenda";
import { adaptiveEvidencePrompt } from "../brain/adaptive-evidence";
import { hashInput } from "../core/record";
import { scoutTools, type ToolContext } from "../brain/tools";
import { fail } from "../brain/tools/shape";
import type { IdeaShape } from "../core/config";
import type { SearchStatus } from "../core/events";
import type { Limiter } from "../core/limiter";
import type { PhaseDeps } from "../phases/frame";
import { effortFor } from "../providers/models";
import { runScout } from "../scouts/scout";
import type { Dossier } from "./dossier";
import { readPriorArtCheckpoint, writePriorArtCheckpoint, retirePriorArtCheckpoint } from "./priorart-checkpoint";
export { priorArtCacheDir, retirePriorArtCheckpoint } from "./priorart-checkpoint";

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
  /** Completed scout with some successful retrieval; this alone does not establish coverage. */
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
  /** A valid coverage decision, including explicitly inadequate coverage, was received. */
  decisionRecorded?: boolean;
  same: boolean;
  coverageAdequate: boolean;
  /** False includes inadequate coverage and invalid/missing decisions; never persist as distinct. */
  conclusive: boolean;
  artifactTitle?: string;
  artifactUrl?: string;
  reason: string;
  costUsd: number;
}

/** One arbiter call: is a named artifact with a URL already this idea? A `same` without a URL is not a collision. */
export async function collisionVerdict(deps: PhaseDeps, d: Dossier, findings: string): Promise<CollisionVerdict> {
  const { model } = deps.models("arbiter");
  let captured: { coverageAdequate: boolean; same: boolean; artifactTitle?: string; artifactUrl?: string; reason: string } | undefined;
  let invalidReason: string | undefined;
  const tool: AgentTool<any> = {
    name: "collision",
    label: "Collision",
    intent: "omit",
    description: "Assess whether the retrieved findings provide adequate relevant coverage, then whether a specific artifact already implements this mechanism for this purpose. Parsed results alone do not establish coverage.",
    parameters: {
      type: "object",
      properties: { coverageAdequate: { type: "boolean" }, same: { type: "boolean" }, artifactTitle: { type: "string" }, artifactUrl: { type: "string" }, reason: { type: "string" } },
      required: ["coverageAdequate", "same", "reason"],
    },
    examples: [{ caption: "A collision", call: { coverageAdequate: true, same: true, artifactTitle: "Foo", artifactUrl: "https://example.com/foo", reason: "The retrieved Foo documentation establishes this mechanism for the same users." } }],
    async execute(_id, p: { coverageAdequate?: boolean; same?: boolean; artifactTitle?: string; artifactUrl?: string; reason?: string }) {
      const reject = (reason: string) => { invalidReason = reason; return fail(reason); };
      if (!p || typeof p.coverageAdequate !== "boolean" || typeof p.same !== "boolean" || typeof p.reason !== "string" || !p.reason.trim()) {
        return reject("Provide explicit boolean coverageAdequate and same, plus a nonempty reason naming relevant evidence or concrete retrieval gaps.");
      }
      if (!p.coverageAdequate && p.same) return reject("Inadequate coverage cannot support same=true; report coverageAdequate=false and same=false with the evidence gap.");
      if ((p.artifactTitle !== undefined && typeof p.artifactTitle !== "string") || (p.artifactUrl !== undefined && typeof p.artifactUrl !== "string")) return reject("Artifact title and URL must be strings when supplied.");
      const artifactUrl = p.artifactUrl?.trim() || undefined;
      if (p.same && !verifiedArtifactUrl(artifactUrl, artifactUrl ? [artifactUrl] : [])) return reject("same=true requires a specific valid HTTP(S) artifact URL from the retrieved evidence.");
      captured = { coverageAdequate: p.coverageAdequate, same: p.same, artifactTitle: p.artifactTitle?.trim() || undefined, artifactUrl, reason: p.reason.trim() };
      return { content: [{ type: "text" as const, text: "collision verdict recorded" }] };
    },
  };
  const brain = createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "arbiter")],
    pinned: `Collision question for idea ${d.id}. First assess coverage of this mechanism and purpose from the retrieved findings. Irrelevant RSS hits, blocked retrieval, or unanswered questions mean coverageAdequate=false and same=false. Relevant evidence can support coverageAdequate=true even when no exact collision is found; explain the evidence and limits. No-results responses do not prove absence.`,
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
      : invalidReason ? `arbiter gave no valid verdict: ${invalidReason}` : "arbiter gave no verdict";
    return { same: false, coverageAdequate: false, conclusive: false, reason, costUsd: result.costUsd };
  }
  return { ...captured, decisionRecorded: true, conclusive: captured.coverageAdequate, costUsd: result.costUsd };
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
  /** Set false to defer coverage/collision review; status stays search_failed until reviewed. */
  arbiter?: boolean;
  /** Separate from the shared model-work limiter; acquired inside web/scholar tools. */
  searchLimiter?: Limiter;
  searchJitterMs?: number;
}

/** Scout for prior art, then let the arbiter decide; records `arbiter.verdict` and returns the finding. */
export async function runPriorArtScout(deps: PhaseDeps, d: Dossier, opts: PriorArtOptions): Promise<PriorArtFinding> {
  const { model, ref } = deps.models("scout");
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
  const template = priorArtTemplate(deps.home);
  const question = facetQuery(d, opts.shape, template);
  const brief = `Prior-art check for one idea. Shape: ${opts.shape}.`;
  const tools = scoutTools(ctx);
  const systemPrompt = [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "scout")];
  const fingerprint = hashInput({ policy: 1, dossier: d, template, question, brief, ref,
    model: { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl, compat: model.compat, thinking: model.thinking, contextWindow: model.contextWindow },
    effort: effortFor(deps.cfg, "scout", model), systemPrompt,
    addenda: composeAddenda(model, "scout", deps.cfg), provider: deps.cfg.provider,
    adaptive: adaptiveEvidencePrompt({ cfg: deps.cfg, role: "scout", phase: "ideate", toolNames: tools.map((t) => t.name), systemPrompt, recordPath: deps.record.path }),
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    scoutTurnCap: deps.cfg.ideation.scoutTurnCap, mailto: deps.cfg.ideation.mailto, webTimeoutMs: deps.cfg.ideation.webTimeoutMs,
  });
  const cached = readPriorArtCheckpoint(deps, d.id, fingerprint);
  const scout = cached ?? await runScout({
    question,
    brief,
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools,
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
  const observedUrls = scout.observedUrls;
  // This is deliberately scout-local. A sequence-window scan of the journal attributes another
  // concurrently running scout's successful search to this one (carry-forward ruling 25).
  const searchOk = scout.stopped === "done" && (scout.searchHealth.includes("ok") || (scout.successfulFetches ?? 0) > 0);
  const scoutCost = scout.costUsd;
  if (!cached && searchOk && scout.findings.trim()) writePriorArtCheckpoint(deps, d.id, fingerprint, scout);
  if (!searchOk) {
    return { status: "search_failed", distance: scout.stopped === "done" ? "No successful source retrieval was observed." : `Scout did not complete its report (${scout.stopped}).`, findings: scout.findings, searchOk: false, costUsd: scoutCost, contextPressure: scout.contextPressure, observedUrls };
  }
  if (opts.arbiter === false) return { status: "search_failed", distance: "Search coverage has not been assessed by the arbiter.", findings: scout.findings, searchOk: true, costUsd: scoutCost, contextPressure: scout.contextPressure, observedUrls };
  const v = await collisionVerdict(deps, d, scout.findings);
  if (v.decisionRecorded && !v.coverageAdequate) retirePriorArtCheckpoint(deps, d.id);
  if (!v.conclusive) {
    deps.record.append({ t: "arbiter.verdict", kind: "collision", id: d.id, verdict: "inconclusive", costUsd: v.costUsd });
    return { status: "search_failed", distance: v.reason, findings: scout.findings, searchOk: false, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
  }
  const artifactUrl = verifiedArtifactUrl(v.artifactUrl, observedUrls);
  const collided = v.same && artifactUrl !== undefined;
  deps.record.append({ t: "arbiter.verdict", kind: "collision", id: d.id, against: artifactUrl, verdict: collided ? "collided" : v.same ? "same_without_artifact" : "distinct", costUsd: v.costUsd });
  if (collided) {
    return { status: "collided", artifact: { title: v.artifactTitle ?? artifactUrl, url: artifactUrl }, distance: v.reason, findings: scout.findings, searchOk: true, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
  }
  if (v.same) return { status: "search_failed", distance: "The proposed collision URL was not observed by this scout's successful retrievals.", findings: scout.findings, searchOk: false, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
  return { status: "not_falsified", distance: v.reason || undefined, findings: scout.findings, searchOk: true, costUsd: scoutCost + v.costUsd, contextPressure: scout.contextPressure, observedUrls };
}
