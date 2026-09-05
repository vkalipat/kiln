import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultEvals, type EvalPhasePlan, type EvalsConfig, type EvalSection } from "./evals-config";
import { writeAtomic } from "./paths";

export { defaultEvals } from "./evals-config";
export type { EvalCloneAfter, EvalPhasePlan, EvalsConfig, EvalSection, EvalThrough } from "./evals-config";

export type Role =
  | "brain"
  | "scout"
  | "judge"
  | "builder"
  | "auditor"
  | "critic"
  | "reflector"
  | "generator"
  | "prober"
  | "arbiter";
export type Effort = "low" | "medium" | "high" | "xhigh";
export type CacheRetention = "short" | "long";
export type ReminderPolicy = "turn_scoped" | "text_block" | "auto";
export type Phase = "frame" | "discover" | "ideate" | "form" | "build" | "reflect";
/** The closed set of idea shapes; frozen at frame exit and recorded in `status.json`. */
export type IdeaShape = "research" | "product" | "creative";

export const ROLES: Role[] = ["brain", "scout", "judge", "builder", "auditor", "critic", "reflector", "generator", "prober", "arbiter"];
export const PHASES: Phase[] = ["frame", "discover", "ideate", "form", "build", "reflect"];
export const SHAPES: IdeaShape[] = ["research", "product", "creative"];

/** Ideate-loop knobs. Caps are per round unless the name says otherwise. */
export interface IdeationConfig {
  rounds: number;
  islands: number;
  ideasPerBatch: number;
  /** One island runs on the cheap model; ablatable in M1. */
  cheapIsland: boolean;
  /** Trigram Jaccard above this against the best archive match is a restatement candidate. */
  jaccardThreshold: number;
  entrantsCap: number;
  anchorsCap: number;
  pairCap: number;
  /** Comparisons per entrant per axis needed for frontier eligibility. */
  minComparisons: number;
  arbiterCaps: { novelty: number; collision: number };
  probe: { timeoutSeconds: number; roundWallSeconds: number };
  scoutTurnCap: number;
  mmrK: number;
  checkpointMax: number;
  checkpointMin: number;
  webTimeoutMs: number;
  /** Contact address sent to OpenAlex's polite pool by `scholar_search`; replace it with your own. */
  mailto: string;
  /** Below this share of healthy searches the run stops enforcing novelty. */
  searchHealthFloor: number;
  concurrency: number;
  searchConcurrency: number;
  /** Bradley-Terry L2 shrinkage toward equal strength. */
  btLambda: number;
  bootstrapSamples: number;
  /** Two-sided bootstrap interval probability used by the frontier's dominance test (measured default 0.5). */
  dominanceLevel: number;
  /** Weight given to a human comparison when the ladders are refit at the checkpoint. */
  humanWeight: number;
}

export interface KilnConfig {
  roles: Record<Role, string[]>;
  /** Fallback for roles absent from `effortByRole`. */
  effort: Effort;
  effortByRole?: Partial<Record<Role, Effort>>;
  provider: ProviderConfig;
  budgets: BudgetConfig;
  autonomous: boolean;
  preferApiKeys: boolean;
  ideation: IdeationConfig;
  build: BuildConfig;
  evals: EvalsConfig;
  seating: SeatingConfig;
}

export interface SeatingConfig {
  default: Partial<Record<Role, string[]>>;
  frontier: {
    roles: Partial<Record<Role, string[]>>;
    caps: Pick<BuildConfig, "builderUsdCap" | "auditorUsdCap" | "expectedAttemptUsd" | "maxFeatures">;
  };
}

export interface ProviderConfig {
  /** Server-side fallback family; shaping restricts this to producer seats. */
  fallbacks: "off" | "opus";
  /** Long retention remains opt-in per role until cache telemetry validates it. */
  cacheRetention: Partial<Record<Role, CacheRetention>>;
  thinkingDisplay: "summarized" | "updates";
  batchNudge: boolean;
  reminders: ReminderPolicy;
  promptCache: boolean;
  strictDecisionTools: boolean;
  streamIdleTimeoutMs?: number;
}

export interface BuildConfig {
  maxAttempts: number;
  sessionTurnCap: number;
  auditorTurnCap: number;
  auditorFailTurnCap: number;
  builderUsdCap: number;
  auditorUsdCap: number;
  checkTimeoutSeconds: number;
  checkOutputBytes: number;
  maxRegressionRepairs: number;
  expectedAttempts: number;
  expectedAttemptUsd: number;
  expectedCheckSeconds: number;
  expectedInitSeconds: number;
  minFeatures: number;
  maxFeatures: number;
}

/** Per-phase shares are used for both dollars and wall clock. */
export interface BudgetConfig {
  usd: number;
  wallSeconds: number;
  turns: Record<Phase, number>;
  share: Record<Phase, number>;
  reflectReserveUsd: number;
  /** Derived instead of persisted: functions are deliberately omitted from config.json. */
  phaseBudgetUsd(phase: Phase): number;
  phaseBudgetWallSeconds(phase: Phase): number;
}

export const DEFAULT_BUDGET_SHARE: Record<Phase, number> = {
  frame: 0.015,
  discover: 0.025,
  ideate: 0.42,
  form: 0.055,
  build: 0.475,
  reflect: 0.01,
};

function budgets(input: Omit<BudgetConfig, "phaseBudgetUsd" | "phaseBudgetWallSeconds">): BudgetConfig {
  return {
    ...input,
    phaseBudgetUsd(phase) {
      return this.usd * this.share[phase];
    },
    phaseBudgetWallSeconds(phase) {
      return this.wallSeconds * this.share[phase];
    },
  };
}

function validateBudgetShare(share: Record<Phase, number>): void {
  for (const phase of PHASES) {
    const value = share[phase];
    if (!Number.isFinite(value) || value < 0) throw new Error(`budgets.share.${phase} must be a finite non-negative number`);
  }
  const total = PHASES.reduce((sum, phase) => sum + share[phase], 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`budgets.share must sum to 1 (got ${total})`);
}

const STRONG = ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.5", "openai/gpt-5.5"];
// Each provider has a second strong tier before the generator's model. That keeps judge and
// generator independent even when only one provider is authenticated (record §2).
const STRONG_OTHER = [
  "openai-codex/gpt-5.4",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.4",
  "openai-codex/gpt-5.5",
  "anthropic/claude-opus-4-8",
  "openai/gpt-5.5",
];
const CHEAP = ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.4-mini", "openai/gpt-5.4-mini"];

export function defaultIdeation(): IdeationConfig {
  return {
    rounds: 3,
    islands: 3,
    ideasPerBatch: 5,
    cheapIsland: true,
    jaccardThreshold: 0.45,
    entrantsCap: 16,
    anchorsCap: 4,
    pairCap: 24,
    minComparisons: 3,
    arbiterCaps: { novelty: 30, collision: 22 },
    probe: { timeoutSeconds: 120, roundWallSeconds: 600 },
    scoutTurnCap: 6,
    mmrK: 4,
    checkpointMax: 8,
    checkpointMin: 5,
    webTimeoutMs: 30000,
    mailto: "kiln@example.invalid",
    searchHealthFloor: 0.8,
    concurrency: 4,
    searchConcurrency: 2,
    btLambda: 0.1,
    bootstrapSamples: 1000,
    dominanceLevel: 0.5,
    humanWeight: 3,
  };
}

export function defaultBuild(): BuildConfig {
  return {
    maxAttempts: 3,
    sessionTurnCap: 40,
    auditorTurnCap: 15,
    auditorFailTurnCap: 8,
    builderUsdCap: 1.256,
    auditorUsdCap: 0.6948,
    checkTimeoutSeconds: 300,
    checkOutputBytes: 8_388_608,
    maxRegressionRepairs: 2,
    expectedAttempts: 1.3,
    expectedAttemptUsd: 1.240,
    expectedCheckSeconds: 30,
    expectedInitSeconds: 120,
    minFeatures: 3,
    maxFeatures: 12,
  };
}

export function defaultConfig(): KilnConfig {
  const roles: Record<Role, string[]> = {
    brain: [...STRONG],
    scout: [...CHEAP],
    judge: [...STRONG_OTHER],
    builder: [...STRONG],
    auditor: [...STRONG_OTHER],
    critic: [...STRONG_OTHER],
    reflector: [...STRONG],
    generator: [...STRONG],
    prober: [...CHEAP],
    arbiter: [...CHEAP],
  };
  return {
    roles,
    effort: "medium",
    effortByRole: {
      brain: "high",
      builder: "high",
      critic: "high",
      generator: "medium",
      judge: "medium",
      auditor: "medium",
      reflector: "medium",
      scout: "low",
      arbiter: "low",
      prober: "low",
    },
    provider: {
      fallbacks: "opus",
      cacheRetention: {},
      thinkingDisplay: "summarized",
      batchNudge: true,
      reminders: "auto",
      promptCache: true,
      strictDecisionTools: true,
    },
    budgets: budgets({
      usd: 25,
      wallSeconds: 4 * 3600,
      turns: { frame: 10, discover: 20, ideate: 60, form: 30, build: 40, reflect: 10 },
      share: { ...DEFAULT_BUDGET_SHARE },
      reflectReserveUsd: 0.25,
    }),
    autonomous: false,
    preferApiKeys: false,
    ideation: defaultIdeation(),
    build: defaultBuild(),
    evals: defaultEvals(),
    seating: {
      default: Object.fromEntries(Object.entries(roles).map(([role, refs]) => [role, [...refs]])),
      frontier: {
        roles: {
          brain: ["anthropic/claude-fable-5-1"], builder: ["anthropic/claude-fable-5-1"],
          reflector: ["anthropic/claude-fable-5-1"], generator: ["anthropic/claude-fable-5-1"],
          judge: ["anthropic/claude-opus-5"], auditor: ["anthropic/claude-opus-5"], critic: ["anthropic/claude-opus-5"],
          scout: [...CHEAP], prober: [...CHEAP], arbiter: [...CHEAP],
        },
        caps: { builderUsdCap: 2.512, auditorUsdCap: 0.6654, expectedAttemptUsd: 2.069, maxFeatures: 4 },
      },
    },
  };
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

type PartialIdeation = Partial<Omit<IdeationConfig, "arbiterCaps" | "probe">> & {
  arbiterCaps?: Partial<IdeationConfig["arbiterCaps"]>;
  probe?: Partial<IdeationConfig["probe"]>;
};

type PartialEvals = Partial<Omit<EvalsConfig, "sectionPhases" | "rolePhases">> & {
  sectionPhases?: Partial<Record<EvalSection, Partial<EvalPhasePlan>>>;
  rolePhases?: Partial<Record<Role, Partial<EvalPhasePlan>>>;
};

type PartialSeating = {
  default?: Partial<Record<Role, string[]>>;
  frontier?: {
    roles?: Partial<Record<Role, string[]>>;
    caps?: Partial<SeatingConfig["frontier"]["caps"]>;
  };
};

/**
 * A config written before the ideate phase existed has neither the new roles nor an `ideation`
 * section, so every level is merged over the defaults rather than replaced: missing role lists and
 * missing ideation keys (including the two nested objects) keep their default values.
 */
export function loadConfig(home: string): KilnConfig {
  const d = defaultConfig();
  if (!existsSync(configPath(home))) return d;
  const raw = JSON.parse(readFileSync(configPath(home), "utf8")) as Partial<Omit<KilnConfig, "roles" | "effortByRole" | "provider" | "ideation" | "build" | "budgets" | "evals" | "seating">> & {
    roles?: Partial<Record<Role, string[]>>;
    effortByRole?: Partial<Record<Role, Effort>>;
    provider?: Partial<Omit<ProviderConfig, "cacheRetention">> & {
      cacheRetention?: Partial<Record<Role, CacheRetention>>;
    };
    ideation?: PartialIdeation;
    build?: Partial<BuildConfig>;
    evals?: PartialEvals;
    seating?: PartialSeating;
    budgets?: Partial<Omit<BudgetConfig, "phaseBudgetUsd" | "phaseBudgetWallSeconds">> & {
      turns?: Partial<Record<Phase, number>>;
      share?: Partial<Record<Phase, number>>;
    };
  };
  const i = raw.ideation ?? {};
  const evals = raw.evals ?? {};
  const seating = raw.seating ?? {};
  const share = { ...d.budgets.share, ...(raw.budgets?.share ?? {}) };
  validateBudgetShare(share);
  return {
    roles: { ...d.roles, ...(raw.roles ?? {}) },
    effort: raw.effort ?? d.effort,
    effortByRole: { ...d.effortByRole, ...(raw.effortByRole ?? {}) },
    provider: {
      ...d.provider,
      ...(raw.provider ?? {}),
      cacheRetention: { ...d.provider.cacheRetention, ...(raw.provider?.cacheRetention ?? {}) },
    },
    budgets: budgets({
      usd: raw.budgets?.usd ?? d.budgets.usd,
      wallSeconds: raw.budgets?.wallSeconds ?? d.budgets.wallSeconds,
      turns: { ...d.budgets.turns, ...(raw.budgets?.turns ?? {}) },
      share,
      reflectReserveUsd: raw.budgets?.reflectReserveUsd ?? d.budgets.reflectReserveUsd,
    }),
    autonomous: raw.autonomous ?? d.autonomous,
    preferApiKeys: raw.preferApiKeys ?? d.preferApiKeys,
    ideation: {
      ...d.ideation,
      ...i,
      arbiterCaps: { ...d.ideation.arbiterCaps, ...(i.arbiterCaps ?? {}) },
      probe: { ...d.ideation.probe, ...(i.probe ?? {}) },
    },
    build: { ...d.build, ...(raw.build ?? {}) },
    evals: {
      ...d.evals,
      ...evals,
      sectionPhases: Object.fromEntries(Object.entries(d.evals.sectionPhases).map(([section, plan]) => [
        section, { ...plan, ...(evals.sectionPhases?.[section as EvalSection] ?? {}) },
      ])) as Record<EvalSection, EvalPhasePlan>,
      rolePhases: Object.fromEntries(ROLES.map((role) => [role, { ...d.evals.rolePhases[role], ...(evals.rolePhases?.[role] ?? {}) }])) as Record<Role, EvalPhasePlan>,
    },
    seating: {
      default: { ...d.seating.default, ...(seating.default ?? {}) },
      frontier: {
        roles: { ...d.seating.frontier.roles, ...(seating.frontier?.roles ?? {}) },
        caps: { ...d.seating.frontier.caps, ...(seating.frontier?.caps ?? {}) },
      },
    },
  };
}

export function saveConfig(home: string, cfg: KilnConfig): void {
  writeAtomic(configPath(home), `${JSON.stringify(cfg, null, 2)}\n`);
}
