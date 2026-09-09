import { readFileSync } from "node:fs";
import { getBundledModel, type GeneratedProvider, type Model } from "@oh-my-pi/pi-catalog";
import { PHASES, ROLES, type KilnConfig, type Role } from "../core/config";
import { derivedCaps } from "../formation/features";
import { projectedRoundCost } from "../ideation/budget";
import { effortFor, parseModelRef } from "../providers/models";
import type { WorkflowPhase } from "../workflow/plan";
import bundled from "./evidence-2026-09-08.json";

export const CATEGORIES = ["general_reasoning", "expert_knowledge", "business", "scientific_coding", "tool_execution", "knowledge_calibration"] as const;
type Category = typeof CATEGORIES[number];
export interface EvidenceSnapshot {
  version: 1; id: string; asOf: string; maxAgeDays: number;
  verification: { status: "verified"; verifiedAt: string; method: "manual-primary-source-check" };
  sources: Array<{ id: string; url: string; observedAt: string }>;
  rankings: Array<{ category: Category; sourceId: string; metric: string; higherIsBetter: boolean; entries: Array<{ modelRef: string; score: number }> }>;
}
export class AdaptiveRoutingError extends Error {}
const fail = (message: string): never => { throw new AdaptiveRoutingError(message); };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("benchmark evidence must contain objects");
  return value as Record<string, any>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return fail(`invalid evidence ${field}`);
  return value;
}
function date(value: unknown, field: string, now: Date): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail(`invalid evidence ${field} date`);
  const stamp = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value || stamp > now.getTime()) return fail(`invalid or future evidence ${field} date`);
  return stamp;
}

/** Operator review is provenance metadata, not a claim that structural validation verifies truth. */
export function validateEvidenceSnapshot(value: unknown, now = new Date()): EvidenceSnapshot {
  if (!Number.isFinite(now.getTime())) return fail("invalid evidence clock");
  const v = object(value);
  if (v.version !== 1) return fail("unsupported evidence version");
  const id = text(v.id, "id"); const asOf = date(v.asOf, "asOf", now);
  if (!Number.isInteger(v.maxAgeDays) || v.maxAgeDays < 1 || v.maxAgeDays > 90) return fail("evidence maxAgeDays must be 1..90");
  if (now.getTime() - asOf > v.maxAgeDays * 86_400_000) return fail("benchmark evidence is stale; refresh reviewed data or use manual routing");
  const verification = object(v.verification);
  if (verification.status !== "verified" || verification.method !== "manual-primary-source-check") return fail("benchmark evidence is unverified");
  if (date(verification.verifiedAt, "verifiedAt", now) < asOf) return fail("evidence verification predates snapshot");
  if (!Array.isArray(v.sources) || !v.sources.length || v.sources.length > 100) return fail("invalid evidence sources");
  const sourceIds = new Set<string>();
  const sources = v.sources.map((raw: unknown) => {
    const s = object(raw); const sourceId = text(s.id, "source id");
    if (sourceIds.has(sourceId)) return fail("duplicate evidence source"); sourceIds.add(sourceId);
    const url = new URL(text(s.url, "source URL"));
    if (url.protocol !== "https:" || url.username || url.password) return fail("evidence sources must use credential-free HTTPS URLs");
    const observed = date(s.observedAt, "observedAt", now);
    if (observed > asOf || now.getTime() - observed > v.maxAgeDays * 86_400_000) return fail("source observation is stale or newer than snapshot");
    return { id: sourceId, url: url.href, observedAt: s.observedAt as string };
  });
  if (!Array.isArray(v.rankings) || v.rankings.length !== CATEGORIES.length) return fail("evidence needs one ranking per supported category");
  const categories = new Set<string>();
  const rankings = v.rankings.map((raw: unknown) => {
    const r = object(raw);
    if (!CATEGORIES.includes(r.category) || categories.has(r.category)) return fail("invalid or duplicate evidence category");
    categories.add(r.category);
    if (!sourceIds.has(r.sourceId) || typeof r.higherIsBetter !== "boolean") return fail("ranking lacks a valid source or direction");
    const metric = text(r.metric, "metric"); const refs = new Set<string>();
    if (!Array.isArray(r.entries) || !r.entries.length || r.entries.length > 100) return fail("invalid ranking entries");
    const entries = r.entries.map((rawEntry: unknown) => {
      const entry = object(rawEntry); const modelRef = text(entry.modelRef, "modelRef");
      parseModelRef(modelRef);
      if (refs.has(modelRef) || !Number.isFinite(entry.score)) return fail("duplicate model or non-finite benchmark score");
      refs.add(modelRef); return { modelRef, score: entry.score as number };
    });
    return { category: r.category as Category, sourceId: r.sourceId as string, metric, higherIsBetter: r.higherIsBetter as boolean, entries };
  });
  return { version: 1, id, asOf: v.asOf, maxAgeDays: v.maxAgeDays, verification: { status: "verified", verifiedAt: verification.verifiedAt, method: "manual-primary-source-check" }, sources, rankings };
}
export const DEFAULT_EVIDENCE_SNAPSHOT: unknown = bundled;
export function loadEvidenceSnapshot(path: string, now = new Date()): EvidenceSnapshot {
  return validateEvidenceSnapshot(JSON.parse(readFileSync(path, "utf8")), now);
}

type Seat = { ref: string; model: Model };
const vendor = (provider: string) => provider === "openai-codex" ? "openai" : provider;
function seat(ref: string, available: Set<string>): Seat | undefined {
  const { provider, modelId } = parseModelRef(ref);
  if (!available.has(provider)) return undefined;
  const model = getBundledModel(provider as GeneratedProvider, modelId);
  if (!model || model.supportsTools === false || model.toolMode === "code_mode_only" || !model.input.includes("text") || !(model.api.includes("responses") || model.api === "anthropic-messages")
    || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output) || model.cost.input < 0 || model.cost.output < 0) return undefined;
  return { ref, model };
}
function aliases(ref: string): string[] {
  const { provider, modelId } = parseModelRef(ref);
  return provider === "openai" || provider === "openai-codex"
    ? [ref, `${provider === "openai" ? "openai-codex" : "openai"}/${modelId}`] : [ref];
}
function domainFor(seed: string): "science" | "business" | "general" {
  if (/\b(research|scientific|science|biology|medicine|medical|protein|literature|genomics|chemistry|physics)\b/i.test(seed)) return "science";
  if (/\b(business|startup|market|customer|revenue|billionaire|company|pricing)\b/i.test(seed)) return "business";
  return "general";
}

export interface AdaptiveRoutingReport {
  version: 1; domain: "science" | "business" | "general"; status: "ready";
  evidence: { id: string; asOf: string; sources: EvidenceSnapshot["sources"] };
  selectedRoleRefs: Record<Role, string>;
  roleRefs: Record<Role, string[]>;
  effectiveEffort: Record<Role, string | null>;
  /** Decision provenance, not model-generated hidden reasoning or a quality guarantee. */
  roleReasons: Record<Role, {
    category: Category;
    metric: string;
    sourceId: string;
    score: number | null;
    selection: "ranked" | "configured_fallback";
    reviewAgainst: string | null;
    reason: string;
  }>;
  workflow: { phases: WorkflowPhase[]; ideationPlanned: boolean; buildPlanned: boolean };
  budget: { totalUsd: number; projectedRoundUsd: number; ideateUsd: number; buildUsd: number; requestedRounds: number; affordableRounds: number; maxBuildFeatures: number };
  warnings: string[];
}

export interface AdaptiveRoutingOptions {
  /** Exact phases selected by the workflow compiler, including an explicit --through override. */
  phases?: readonly WorkflowPhase[];
}

const WORKFLOW_PHASES: readonly WorkflowPhase[] = ["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"];

/** Deterministic and provider-call-free. Only this returned run config changes, never the home. */
export function planAdaptiveRouting(
  cfg: KilnConfig,
  available: Set<string>,
  seed: string,
  now = new Date(),
  evidence: unknown = DEFAULT_EVIDENCE_SNAPSHOT,
  options: AdaptiveRoutingOptions = {},
): { config: KilnConfig; report: AdaptiveRoutingReport } {
  const snapshot = validateEvidenceSnapshot(evidence, now);
  if (options.phases !== undefined && (options.phases.length === 0 || options.phases.some((phase) => !WORKFLOW_PHASES.includes(phase)))) {
    return fail("adaptive routing requires valid workflow phases");
  }
  const phases = [...(options.phases ?? WORKFLOW_PHASES)];
  const ideationPlanned = phases.includes("ideate");
  const buildPlanned = phases.includes("build");
  const domain = domainFor(seed);
  const warnings = [
    "Benchmark rankings inform role assignments; they do not establish Kiln task quality or hallucination rates.",
    "Scores include different effort/fallback settings. Terminal-Bench measures model plus harness with overlapping confidence intervals; configured effort is preserved.",
    "Catalog and credentials do not prove account-level model entitlement. Role alternatives are not automatic retries after provider errors.",
  ];
  const preferred: Category = domain === "science" ? "expert_knowledge" : domain === "business" ? "business" : "general_reasoning";
  const pool = (category: Category, role: Role): Seat[] => {
    const ranking = snapshot.rankings.find((r) => r.category === category)!;
    const ranked = [...ranking.entries].sort((a, b) => ranking.higherIsBetter ? b.score - a.score : a.score - b.score).map((entry) => entry.modelRef);
    const refs = [...new Set([...ranked, ...cfg.roles[role], ...Object.values(cfg.roles).flat()].flatMap(aliases))];
    return refs.flatMap((ref) => {
      const value = seat(ref, available);
      if (!value) return [];
      return [value];
    });
  };
  const chosen = {} as Record<Role, Seat>;
  const pick = (role: Role, category: Category, producer?: Seat, requiredVendor?: string): Seat => {
    let candidates = pool(category, role).filter((candidate) => (!producer || candidate.model.id !== producer.model.id)
      && (!requiredVendor || vendor(String(candidate.model.provider)) === requiredVendor));
    if (producer) {
      const cross = candidates.filter((candidate) => vendor(String(candidate.model.provider)) !== vendor(String(producer.model.provider)));
      if (cross.length) candidates = cross;
      else warnings.push(`${role}: only same-vendor review is available; distinct model identities are a weaker independence boundary.`);
    }
    const result = candidates[0];
    if (!result) return fail(`no supported available model for ${role} satisfying reviewer independence; connect another provider or use manual routing`);
    chosen[role] = result;
    if (!snapshot.rankings.find((r) => r.category === category)!.entries.some((entry) => aliases(entry.modelRef).includes(result.ref))) warnings.push(`${role}: using configured catalog fallback without a score in ${category}.`);
    return result;
  };
  pick("brain", preferred);
  pick("generator", preferred);
  pick("judge", "knowledge_calibration", chosen.generator);
  pick("prober", "scientific_coding", chosen.judge, vendor(String(chosen.generator.model.provider)));
  pick("builder", "tool_execution");
  pick("auditor", "scientific_coding", chosen.builder);
  pick("critic", "knowledge_calibration", chosen.brain);
  // Retrieval supplies evidence to the proposing brain; prefer a second vendor to reduce
  // correlated unsupported claims, just as with the explicit critique/judge seats.
  pick("scout", "knowledge_calibration", chosen.brain);
  pick("arbiter", "knowledge_calibration", chosen.generator);
  pick("reflector", "knowledge_calibration");
  const categories: Record<Role, Category> = {
    brain: preferred, generator: preferred, judge: "knowledge_calibration", prober: "scientific_coding",
    builder: "tool_execution", auditor: "scientific_coding", critic: "knowledge_calibration",
    scout: "knowledge_calibration", arbiter: "knowledge_calibration", reflector: "knowledge_calibration",
  };
  const paired: Partial<Record<Role, Role>> = {
    brain: "critic", critic: "brain", generator: "judge", judge: "generator", prober: "judge",
    builder: "auditor", auditor: "builder", arbiter: "generator",
  };
  const sameIdentity = (a: Seat, b: Seat) => vendor(String(a.model.provider)) === vendor(String(b.model.provider)) && a.model.id === b.model.id;
  // Keep compatible alternate vendors/models in the frozen plan so a phase can make an explicit,
  // bounded retry. Transport aliases remain one model identity and never satisfy reviewer separation.
  const roles = Object.fromEntries(ROLES.map((role) => {
    const counterpart = paired[role] ? chosen[paired[role]!] : undefined;
    const candidates = [chosen[role], ...pool(categories[role], role)]
      .filter((candidate) => !counterpart || !sameIdentity(candidate, counterpart));
    const refs = [...new Set(candidates.flatMap((candidate) => aliases(candidate.ref)).filter((ref) => seat(ref, available)))];
    return [role, refs];
  })) as KilnConfig["roles"];
  const config: KilnConfig = {
    ...cfg, roles, seating: { ...cfg.seating, default: roles },
    provider: { ...cfg.provider, strictDecisionTools: true },
    budgets: { ...cfg.budgets, share: { ...cfg.budgets.share } },
    ideation: { ...cfg.ideation },
  };
  const positiveInts = [cfg.ideation.rounds, cfg.ideation.islands, cfg.ideation.ideasPerBatch, cfg.ideation.pairCap];
  if (!Number.isFinite(cfg.budgets.usd) || cfg.budgets.usd <= 0
    || (ideationPlanned && positiveInts.some((n) => !Number.isInteger(n) || n < 1))) {
    return fail("adaptive routing requires a positive budget and positive ideation dimensions when ideation is planned");
  }
  if (PHASES.some((phase) => !Number.isFinite(cfg.budgets.share[phase]) || cfg.budgets.share[phase] < 0)
    || Math.abs(PHASES.reduce((sum, phase) => sum + cfg.budgets.share[phase], 0) - 1) > 1e-9) return fail("invalid budget shares");
  const projection = ideationPlanned ? projectedRoundCost(config, (role) => chosen[role]) : { costUsd: 0 };
  if (!Number.isFinite(projection.costUsd) || projection.costUsd < 0) return fail("invalid projected round cost");
  const total = cfg.budgets.usd;
  const initialIdeate = cfg.budgets.phaseBudgetUsd("ideate");
  const initialBuild = cfg.budgets.phaseBudgetUsd("build");
  const featureFloor = buildPlanned ? cfg.build.minFeatures * cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd : 0;
  if (!Number.isFinite(featureFloor) || featureFloor < 0) return fail("invalid build planning assumptions");
  const buildReserve = buildPlanned ? Math.min(initialBuild, Math.max(total * 0.2, featureFloor)) : 0;
  const maxIdeate = initialIdeate + initialBuild - buildReserve;
  if (ideationPlanned && projection.costUsd > maxIdeate + 1e-9) {
    const suffix = buildPlanned ? " while preserving build reserve" : " across the available ideation/build allocation";
    return fail(`one ideation round projects to $${projection.costUsd.toFixed(2)}, above the $${maxIdeate.toFixed(2)} available${suffix}; increase the planning target explicitly or use manual routing`);
  }
  const affordable = !ideationPlanned ? 0
    : projection.costUsd === 0 ? cfg.ideation.rounds
    : Math.max(1, Math.min(cfg.ideation.rounds, Math.floor((maxIdeate + 1e-9) / (projection.costUsd * 1.1))));
  const allocation = !ideationPlanned ? 0
    : Math.max(initialIdeate, Math.min(maxIdeate, projection.costUsd * affordable * 1.1));
  if (ideationPlanned || buildPlanned) {
    config.budgets.share.ideate = allocation / total;
    config.budgets.share.build = (initialIdeate + initialBuild - allocation) / total;
  }
  if (ideationPlanned) config.ideation.rounds = affordable;
  const buildCaps = derivedCaps(config);
  if (buildPlanned && buildCaps.maxFeatures < cfg.build.minFeatures) return fail(`remaining build allocation funds ${buildCaps.maxFeatures} feature(s), below the configured minimum ${cfg.build.minFeatures}; increase the planning target explicitly or use manual routing`);
  if (ideationPlanned && affordable < cfg.ideation.rounds) warnings.push(`Budget funds ${affordable} projected round(s), not the requested ${cfg.ideation.rounds}. Projections are assumptions, not measurements or hard ceilings.`);
  if (Math.abs(allocation - initialIdeate) > 1e-9) warnings.push(buildPlanned && ideationPlanned
    ? "Reallocated ideation/build shares within the unchanged total; phase wall-time allocations change too, and build capacity may decrease."
    : ideationPlanned
      ? "Reallocated part of the unplanned build share to ideation within the unchanged total."
      : "Reallocated the unplanned ideation share to build within the unchanged total.");
  if (ideationPlanned && chosen.generator.model.id === chosen.prober.model.id) warnings.push("Idea islands use different lenses but the same model; the configured cheap island is not cheaper.");
  const reviewTargets: Partial<Record<Role, Role>> = {
    judge: "generator", prober: "judge", auditor: "builder", critic: "brain", scout: "brain", arbiter: "generator",
  };
  const roleReasons = Object.fromEntries(ROLES.map((role) => {
    const ranking = snapshot.rankings.find((entry) => entry.category === categories[role])!;
    const evidenceEntry = ranking.entries.find((entry) => aliases(entry.modelRef).includes(chosen[role].ref));
    const against = reviewTargets[role] ? chosen[reviewTargets[role]!].ref : null;
    const reason = [
      evidenceEntry ? `Highest-ranked eligible candidate for ${categories[role]} after provider, tool-support, and role constraints.`
        : `Configured catalog fallback: no eligible ranked candidate satisfied ${categories[role]} role constraints.`,
      against ? `Distinct model from ${against}; cross-vendor review preferred where available.` : "No producer/reviewer separation required for this seat.",
      role === "prober" ? "Prober remains on the generator's vendor." : "",
      "Effort follows the configured role setting and supported model levels; benchmark scores do not establish quality at that effort.",
    ].filter(Boolean).join(" ");
    return [role, { category: categories[role], metric: ranking.metric, sourceId: ranking.sourceId,
      score: evidenceEntry?.score ?? null, selection: evidenceEntry ? "ranked" : "configured_fallback", reviewAgainst: against, reason }];
  })) as AdaptiveRoutingReport["roleReasons"];
  return {
    config,
    report: { version: 1, domain, status: "ready", evidence: { id: snapshot.id, asOf: snapshot.asOf, sources: snapshot.sources },
      selectedRoleRefs: Object.fromEntries(ROLES.map((role) => [role, chosen[role].ref])) as Record<Role, string>,
      roleRefs: Object.fromEntries(ROLES.map((role) => [role, [...roles[role]]])) as Record<Role, string[]>,
      effectiveEffort: Object.fromEntries(ROLES.map((role) => [role, effortFor(cfg, role, chosen[role].model) ?? null])) as Record<Role, string | null>,
      roleReasons,
      workflow: { phases, ideationPlanned, buildPlanned },
      budget: { totalUsd: total, projectedRoundUsd: projection.costUsd, ideateUsd: config.budgets.phaseBudgetUsd("ideate"), buildUsd: config.budgets.phaseBudgetUsd("build"), requestedRounds: cfg.ideation.rounds, affordableRounds: affordable, maxBuildFeatures: buildPlanned ? buildCaps.maxFeatures : 0 }, warnings },
  };
}
