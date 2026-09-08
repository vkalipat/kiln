import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IdeaShape, KilnConfig, Phase, Role } from "../core/config";

type EvidenceDomain = "research" | "business" | "general";

export interface AdaptiveEvidenceInput {
  cfg: KilnConfig;
  role: Role;
  phase: Phase;
  toolNames: readonly string[];
  systemPrompt: readonly string[];
  recordPath: string;
}

interface RunEvidenceContext {
  seed: string;
  shape?: IdeaShape;
}

const EVIDENCE_HEADING = /^## Evidence discipline\s*$/im;
const RUNTIME_HEADING = /^## Adaptive evidence context\s*$/im;
const EXTERNAL_RETRIEVAL = new Set(["web_search", "web_fetch", "scholar_search", "scout"]);
const REVIEW_ROLES = new Set<Role>(["judge", "auditor", "critic", "arbiter"]);

const RESEARCH_TERMS = /\b(?:research|study|paper|literature|scientific|science|biology|biological|biomedical|medicine|medical|clinical|protein|genomic|genetics|molecule|drug|disease)\b/i;
const BUSINESS_TERMS = /\b(?:business|startup|company|market|customer|revenue|pricing|sales|commercial|venture|founder|profit|billionaire)\b/i;

function runContext(recordPath: string): RunEvidenceContext {
  const runDir = dirname(recordPath);
  let seed = "";
  let shape: IdeaShape | undefined;
  try {
    const path = join(runDir, "seed.md");
    if (existsSync(path)) seed = readFileSync(path, "utf8");
  } catch {
    // Evidence guidance is a safety net, not a new reason to prevent a run from starting.
  }
  try {
    const path = join(runDir, "status.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { shape?: unknown };
      if (parsed.shape === "research" || parsed.shape === "product" || parsed.shape === "creative") shape = parsed.shape;
    }
  } catch {
    // A missing or partially-written status only removes domain specialization from this block.
  }
  return { seed, shape };
}

export function classifyEvidenceDomain(seed: string, shape?: IdeaShape): EvidenceDomain {
  if (shape === "research" || RESEARCH_TERMS.test(seed)) return "research";
  if (BUSINESS_TERMS.test(seed)) return "business";
  return "general";
}

function accessGuidance(role: Role, names: Set<string>): string[] {
  const external = [...names].filter((name) => EXTERNAL_RETRIEVAL.has(name));
  const lines: string[] = [];
  if (external.length > 0) {
    lines.push(`External retrieval is available through ${external.map((name) => `\`${name}\``).join(", ")}. Open and inspect a source before citing it; a result title or snippet is only a lead.`);
  } else {
    lines.push("This seat has no external retrieval tool. Do not claim to have browsed or independently checked a source; use only supplied artifacts and recorded results, and mark external factual gaps as unverified.");
  }
  if (REVIEW_ROLES.has(role)) {
    lines.push("This is a review seat: assess the evidence and provenance actually supplied. Agreement between models or reviewers is not fact verification.");
  } else if (role === "generator") {
    lines.push("This is a generative seat: novel mechanisms are hypotheses, not discovered facts. Label important assumptions and attach a cheapest falsifying test.");
  } else if (role === "builder") {
    lines.push("A command or test result supports only what that command or test exercised; do not generalize a passing check beyond its observed scope.");
  }
  return lines;
}

function domainGuidance(domain: EvidenceDomain): string {
  if (domain === "research") {
    return "For research, biology, or medicine, prefer primary literature and distinguish reported findings from your extrapolation. Keep work high-level, literature-based, computational, product, or business focused; do not turn the run into clinical advice or operational wet-lab instructions.";
  }
  if (domain === "business") {
    return "For business claims, separate sourced market or customer facts from estimates and forecasts. State the date, geography, units, and assumptions when they materially affect a recommendation.";
  }
  return "For general claims, prefer the most direct authoritative source available and narrow the claim when its scope or currency cannot be verified.";
}

/**
 * Build the run-time evidence block for adaptive routing. It is deliberately composed here rather
 * than stored only in kernel.md: existing homes retain copied prompts, so prompt-file upgrades do
 * not reach them. A distinct heading augments a current kernel without duplicating its durable
 * `## Evidence discipline` section; a stale kernel receives that canonical heading at runtime.
 */
export function adaptiveEvidencePrompt(input: AdaptiveEvidenceInput): string | undefined {
  if (input.cfg.routing?.mode !== "adaptive") return undefined;
  if (input.systemPrompt.some((part) => RUNTIME_HEADING.test(part))) return undefined;

  const hasEvidenceSection = input.systemPrompt.some((part) => EVIDENCE_HEADING.test(part));
  const context = runContext(input.recordPath);
  const domain = classifyEvidenceDomain(context.seed, context.shape);
  const names = new Set(input.toolNames);
  const heading = hasEvidenceSection ? "## Adaptive evidence context" : "## Evidence discipline";
  return [
    heading,
    "",
    `This adaptive ${input.phase}/${input.role} seat uses the following evidence policy:`,
    "- Keep observed or sourced facts, inferences, and assumptions or hypotheses distinct. Label the latter two; give consequential hypotheses a test that could disprove them.",
    "- Support every consequential factual claim, number, quotation, and prior-art assertion with an actually inspected source or a recorded tool result. Never invent a citation or imply that an unavailable source was opened.",
    "- A failed, blocked, or incomplete search proves only that retrieval did not establish the answer. It is not evidence of absence, novelty, efficacy, or safety.",
    "- Corroborate recommendation-driving claims when feasible. When verification is unavailable or sources conflict, preserve the uncertainty and narrow the conclusion.",
    ...accessGuidance(input.role, names).map((line) => `- ${line}`),
    `- ${domainGuidance(domain)}`,
  ].join("\n");
}
