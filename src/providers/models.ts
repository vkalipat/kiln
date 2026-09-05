import { calculateUsageCost, getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog";
import type { GeneratedProvider, Model, Usage } from "@oh-my-pi/pi-catalog";
import type { KilnConfig, Role } from "../core/config";
import type { AuthStore } from "./auth";
import { runtimeEffort } from "./effort-runtime";

/** Mirrors pi-catalog's `Effort` values as plain strings (see `Model.thinking?.efforts`), least to most intensive. */
export type EffortName = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT_ORDER: readonly EffortName[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export type ModelFamily = "fable" | "astra" | "other";

/** Prompt/request family inferred from the catalog model id, independent of provider aliases. */
export function modelFamily(model: Pick<Model, "id"> | string): ModelFamily {
  const id = typeof model === "string" ? model : model.id;
  if (id.startsWith("claude-fable-") || id.startsWith("claude-opus-5") || id.startsWith("claude-mythos-")) return "fable";
  if (id.startsWith("gpt-6")) return "astra";
  return "other";
}

export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) throw new Error(`malformed model ref "${ref}", expected provider/model`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** Look up a bundled catalog model. `getBundledModel` never throws for an unknown provider/id — it returns `undefined`. */
function catalogModel(provider: string, modelId: string): Model | undefined {
  return getBundledModel(provider as GeneratedProvider, modelId) ?? undefined;
}

export async function availableProviders(auth: AuthStore, cfg: KilnConfig): Promise<Set<string>> {
  const wanted = new Set<string>();
  for (const refs of Object.values(cfg.roles)) for (const r of refs) wanted.add(parseModelRef(r).provider);
  const out = new Set<string>();
  for (const p of wanted) {
    try {
      if (await auth.apiKeyFor(p, { preferApiKeys: cfg.preferApiKeys })) out.add(p);
    } catch {
      // A throwing apiKeyFor means this provider's credential can't be resolved right now
      // (e.g. an env resolver throwing); treat it as unavailable rather than letting one bad
      // provider crash the whole availability check.
    }
  }
  return out;
}

export class NoModelError extends Error {}

export function resolveRole(role: Role, cfg: KilnConfig, available: Set<string>): { model: Model; ref: string } {
  const tried: string[] = [];
  for (const ref of cfg.roles[role]) {
    const { provider, modelId } = parseModelRef(ref);
    tried.push(ref);
    if (!available.has(provider)) continue;
    const model = catalogModel(provider, modelId);
    if (model) return { model, ref };
  }
  throw new NoModelError(
    `no model available for role ${role}; tried ${tried.join(", ")}; available providers: ${[...available].join(", ") || "none"}`,
  );
}

/**
 * Resolves a role restricted to one provider: the first ref in the role's list on that provider that
 * the catalog knows. Used to place a worker off the judge's provider (record §2), which is only
 * meaningful when the choice of provider is the caller's, not the list order's.
 */
export function resolveRoleOn(role: Role, provider: string, cfg: KilnConfig, available: ReadonlySet<string>, excludeRef?: string): { model: Model; ref: string } {
  const tried: string[] = [];
  if (available.has(provider)) {
    for (const ref of cfg.roles[role]) {
      const parsed = parseModelRef(ref);
      if (parsed.provider !== provider) continue;
      tried.push(ref);
      if (ref === excludeRef) continue;
      const model = catalogModel(provider, parsed.modelId);
      if (model) return { model, ref };
    }
  }
  throw new NoModelError(
    `no model available for role ${role} on provider ${provider}; tried ${tried.join(", ") || "no ref in the role's list"}; ` +
      `available providers: ${[...available].join(", ") || "none"}${excludeRef ? `; excluding ${excludeRef}` : ""}`,
  );
}

/** Prefers a provider different from `provider`; falls back to `provider` itself if it's the only one available. */
export function otherProvider(provider: string, available: Set<string>): string | undefined {
  for (const p of available) if (p !== provider) return p;
  return available.has(provider) ? provider : undefined;
}

/**
 * Clamps a requested effort against the model's supported levels: the exact level if supported,
 * else the highest supported level below it, else the lowest supported level (a valid effort beats
 * sending none to a model that expects one). `undefined` only when the model lists no efforts at all.
 */
export function clampEffort(model: Model, effort: string): EffortName | undefined {
  const supported = (model.thinking?.efforts ?? []) as readonly EffortName[];
  if (supported.length === 0) return undefined;
  if (supported.includes(effort as EffortName)) return effort as EffortName;
  const want = EFFORT_ORDER.indexOf(effort as EffortName);
  for (let i = want - 1; i >= 0; i--) {
    const level = EFFORT_ORDER[i]!;
    if (supported.includes(level)) return level;
  }
  // Nothing supported is at or below the request (or `effort` wasn't a recognized level):
  // `thinking.efforts` is documented least → most intensive, so index 0 is the lowest.
  return supported[0];
}

/** Runtime measured effort wins over role/global config, then the seated model clamps it. */
export function effortFor(cfg: KilnConfig, role: Role, model: Model): EffortName | undefined {
  return clampEffort(model, runtimeEffort(cfg, role, model) ?? cfg.effortByRole?.[role] ?? cfg.effort);
}

/** `calculateUsageCost` mutates `usage.cost` in place and returns that same object; only the total is needed here. */
export function modelCostUsd(model: Model, usage: Usage): number {
  return calculateUsageCost(model.cost, usage).total;
}
