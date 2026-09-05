import { isAbsolute, normalize } from "node:path";
import type { KilnConfig } from "../core/config";
import type { Predicate } from "../core/predicate";
import { attemptCeiling } from "../core/budget";
import type { ParsedSpec } from "./spec";

export type Acceptance =
  | { type: "shell"; command: string; expect?: Predicate; timeoutSeconds?: number; needs?: string[] }
  | { type: "file"; path: string; contains?: string; needs?: string[] }
  | { type: "manual"; instructions: string };

export interface Feature {
  id: string;
  title: string;
  description: string;
  acceptance: Acceptance;
}

export interface FeatureDraft extends Omit<Feature, "id"> {
  id?: string;
}

export interface FeaturesFile {
  version: 1;
  init: { needs: string[] };
  features: Feature[];
}

export interface FeaturesDraft {
  version: 1;
  init: { needs: string[] };
  features: FeatureDraft[];
}

export interface DerivedCaps {
  maxFeatures: number;
  attemptCeiling: number;
  expectedAttemptUsd: number;
  featureCeilingBase: number;
  formationAttempts: number;
}

export interface ValidateFeatureOptions {
  /** The assigned sequence before a critique revision; reorder, rename and deletion are problems. */
  expectedIds?: readonly string[];
}

export const PROJECTED_FORMATION_USD = 1.315;
const FEATURE_KEYS = new Set(["id", "title", "description", "acceptance"]);

export function parseFeatures(text: string): FeaturesDraft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`features.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object") throw new Error("features.json must be an object");
  const raw = value as Record<string, unknown>;
  if (!raw.init || typeof raw.init !== "object" || !Array.isArray((raw.init as Record<string, unknown>).needs)) {
    throw new Error("features.json init.needs must be a list");
  }
  if (!Array.isArray(raw.features)) throw new Error("features.json features must be a list");
  return value as FeaturesDraft;
}

export function assignIds(file: FeaturesDraft): FeaturesFile {
  return {
    // Preserve a malformed version so validation can report it instead of silently repairing it.
    version: file.version,
    init: { needs: [...file.init.needs] },
    features: file.features.map((value, index) => {
      // Keep malformed entries malformed for validateFeatures to report. The harness-assignment
      // boundary must not throw before the one corrective re-ask can see the problem.
      if (!value || typeof value !== "object") return value as unknown as Feature;
      const feature = value as FeatureDraft;
      return {
        id: `f${String(index + 1).padStart(2, "0")}`,
        title: feature.title,
        description: feature.description,
        acceptance: feature.acceptance && typeof feature.acceptance === "object" ? { ...feature.acceptance } : feature.acceptance,
      } as Feature;
    }),
  };
}

function normalizedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/(?:;\s*)+$/, "").trim();
}

function hasPathToken(command: string): boolean {
  return /(?:^|\s)(?:\.{0,2}\/|~\/|[^\s]*\/[^\s]*|[^\s]+\.[A-Za-z0-9_-]{1,12})(?=\s|$)/.test(command)
    || /(?:^|\s)(?:>>?|<)\s*\S+/.test(command);
}

export function isTrivialCommand(command: string): boolean {
  const body = normalizedCommand(command);
  if (new Set(["true", ":", "exit 0", "test 1 = 1", "[ 1 = 1 ]", "/bin/true"]).has(body)) return true;
  const first = body.split(" ")[0] ?? "";
  return ["echo", "printf", "true", ":"].includes(first) && !hasPathToken(body);
}

export function derivedCaps(cfg: KilnConfig): DerivedCaps {
  const floor = attemptCeiling(cfg);
  const expected = cfg.build.expectedAttemptUsd;
  const budgetSized = Math.floor(cfg.budgets.phaseBudgetUsd("build") / (cfg.build.expectedAttempts * expected));
  const maxFeatures = Math.max(0, Math.min(12, cfg.build.maxFeatures, budgetSized));
  const perFeatureShare = cfg.budgets.phaseBudgetUsd("build") / Math.max(1, maxFeatures);
  return {
    maxFeatures,
    attemptCeiling: floor,
    expectedAttemptUsd: expected,
    featureCeilingBase: Math.max(cfg.build.maxAttempts * expected, floor, perFeatureShare),
    formationAttempts: Math.max(1, Math.floor(cfg.budgets.phaseBudgetUsd("form") / PROJECTED_FORMATION_USD)),
  };
}

function validateNeeds(value: unknown, prefix: string, problems: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { problems.push(`${prefix} must be a list`); return; }
  value.forEach((need, index) => {
    if (typeof need !== "string" || need.trim() === "") problems.push(`${prefix}[${index}] must be a non-empty string`);
  });
}

function validatePredicate(value: unknown, prefix: string, problems: string[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object") { problems.push(`${prefix} must be an object`); return; }
  const predicate = value as Partial<Predicate>;
  if (predicate.type !== "substring" && predicate.type !== "regex") problems.push(`${prefix}.type must be substring or regex`);
  if (typeof predicate.value !== "string" || predicate.value === "") problems.push(`${prefix}.value must be a non-empty string`);
  if (predicate.type === "regex" && typeof predicate.value === "string") {
    try { new RegExp(predicate.value); } catch (error) { problems.push(`${prefix}.value is not a valid regex: ${(error as Error).message}`); }
  }
}

function validateAcceptance(value: unknown, index: number, problems: string[]): boolean {
  const prefix = `features[${index}].acceptance`;
  if (!value || typeof value !== "object") { problems.push(`${prefix} must be an object`); return false; }
  const acceptance = value as Record<string, unknown>;
  if (acceptance.type === "shell") {
    if (typeof acceptance.command !== "string" || acceptance.command.trim() === "") problems.push(`${prefix}.command must be non-empty`);
    else if (acceptance.expect === undefined && isTrivialCommand(acceptance.command)) problems.push(`${prefix}.command is trivial and cannot verify the feature`);
    validatePredicate(acceptance.expect, `${prefix}.expect`, problems);
    validateNeeds(acceptance.needs, `${prefix}.needs`, problems);
    if (acceptance.timeoutSeconds !== undefined && (!Number.isFinite(acceptance.timeoutSeconds) || Number(acceptance.timeoutSeconds) <= 0)) {
      problems.push(`${prefix}.timeoutSeconds must be a positive finite number`);
    }
    return true;
  }
  if (acceptance.type === "file") {
    if (typeof acceptance.path !== "string" || acceptance.path.trim() === "") problems.push(`${prefix}.path must be non-empty`);
    else if (acceptance.path.includes("\0")) problems.push(`${prefix}.path must not contain a NUL byte`);
    else if (isAbsolute(acceptance.path) || normalize(acceptance.path).split(/[\\/]/).includes("..")) problems.push(`${prefix}.path must be relative and stay inside the repo`);
    if (acceptance.contains !== undefined && typeof acceptance.contains !== "string") problems.push(`${prefix}.contains must be a string`);
    validateNeeds(acceptance.needs, `${prefix}.needs`, problems);
    return true;
  }
  if (acceptance.type === "manual") {
    if (typeof acceptance.instructions !== "string" || acceptance.instructions.trim() === "") problems.push(`${prefix}.instructions must be non-empty`);
    return false;
  }
  problems.push(`${prefix}.type must be shell, file, or manual`);
  return false;
}

export function validateFeatures(
  file: FeaturesFile,
  _spec: ParsedSpec,
  cfg: KilnConfig,
  opts: ValidateFeatureOptions = {},
): string[] {
  const problems: string[] = [];
  const raw = file as unknown as Record<string, unknown>;
  if (raw.version !== 1) problems.push("version must be 1");
  const init = raw.init;
  if (!init || typeof init !== "object") problems.push("init must be an object");
  else if ((init as Record<string, unknown>).needs === undefined) problems.push("init.needs must be a list");
  else validateNeeds((init as Record<string, unknown>).needs, "init.needs", problems);
  if (!Array.isArray(raw.features)) {
    problems.push("features must be a list");
    return problems;
  }

  const features = raw.features as unknown[];
  const caps = derivedCaps(cfg);
  if (features.length < cfg.build.minFeatures) problems.push(`features: ${features.length} found; minimum is ${cfg.build.minFeatures}`);
  if (features.length > caps.maxFeatures) problems.push(`features: ${features.length} found; budget-sized maximum is ${caps.maxFeatures}`);

  const ids = new Set<string>();
  let executable = 0;
  features.forEach((value, index) => {
    const prefix = `features[${index}]`;
    if (!value || typeof value !== "object") { problems.push(`${prefix} must be an object`); return; }
    const feature = value as Record<string, unknown>;
    for (const key of Object.keys(feature)) {
      if (!FEATURE_KEYS.has(key)) problems.push(`${prefix}.${key} is not allowed in a frozen feature`);
    }
    const expected = `f${String(index + 1).padStart(2, "0")}`;
    if (typeof feature.id !== "string" || feature.id === "") problems.push(`${prefix}.id must be assigned`);
    else {
      if (ids.has(feature.id)) problems.push(`${prefix}.id duplicates ${feature.id}`);
      ids.add(feature.id);
      if (feature.id !== expected) problems.push(`${prefix}.id must remain ${expected} (got ${feature.id})`);
    }
    if (typeof feature.title !== "string" || feature.title.trim() === "") problems.push(`${prefix}.title must be non-empty`);
    if (typeof feature.description !== "string" || feature.description.trim() === "") problems.push(`${prefix}.description must be non-empty`);
    if (validateAcceptance(feature.acceptance, index, problems)) executable += 1;
  });

  if (opts.expectedIds) {
    const actual = features.map((feature) => (feature && typeof feature === "object" ? String((feature as Record<string, unknown>).id ?? "") : ""));
    if (actual.length !== opts.expectedIds.length || actual.some((id, index) => id !== opts.expectedIds![index])) {
      problems.push(`feature ids changed; expected ${opts.expectedIds.join(", ")}, got ${actual.join(", ")}`);
    }
  }
  if (features.length > 0 && (features[0] as Record<string, unknown> | undefined)?.acceptance && (features[0] as { acceptance: { type?: unknown } }).acceptance.type === "manual") {
    problems.push("features[0].acceptance must be executable (shell or file)");
  }
  if (executable === 0) problems.push("at least one feature must have an executable acceptance check");

  const expectedCheck = cfg.build.expectedCheckSeconds;
  const projected = features.length * (features.length - 1) / 2 * expectedCheck
    + features.length * cfg.build.expectedAttempts * expectedCheck
    + cfg.build.expectedInitSeconds;
  const allowance = cfg.budgets.phaseBudgetWallSeconds("build") * 0.35;
  if (projected > allowance) problems.push(`features exceed wall-clock sizing allowance: projected ${projected}s, allowance ${allowance}s`);
  return problems;
}
