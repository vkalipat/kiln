import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import { fail, ok } from "../brain/tools/shape";
import type { CritiqueItem } from "../core/events";
import { effortFor, NoModelError, otherProvider, parseModelRef } from "../providers/models";
import type { PhaseDeps } from "../phases/frame";
import { isTrivialCommand, type FeaturesFile } from "./features";

export interface Critique {
  verdict: "ok" | "revise";
  scopeCreep: CritiqueItem[];
  unverifiable: CritiqueItem[];
  missing: CritiqueItem[];
  crossProvider: boolean;
  costUsd: number;
}

export interface CritiqueOptions {
  spec: string;
  features: string;
  dossier: string;
  brief: string;
  brainRef: string;
  formationCeilingUsd: number;
  spentUsd: () => number;
  onResult: (result: BrainResult) => void;
}

export class CritiqueRunError extends Error {
  constructor(message: string, readonly result: BrainResult) {
    super(message);
    this.name = "CritiqueRunError";
  }
}

function resolveCritic(deps: PhaseDeps, brainRef: string) {
  if (!deps.modelsOn || !deps.availableProviders) throw new NoModelError("critic requires an admitted provider-restricted model resolver");
  const producer = parseModelRef(brainRef).provider;
  const errors: string[] = [];
  const provider = otherProvider(producer, new Set(deps.availableProviders));
  if (provider && provider !== producer) {
    try {
      const seat = deps.modelsOn("critic", provider);
      if (seat.ref === brainRef) throw new NoModelError(`resolver returned producer ref ${brainRef}`);
      return { ...seat, crossProvider: true };
    }
    catch (error) { errors.push((error as Error).message); }
  }
  try {
    const seat = deps.modelsOn("critic", producer, brainRef);
    if (seat.ref === brainRef) throw new NoModelError(`resolver returned producer ref ${brainRef}`);
    return { ...seat, crossProvider: false };
  }
  catch (error) { errors.push((error as Error).message); }
  throw new NoModelError(`no independent critic model available for ${brainRef}: ${errors.join("; ")}`);
}

function items(value: unknown): CritiqueItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CritiqueItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== "string" || item.text.trim() === "") return undefined;
    if (item.featureId !== undefined && typeof item.featureId !== "string") return undefined;
    out.push({ text: item.text.trim(), ...(item.featureId === undefined ? {} : { featureId: item.featureId }) });
  }
  return out;
}

function stopped(result: BrainResult): boolean {
  return result.stopped === "turn_cap" || result.stopped === "usd_cap" || result.stopped === "error";
}

/** One independent stateless critic, with one malformed/missing-call retry. */
export async function runCritique(deps: PhaseDeps, options: CritiqueOptions): Promise<Critique> {
  const chosen = resolveCritic(deps, options.brainRef);
  let captured: Omit<Critique, "crossProvider" | "costUsd"> | undefined;
  let problem = "critic did not call critique";
  const tool: AgentTool<any> = {
    name: "critique",
    label: "Critique",
    intent: "omit",
    description: "Return scope creep, unverifiable checks, missing work, and an ok or revise verdict. Do not offer advice.",
    parameters: {
      type: "object",
      properties: {
        scopeCreep: { type: "array", items: { type: "object", properties: { featureId: { type: "string" }, text: { type: "string" } }, required: ["text"] } },
        unverifiable: { type: "array", items: { type: "object", properties: { featureId: { type: "string" }, text: { type: "string" } }, required: ["text"] } },
        missing: { type: "array", items: { type: "object", properties: { featureId: { type: "string" }, text: { type: "string" } }, required: ["text"] } },
        verdict: { type: "string", enum: ["ok", "revise"] },
      },
      required: ["scopeCreep", "unverifiable", "missing", "verdict"],
    },
    async execute(_id, raw: Record<string, unknown>) {
      const scopeCreep = items(raw.scopeCreep); const unverifiable = items(raw.unverifiable); const missing = items(raw.missing);
      if (!scopeCreep || !unverifiable || !missing || (raw.verdict !== "ok" && raw.verdict !== "revise")) {
        problem = "critique requires three item arrays and verdict ok or revise";
        return fail(problem);
      }
      captured = { scopeCreep, unverifiable, missing, verdict: raw.verdict };
      return ok("critique recorded");
    },
  };
  const brain = createBrain({
    model: chosen.model,
    getApiKey: () => deps.apiKeyFor(String(chosen.model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "critic")],
    pinned: ["## Specification", options.spec, "## Feature list", options.features, "## Chosen idea", options.dossier, "## Brief constraints and non-goals", options.brief].join("\n\n"),
    record: deps.record,
    role: "critic",
    phase: "form",
    turnCap: 2,
    usdCap: options.formationCeilingUsd,
    spentUsd: options.spentUsd,
    effort: effortFor(deps.cfg, "critic", chosen.model),
    streamFn: deps.streamFn,
    terminalTools: ["critique"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  let costUsd = 0;
  let lastResult: BrainResult | undefined;
  let recorded = false;
  const record = (value: Critique, result: BrainResult) => {
    if (recorded) return;
    recorded = true;
    deps.record.append({
      t: "critique", ...value, provider: String(chosen.model.provider), model: chosen.ref,
      stopped: result.stopped, usdCapHit: result.stopped === "usd_cap" || options.spentUsd() >= options.formationCeilingUsd,
    });
  };
  for (let attempt = 0; attempt < 2 && !captured; attempt += 1) {
    const result = await brain.run(attempt === 0 ? "Review the four pinned artifacts and call critique." : `${problem}. Call critique now with a valid structured verdict.`);
    lastResult = result;
    costUsd += result.costUsd;
    options.onResult(result);
    if (captured) break;
    if (result.stopped === "refused") {
      const category = result.stopDetails?.category?.trim() || "unknown";
      const value: Critique = { verdict: "revise", scopeCreep: [], unverifiable: [], missing: [{ text: `degenerate critique: refused:${category}` }], crossProvider: chosen.crossProvider, costUsd };
      record(value, result);
      return value;
    }
    if (stopped(result)) {
      const value: Critique = { verdict: "revise", scopeCreep: [], unverifiable: [], missing: [{ text: `critic stopped: ${result.error ?? result.stopped}` }], crossProvider: chosen.crossProvider, costUsd };
      record(value, result);
      throw new CritiqueRunError(result.error ?? `critic stopped: ${result.stopped}`, result);
    }
    if (options.spentUsd() >= options.formationCeilingUsd) {
      const capped = { ...result, stopped: "usd_cap" as const };
      const value: Critique = { verdict: "revise", scopeCreep: [], unverifiable: [], missing: [{ text: "critic exhausted the formation dollar ceiling" }], crossProvider: chosen.crossProvider, costUsd };
      record(value, capped);
      throw new CritiqueRunError("critic exhausted the formation dollar ceiling", capped);
    }
  }
  const value: Critique = captured
    ? { ...captured, crossProvider: chosen.crossProvider, costUsd }
    : { verdict: "revise", scopeCreep: [], unverifiable: [], missing: [{ text: `degenerate critique: ${problem}` }], crossProvider: chosen.crossProvider, costUsd };
  record(value, lastResult ?? { text: "", turns: 0, costUsd: 0, stopped: "error", error: "critic produced no result" });
  return value;
}

/** Only independently reproducible unverifiability claims bind the revision. */
export function bindingItems(critique: Pick<Critique, "unverifiable">, file: FeaturesFile): string[] {
  const byId = new Map(file.features.map((feature) => [feature.id, feature]));
  return critique.unverifiable.flatMap((item) => {
    if (!item.featureId) return [];
    const feature = byId.get(item.featureId);
    if (!feature) return [];
    if (feature.acceptance.type === "manual") return [item.text];
    if (feature.acceptance.type === "shell" && feature.acceptance.expect === undefined && isTrivialCommand(feature.acceptance.command)) return [item.text];
    return [];
  });
}
