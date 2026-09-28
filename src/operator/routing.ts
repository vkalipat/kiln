import { getBundledModel, type GeneratedProvider, type Model } from "@oh-my-pi/pi-catalog";
import type { KilnConfig, Role } from "../core/config";
import { hashInput } from "../core/record";
import { sha256Bytes } from "../evals/seeds";
import { effortFor, isKilnToolModelSupported, parseModelRef, providerVendor, type EffortName } from "../providers/models";
import {
  DEFAULT_EVIDENCE_SNAPSHOT,
  planAdaptiveRouting,
  type AdaptiveRoutingReport,
} from "../routing/adaptive";
import type { OperatorContextEntry, OperatorStepKind } from "./context";

export type { OperatorStepKind } from "./context";

export interface AdmittedStepModel {
  ref: string;
  effort: EffortName | null;
}

export interface PreparedStepRouting {
  version: 1;
  seedHash: string;
  configHash: string;
  availableProviders: string[];
  evidence: AdaptiveRoutingReport["evidence"];
  selectedRoleRefs: Record<Role, string>;
  admittedRoleRefs: Record<Role, AdmittedStepModel[]>;
  roleReasons: AdaptiveRoutingReport["roleReasons"];
  workloadPreference: AdaptiveRoutingReport["workloadPreference"];
  fingerprint: string;
}

export interface ResolveStepOptions {
  prepared?: PreparedStepRouting;
  /** Actual producer under review. It must be from the prepared admitted pool. */
  producerRef?: string;
  /** Producing step being reviewed; selects its paired reviewer role. */
  currentStep?: OperatorStepKind;
  /** Optional fixed subset of the prepared admitted refs. Unsupported or unadmitted refs reject. */
  modelPool?: readonly string[];
}

export interface StepRoutingDecision {
  version: 1;
  kind: OperatorStepKind;
  role: Role;
  model: Model;
  modelRef: string;
  effort: EffortName | null;
  producerRef?: string;
  preparedFingerprint: string;
  reason: string;
  contextEntry: OperatorContextEntry;
}

const STEP_ROLE: Record<Exclude<OperatorStepKind, "review">, Role> = {
  research: "scout",
  ideate: "generator",
  implement: "builder",
  synthesize: "brain",
};
const REVIEW_ROLE: Partial<Record<OperatorStepKind, Role>> = {
  research: "critic",
  ideate: "judge",
  implement: "auditor",
  synthesize: "critic",
  review: "auditor",
};

function configHash(cfg: KilnConfig): string {
  return hashInput({
    roles: cfg.roles,
    effort: cfg.effort,
    effortByRole: cfg.effortByRole ?? null,
    provider: cfg.provider,
    budgets: {
      usd: cfg.budgets.usd,
      wallSeconds: cfg.budgets.wallSeconds,
      turns: cfg.budgets.turns,
      share: cfg.budgets.share,
      reflectReserveUsd: cfg.budgets.reflectReserveUsd,
    },
    autonomous: cfg.autonomous,
    preferApiKeys: cfg.preferApiKeys,
    ideation: cfg.ideation,
    build: cfg.build,
    seating: cfg.seating,
    routing: cfg.routing ?? null,
  });
}

function preparedBody(value: Omit<PreparedStepRouting, "fingerprint">): Omit<PreparedStepRouting, "fingerprint"> {
  return value;
}

function modelForRef(ref: string, available: ReadonlySet<string>): Model {
  const { provider, modelId } = parseModelRef(ref);
  if (!available.has(provider)) throw new Error(`step routing model provider is not available: ${provider}`);
  const model = getBundledModel(provider as GeneratedProvider, modelId);
  if (!model || !isKilnToolModelSupported(model) || !model.input.includes("text")
    || !(model.api.includes("responses") || model.api === "anthropic-messages")
    || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output)
    || model.cost.input < 0 || model.cost.output < 0) {
    throw new Error(`step routing model is unsupported: ${ref}`);
  }
  return model;
}

function sameIdentity(left: string, right: string, available: ReadonlySet<string>): boolean {
  const a = modelForRef(left, available);
  const b = modelForRef(right, available);
  return providerVendor(String(a.provider)) === providerVendor(String(b.provider)) && a.id === b.id;
}

function inputIdentity(cfg: KilnConfig, available: ReadonlySet<string>, seed: string) {
  return {
    seedHash: sha256Bytes(seed),
    configHash: configHash(cfg),
    availableProviders: [...available].sort(),
  };
}

/** Prepare the fixed, provider-call-free admitted pool once for an operator run. */
export function prepareStepRouting(
  cfg: KilnConfig,
  available: ReadonlySet<string>,
  seed: string,
  now = new Date(),
): PreparedStepRouting {
  const availableSet = new Set(available);
  const planned = planAdaptiveRouting(cfg, availableSet, seed, now, DEFAULT_EVIDENCE_SNAPSHOT, { phases: ["frame"] });
  const identity = inputIdentity(cfg, available, seed);
  const admittedRoleRefs = Object.fromEntries(Object.entries(planned.report.roleRefs).map(([role, refs]) => [
    role,
    refs.map((ref) => ({ ref, effort: effortFor(cfg, role as Role, modelForRef(ref, available)) ?? null })),
  ])) as Record<Role, AdmittedStepModel[]>;
  const body = preparedBody({
    version: 1,
    ...identity,
    evidence: planned.report.evidence,
    selectedRoleRefs: planned.report.selectedRoleRefs,
    admittedRoleRefs,
    roleReasons: planned.report.roleReasons,
    workloadPreference: planned.report.workloadPreference,
  });
  return { ...body, fingerprint: hashInput(body) };
}

function validatePrepared(
  value: PreparedStepRouting,
  cfg: KilnConfig,
  available: ReadonlySet<string>,
  seed: string,
): PreparedStepRouting {
  if (!value || value.version !== 1) throw new Error("invalid prepared step routing");
  const { fingerprint, ...body } = value;
  if (fingerprint !== hashInput(body)) throw new Error("prepared step routing fingerprint mismatch");
  const identity = inputIdentity(cfg, available, seed);
  if (value.seedHash !== identity.seedHash || value.configHash !== identity.configHash
    || JSON.stringify(value.availableProviders) !== JSON.stringify(identity.availableProviders)) {
    throw new Error("prepared step routing does not match the current seed, config, or provider pool");
  }
  for (const entries of Object.values(value.admittedRoleRefs)) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("prepared step routing has an empty role pool");
    for (const entry of entries) {
      modelForRef(entry.ref, available);
      if (entry.effort !== null && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(entry.effort)) {
        throw new Error("prepared step routing has invalid effort");
      }
    }
  }
  return value;
}

function admittedSet(prepared: PreparedStepRouting): Set<string> {
  return new Set(Object.values(prepared.admittedRoleRefs).flat().map((entry) => entry.ref));
}

/**
 * Resolve one operator step to one admitted model. This selects; it never dispatches a fallback.
 * The returned context entry is a byte-hashed routing report, not evidence of task correctness.
 */
export function resolveStep(
  kind: OperatorStepKind,
  cfg: KilnConfig,
  available: ReadonlySet<string>,
  seed: string,
  options: ResolveStepOptions = {},
): StepRoutingDecision {
  if (!["research", "ideate", "implement", "review", "synthesize"].includes(kind)) {
    throw new Error("invalid operator step kind");
  }
  const prepared = validatePrepared(options.prepared ?? prepareStepRouting(cfg, available, seed), cfg, available, seed);
  const allAdmitted = admittedSet(prepared);
  let fixedPool = allAdmitted;
  if (options.modelPool !== undefined) {
    if (options.modelPool.length === 0 || new Set(options.modelPool).size !== options.modelPool.length) {
      throw new Error("step routing model pool must contain unique admitted refs");
    }
    for (const ref of options.modelPool) {
      modelForRef(ref, available);
      if (!allAdmitted.has(ref)) throw new Error(`step routing model is not in the prepared admitted pool: ${ref}`);
    }
    fixedPool = new Set(options.modelPool);
  }
  let producerRef = kind === "review" ? options.producerRef : undefined;
  if (producerRef !== undefined) {
    modelForRef(producerRef, available);
    if (!allAdmitted.has(producerRef)) throw new Error("review producer is not in the prepared admitted pool");
  }
  if (kind === "review" && producerRef === undefined && options.currentStep && options.currentStep !== "review") {
    producerRef = prepared.selectedRoleRefs[STEP_ROLE[options.currentStep]];
  }
  if (kind === "review" && producerRef === undefined) producerRef = prepared.selectedRoleRefs.builder;
  const role = kind === "review" ? REVIEW_ROLE[options.currentStep ?? "review"] ?? "auditor" : STEP_ROLE[kind];
  const candidates = prepared.admittedRoleRefs[role].filter((entry) =>
    fixedPool.has(entry.ref) && (!producerRef || !sameIdentity(entry.ref, producerRef, available)));
  const selected = candidates[0];
  if (!selected) {
    throw new Error(`no admitted model for ${kind}/${role}${producerRef ? " distinct from " + producerRef : ""} in the fixed pool`);
  }
  const model = modelForRef(selected.ref, available);
  const primary = selected.ref === prepared.selectedRoleRefs[role];
  const reason = [
    `Selected the prepared ${role} seat for the ${kind} step${primary ? "" : " from the explicit fixed pool"}.`,
    producerRef ? `Its model identity is distinct from the actual producer ${producerRef}.` : "",
    primary ? prepared.roleReasons[role].reason : "The primary seat was excluded by the fixed pool or producer-independence requirement.",
    `The decision uses reviewed snapshot ${prepared.evidence.id} as routing evidence; benchmark rank is not proof of task correctness.`,
    "Only this model is selected. A refusal or provider error does not dispatch another ref automatically.",
  ].filter(Boolean).join(" ");
  const core = {
    version: 1 as const, kind, role, modelRef: selected.ref, effort: selected.effort,
    ...(producerRef ? { producerRef } : {}),
    preparedFingerprint: prepared.fingerprint,
    evidence: { id: prepared.evidence.id, asOf: prepared.evidence.asOf },
    reason,
  };
  const text = JSON.stringify(core);
  const contextEntry: OperatorContextEntry = {
    id: `step-route-${hashInput(core).slice(0, 20)}`,
    kind: "decision",
    owner: "operator-routing",
    text,
    sourceHash: sha256Bytes(text),
    status: "unaltered_report",
    priority: 100,
    audience: { roles: [role], steps: [kind] },
  };
  return {
    version: 1, kind, role, model, modelRef: selected.ref, effort: selected.effort,
    ...(producerRef ? { producerRef } : {}),
    preparedFingerprint: prepared.fingerprint, reason, contextEntry,
  };
}
