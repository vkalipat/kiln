import { readFileSync } from "node:fs";
import { getBundledModel, type GeneratedProvider, type Model } from "@oh-my-pi/pi-catalog";
import { PHASES, ROLES, type KilnConfig, type Role } from "../core/config";
import { derivedCaps } from "../formation/features";
import { ADAPTIVE_LATENCY_SECONDS, projectedAdaptiveRound, type AdaptiveRoundProjection } from "../ideation/budget";
import { effortFor, isKilnToolModelSupported, parseModelRef } from "../providers/models";
import type { WorkflowPhase } from "../workflow/plan";
import { adaptivePortfolioCandidates } from "../workflow/profile";
import {
  COMPUTATIONAL_BIOLOGY_ASTRA_MODEL,
  workloadPreferenceFor,
} from "./workloads";
import bundled from "./evidence-2026-09-09.json";

export const CATEGORIES = ["general_reasoning", "expert_knowledge", "business", "scientific_coding", "tool_execution", "knowledge_calibration"] as const;
type Category = typeof CATEGORIES[number];
export interface EvidenceSnapshot {
  version: 1; id: string; asOf: string; maxAgeDays: number;
  verification: { status: "verified"; verifiedAt: string; method: "manual-primary-source-check" };
  sources: Array<{ id: string; url: string; observedAt: string }>;
  rankings: Array<{ category: Category; sourceId: string; metric: string; higherIsBetter: boolean; entries: Array<{ modelRef: string; score: number; effort?: string; conditions?: string; sourceId?: string }> }>;
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
      const effort = entry.effort === undefined ? undefined : text(entry.effort, "effort");
      if (effort !== undefined && !["low", "medium", "high", "xhigh", "max", "unspecified"].includes(effort)) return fail("invalid benchmark effort");
      const conditions = entry.conditions === undefined ? undefined : text(entry.conditions, "conditions");
      if (entry.sourceId !== undefined && !sourceIds.has(entry.sourceId)) return fail("entry lacks a valid source");
      refs.add(modelRef); return { modelRef, score: entry.score as number,
        ...(effort ? { effort } : {}), ...(conditions ? { conditions } : {}), ...(entry.sourceId ? { sourceId: entry.sourceId as string } : {}) };
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
  if (!model || !isKilnToolModelSupported(model) || !model.input.includes("text")
    || !(model.api.includes("responses") || model.api === "anthropic-messages")
    || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output) || model.cost.input < 0 || model.cost.output < 0) return undefined;
  return { ref, model };
}
function seatUnavailableReason(ref: string, available: Set<string>): string {
  const { provider, modelId } = parseModelRef(ref);
  if (!available.has(provider)) return "provider " + provider + " is not connected";
  const model = getBundledModel(provider as GeneratedProvider, modelId);
  if (!model) return "the installed provider catalog does not contain the model";
  if (!isKilnToolModelSupported(model)) return "the model has no approved Kiln tool adapter";
  return "the model does not satisfy Kiln text, transport, or pricing requirements";
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
  selectionPolicy: "quality_first" | "quality_first_with_workload_preference";
  evidence: { id: string; asOf: string; sources: EvidenceSnapshot["sources"] };
  selectedRoleRefs: Record<Role, string>;
  roleRefs: Record<Role, string[]>;
  unavailableRankedModels: Array<{ modelRef: string; reason: string }>;
  effectiveEffort: Record<Role, string | null>;
  workloadPreference: {
    policy: "prospective_user_workload_preference_v1";
    workload: "computational_biology_vcc" | null;
    requestedModelRef: typeof COMPUTATIONAL_BIOLOGY_ASTRA_MODEL | null;
    producingRoles: readonly Role[];
    status: "not_applicable" | "applied" | "unavailable";
    reason: string;
  };
  /** Decision provenance, not model-generated hidden reasoning or a quality guarantee. */
  roleReasons: Record<Role, {
    category: Category;
    metric: string;
    sourceId: string;
    score: number | null;
    selection: "ranked" | "configured_fallback" | "workload_preference";
    reviewAgainst: string | null;
    benchmarkEffort: string | null;
    benchmarkConditions: string | null;
    reason: string;
  }>;
  workflow: { phases: WorkflowPhase[]; ideationPlanned: boolean; buildPlanned: boolean };
  portfolio: {
    originalCandidates: number;
    candidates: number;
    islands: number;
    ideasPerBatch: number;
    entrants: number;
    pairs: number;
    planningCallsWithRetryReserve: number;
    estimatedRoundWallSeconds: number;
    assumptions: typeof ADAPTIVE_LATENCY_SECONDS;
  };
  budget: { totalUsd: number; projectedRoundUsd: number; projectedRoundWallSeconds: number; ideateUsd: number; buildUsd: number; requestedRounds: number; affordableRounds: number; maxBuildFeatures: number };
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
  const workloadPreference = workloadPreferenceFor(seed);
  const domain = workloadPreference ? "science" : domainFor(seed);
  const preferredWorkloadSeat = workloadPreference
    ? seat(workloadPreference.requestedModelRef, available)
    : undefined;
  const producingRoles = new Set<Role>(workloadPreference?.producingRoles ?? []);
  const seatForRun = (ref: string): Seat | undefined => seat(ref, available);
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
      const value = seatForRun(ref);
      if (!value) return [];
      return [value];
    });
  };
  const chosen = {} as Record<Role, Seat>;
  const pick = (role: Role, category: Category, producer?: Seat, requiredVendor?: string): Seat => {
    let candidates = pool(category, role).filter((candidate) => (!producer || candidate.model.id !== producer.model.id)
      && (!requiredVendor || vendor(String(candidate.model.provider)) === requiredVendor));
    if (preferredWorkloadSeat && producingRoles.has(role)
      && (!producer || preferredWorkloadSeat.model.id !== producer.model.id)
      && (!requiredVendor || vendor(String(preferredWorkloadSeat.model.provider)) === requiredVendor)) {
      candidates = [preferredWorkloadSeat, ...candidates.filter((candidate) =>
        !(candidate.model.id === preferredWorkloadSeat.model.id
          && vendor(String(candidate.model.provider)) === vendor(String(preferredWorkloadSeat.model.provider))))];
    }
    if (producer) {
      const ranking = snapshot.rankings.find((entry) => entry.category === category)!;
      const score = (candidate: Seat) => ranking.entries.find((entry) => aliases(entry.modelRef).includes(candidate.ref))?.score;
      // Quality precedes vendor diversity: only equal-scoring ranked candidates are tie-breaks.
      // Unscored configured seats cannot outrank a scored independent reviewer merely by vendor.
      const ranked = candidates.filter((candidate) => score(candidate) !== undefined);
      if (ranked.length) candidates = ranked;
      const bestScore = candidates[0] ? score(candidates[0]) : undefined;
      const cross = candidates.filter((candidate) => (bestScore === undefined || score(candidate) === bestScore)
        && vendor(String(candidate.model.provider)) !== vendor(String(producer.model.provider)));
      if (cross.length) candidates = cross;
      else if (candidates[0] && vendor(String(candidates[0].model.provider)) === vendor(String(producer.model.provider))) {
        warnings.push(`${role}: the strongest eligible independent candidate is same-vendor; quality takes priority over vendor diversity, but correlated errors remain possible.`);
      }
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
    const refs = [...new Set(candidates.flatMap((candidate) => aliases(candidate.ref)).filter((ref) => seatForRun(ref)))];
    return [role, refs];
  })) as KilnConfig["roles"];
  const config: KilnConfig = {
    ...cfg, roles, seating: { ...cfg.seating, default: roles },
    provider: { ...cfg.provider, strictDecisionTools: true },
    budgets: { ...cfg.budgets, share: { ...cfg.budgets.share } },
    ideation: { ...cfg.ideation },
  };
  const positiveInts = [cfg.ideation.rounds, cfg.ideation.islands, cfg.ideation.ideasPerBatch, cfg.ideation.entrantsCap,
    cfg.ideation.pairCap, cfg.ideation.minComparisons, cfg.ideation.scoutTurnCap, cfg.ideation.concurrency];
  if (!Number.isFinite(cfg.budgets.usd) || cfg.budgets.usd <= 0
    || (ideationPlanned && (!Number.isFinite(cfg.budgets.wallSeconds) || cfg.budgets.wallSeconds <= 0))
    || (ideationPlanned && positiveInts.some((n) => !Number.isInteger(n) || n < 1))) {
    return fail("adaptive routing requires positive dollar/wall budgets and positive ideation dimensions when ideation is planned");
  }
  if (PHASES.some((phase) => !Number.isFinite(cfg.budgets.share[phase]) || cfg.budgets.share[phase] < 0)
    || Math.abs(PHASES.reduce((sum, phase) => sum + cfg.budgets.share[phase], 0) - 1) > 1e-9) return fail("invalid budget shares");
  const total = cfg.budgets.usd;
  const initialIdeate = cfg.budgets.phaseBudgetUsd("ideate");
  const initialBuild = cfg.budgets.phaseBudgetUsd("build");
  const initialIdeateWall = cfg.budgets.phaseBudgetWallSeconds("ideate");
  const featureFloor = buildPlanned ? cfg.build.minFeatures * cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd : 0;
  if (!Number.isFinite(featureFloor) || featureFloor < 0) return fail("invalid build planning assumptions");
  const buildReserve = buildPlanned ? Math.min(initialBuild, Math.max(total * 0.2, featureFloor)) : 0;
  const maxIdeate = initialIdeate + initialBuild - buildReserve;
  const maxIdeateWall = cfg.budgets.wallSeconds * maxIdeate / total;
  const originalCandidates = ideationPlanned ? cfg.ideation.islands * cfg.ideation.ideasPerBatch * 2 : 0;
  let projection: AdaptiveRoundProjection = { rows: [], calls: 0, costUsd: 0, baseWallSeconds: 0, estimatedWallSeconds: 0 };
  let fitted = { candidates: 0, entrants: 0, pairs: 0 };
  if (ideationPlanned) {
    const candidates = adaptivePortfolioCandidates(config).map((candidate) => ({
      ...candidate,
      projection: projectedAdaptiveRound(candidate.config, (role) => chosen[role]),
    }));
    const fits = (candidate: typeof candidates[number], usd: number, wall: number) =>
      candidate.projection.costUsd * ADAPTIVE_LATENCY_SECONDS.costHeadroomMultiplier <= usd + 1e-9
      && candidate.projection.estimatedWallSeconds <= wall + 1e-9;
    const selectedInInitial = candidates.find((candidate) => fits(candidate, initialIdeate, initialIdeateWall));
    // If even the minimum cannot fit the initial phase share, use only the share the existing
    // planner is already allowed to transfer from build, after preserving any required build floor.
    const selected = selectedInInitial ?? candidates.find((candidate) =>
      candidate.projection.costUsd * ADAPTIVE_LATENCY_SECONDS.costHeadroomMultiplier <= maxIdeate + 1e-9
      && candidate.projection.estimatedWallSeconds <= maxIdeateWall + 1e-9);
    if (!selected) {
      const smallest = candidates.at(-1);
      const detail = smallest
        ? `the smallest valid ${smallest.candidates}-candidate portfolio projects $${(smallest.projection.costUsd * ADAPTIVE_LATENCY_SECONDS.costHeadroomMultiplier).toFixed(2)} with cost headroom and ${smallest.projection.estimatedWallSeconds.toFixed(0)}s`
        : `no portfolio can retain at least ${cfg.ideation.minComparisons + 1} entrants and ${cfg.ideation.minComparisons} comparisons per entrant`;
      return fail(`one ideation round does not fit the available $${maxIdeate.toFixed(2)}/${maxIdeateWall.toFixed(0)}s allocation after protected reserves: ${detail}; increase the planning target explicitly or use manual routing`);
    }
    config.ideation = { ...selected.config.ideation };
    projection = selected.projection;
    fitted = { candidates: selected.candidates, entrants: selected.entrants, pairs: selected.pairs };
    if (selected.candidates < originalCandidates) warnings.push(
      `Adaptive sizing reduced the portfolio from ${originalCandidates} to ${selected.candidates} candidates so a complete evidence-and-comparison round fits the planning estimates; evidence requirements and ${cfg.ideation.minComparisons} comparisons per entrant are unchanged.`,
    );
    if (!selectedInInitial) warnings.push("The minimum viable portfolio requires part of the build share already available to this workflow; protected build capacity remains reserved when build is planned.");
    warnings.push(`Round wall sizing uses explicit latency assumptions and ${Math.round((ADAPTIVE_LATENCY_SECONDS.stageSlackMultiplier - 1) * 100)}% stage slack; it is not a completion guarantee. Runtime dollar and deadline guards remain authoritative.`);
  }
  if (!Number.isFinite(projection.costUsd) || projection.costUsd < 0 || !Number.isFinite(projection.estimatedWallSeconds) || projection.estimatedWallSeconds < 0) {
    return fail("invalid projected round cost or wall time");
  }
  if (ideationPlanned && projection.costUsd * ADAPTIVE_LATENCY_SECONDS.costHeadroomMultiplier > maxIdeate + 1e-9) {
    const suffix = buildPlanned ? " while preserving build reserve" : " across the available ideation/build allocation";
    return fail(`one ideation round projects to $${projection.costUsd.toFixed(2)} before cost headroom, above the $${maxIdeate.toFixed(2)} available${suffix}; increase the planning target explicitly or use manual routing`);
  }
  const affordableByUsd = !ideationPlanned || projection.costUsd === 0 ? cfg.ideation.rounds
    : Math.floor((maxIdeate + 1e-9) / (projection.costUsd * ADAPTIVE_LATENCY_SECONDS.costHeadroomMultiplier));
  const affordableByWall = !ideationPlanned || projection.estimatedWallSeconds === 0 ? cfg.ideation.rounds
    : Math.floor((maxIdeateWall + 1e-9) / projection.estimatedWallSeconds);
  const affordable = !ideationPlanned ? 0 : Math.min(cfg.ideation.rounds, affordableByUsd, affordableByWall);
  if (ideationPlanned && affordable < 1) return fail("one adaptively-sized ideation round does not fit the available dollar and wall allocations");
  const wallEquivalentUsd = !ideationPlanned ? 0
    : total * (projection.estimatedWallSeconds * affordable / cfg.budgets.wallSeconds);
  const allocation = !ideationPlanned ? 0
    : Math.max(initialIdeate, Math.min(maxIdeate,
      Math.max(projection.costUsd * affordable * ADAPTIVE_LATENCY_SECONDS.costHeadroomMultiplier, wallEquivalentUsd)));
  if (ideationPlanned || buildPlanned) {
    config.budgets.share.ideate = allocation / total;
    config.budgets.share.build = (initialIdeate + initialBuild - allocation) / total;
  }
  if (ideationPlanned) config.ideation.rounds = affordable;
  const buildCaps = derivedCaps(config);
  if (buildPlanned && buildCaps.maxFeatures < cfg.build.minFeatures) return fail(`remaining build allocation funds ${buildCaps.maxFeatures} feature(s), below the configured minimum ${cfg.build.minFeatures}; increase the planning target explicitly or use manual routing`);
  if (ideationPlanned && affordable < cfg.ideation.rounds) warnings.push(`Dollar and wall-time planning funds ${affordable} projected round(s), not the requested ${cfg.ideation.rounds}. Projections are assumptions, not measurements or hard ceilings.`);
  if (Math.abs(allocation - initialIdeate) > 1e-9) warnings.push(buildPlanned && ideationPlanned
    ? "Reallocated ideation/build shares within the unchanged total; phase wall-time allocations change too, and build capacity may decrease."
    : ideationPlanned
      ? "Reallocated part of the unplanned build share to ideation within the unchanged total."
      : "Reallocated the unplanned ideation share to build within the unchanged total.");
  if (ideationPlanned && chosen.generator.model.id === chosen.prober.model.id) warnings.push("Idea islands use different lenses but the same model; the configured cheap island is not cheaper.");
  const workloadPreferenceReport: AdaptiveRoutingReport["workloadPreference"] = !workloadPreference
    ? {
      policy: "prospective_user_workload_preference_v1", workload: null, requestedModelRef: null,
      producingRoles: [], status: "not_applicable",
      reason: "No high-signal computational-biology or virtual-cell workload term matched; normal reviewed routing remains unchanged.",
    }
    : preferredWorkloadSeat
      ? {
        ...workloadPreference, status: "applied",
        reason: "Astra was selected for producing roles by a prospective user/workload preference for computational biology and virtual-cell work; this is not biology benchmark evidence.",
      }
      : {
        ...workloadPreference, status: "unavailable",
        reason: "The prospective user/workload preference requested " + workloadPreference.requestedModelRef
          + ", but " + seatUnavailableReason(workloadPreference.requestedModelRef, available)
          + ". Normal evidence-ranked/configured fallbacks were selected ("
          + workloadPreference.producingRoles.map((role) => role + "=" + chosen[role].ref).join(", ")
          + "); Astra was not used.",
      };
  if (workloadPreferenceReport.status === "unavailable") warnings.push(workloadPreferenceReport.reason);
  const unavailableRankedModels = [...new Set(snapshot.rankings.flatMap((ranking) => ranking.entries.map((entry) => entry.modelRef)))].flatMap((ref) => {
    if (aliases(ref).some((alias) => seatForRun(alias))) return [];
    const connected = aliases(ref).filter((alias) => available.has(parseModelRef(alias).provider));
    const models = connected.flatMap((alias) => { const parsed = parseModelRef(alias); const model = getBundledModel(parsed.provider as GeneratedProvider, parsed.modelId); return model ? [model] : []; });
    const reason = connected.length === 0 ? "provider not connected"
      : models.length === 0 ? "model absent from installed provider catalog"
      : models.some((model) => !isKilnToolModelSupported(model)) ? "model has no approved Kiln tool adapter"
      : "model does not satisfy Kiln text, transport, or pricing requirements";
    warnings.push(`${ref} excluded: ${reason}.`);
    return [{ modelRef: ref, reason }];
  });
  const reviewTargets: Partial<Record<Role, Role>> = {
    judge: "generator", prober: "judge", auditor: "builder", critic: "brain", scout: "brain", arbiter: "generator",
  };
  const roleReasons = Object.fromEntries(ROLES.map((role) => {
    const ranking = snapshot.rankings.find((entry) => entry.category === categories[role])!;
    const evidenceEntry = ranking.entries.find((entry) => aliases(entry.modelRef).includes(chosen[role].ref));
    const against = reviewTargets[role] ? chosen[reviewTargets[role]!].ref : null;
    const selectedByWorkloadPreference = workloadPreferenceReport.status === "applied" && producingRoles.has(role)
      && chosen[role].ref === workloadPreferenceReport.requestedModelRef;
    const reason = [
      selectedByWorkloadPreference
        ? "Selected by the prospective user/workload preference for computational biology and virtual-cell producing roles; this preference is not biology benchmark evidence."
        : evidenceEntry ? `Highest-ranked eligible candidate for ${categories[role]} after provider, tool-support, and role constraints.`
        : `Configured catalog fallback: no eligible ranked candidate satisfied ${categories[role]} role constraints.`,
      against ? `Distinct model from ${against}; benchmark quality takes priority, with vendor diversity breaking score ties.` : "No producer/reviewer separation required for this seat.",
      role === "prober" ? "Prober remains on the generator's vendor." : "",
      "Effort follows the configured role setting and supported model levels; benchmark scores do not establish quality at that effort.",
    ].filter(Boolean).join(" ");
    const effective = effortFor(cfg, role, chosen[role].model);
    if (evidenceEntry?.effort && effective !== evidenceEntry.effort) warnings.push(`${role}: benchmark effort ${evidenceEntry.effort} differs from effective effort ${effective ?? "none"}; the score is not a measured result at this run's effort.`);
    return [role, { category: categories[role], metric: ranking.metric, sourceId: evidenceEntry?.sourceId ?? ranking.sourceId,
      benchmarkEffort: evidenceEntry?.effort ?? null, benchmarkConditions: evidenceEntry?.conditions ?? null,
      score: evidenceEntry?.score ?? null, selection: selectedByWorkloadPreference ? "workload_preference" : evidenceEntry ? "ranked" : "configured_fallback", reviewAgainst: against, reason }];
  })) as AdaptiveRoutingReport["roleReasons"];
  return {
    config,
    report: { version: 1, domain, status: "ready", selectionPolicy: preferredWorkloadSeat ? "quality_first_with_workload_preference" : "quality_first", evidence: { id: snapshot.id, asOf: snapshot.asOf, sources: snapshot.sources },
      selectedRoleRefs: Object.fromEntries(ROLES.map((role) => [role, chosen[role].ref])) as Record<Role, string>,
      roleRefs: Object.fromEntries(ROLES.map((role) => [role, [...roles[role]]])) as Record<Role, string[]>,
      unavailableRankedModels,
      effectiveEffort: Object.fromEntries(ROLES.map((role) => [role, effortFor(cfg, role, chosen[role].model) ?? null])) as Record<Role, string | null>,
      workloadPreference: workloadPreferenceReport,
      roleReasons,
      workflow: { phases, ideationPlanned, buildPlanned },
      portfolio: {
        originalCandidates,
        candidates: fitted.candidates,
        islands: ideationPlanned ? config.ideation.islands : 0,
        ideasPerBatch: ideationPlanned ? config.ideation.ideasPerBatch : 0,
        entrants: fitted.entrants,
        pairs: fitted.pairs,
        planningCallsWithRetryReserve: projection.calls,
        estimatedRoundWallSeconds: projection.estimatedWallSeconds,
        assumptions: ADAPTIVE_LATENCY_SECONDS,
      },
      budget: { totalUsd: total, projectedRoundUsd: projection.costUsd, projectedRoundWallSeconds: projection.estimatedWallSeconds, ideateUsd: config.budgets.phaseBudgetUsd("ideate"), buildUsd: config.budgets.phaseBudgetUsd("build"), requestedRounds: cfg.ideation.rounds, affordableRounds: affordable, maxBuildFeatures: buildPlanned ? buildCaps.maxFeatures : 0 }, warnings },
  };
}
