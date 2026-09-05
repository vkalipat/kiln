import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import { fail, ok } from "../brain/tools/shape";
import type { IdeaShape, KilnConfig, Role } from "../core/config";
import type { RunRecord } from "../core/record";
import { clampEffort, NoModelError, otherProvider, parseModelRef, resolveRoleOn } from "../providers/models";

/** One normalized item shown to either calibration labeller. */
export interface LabellerItem {
  id: string;
  render: string;
}

export interface LabellerGroup {
  id: string;
  shape: IdeaShape;
  items: readonly LabellerItem[];
}

export interface LabellerDeps {
  home: string;
  runId?: string;
  cfg: KilnConfig;
  record: RunRecord;
  models: (role: Role) => { model: Model; ref: string };
  availableProviders: ReadonlySet<string>;
  modelsOn?: (role: Role, provider: string, excludeRef?: string) => { model: Model; ref: string };
  apiKeyFor: (provider: string) => Promise<string | undefined>;
  streamFn?: StreamFn;
  /** Direct seam for fixture labellers; production resolves the independent seat below. */
  seat?: { model: Model; ref: string; crossProvider: boolean };
}

export interface LabellerResult {
  best?: string;
  worst?: string;
  refused: boolean;
  costUsd: number;
  model: string;
  crossProvider: boolean;
  effort?: string;
  stopped: string;
}

function customConfig(cfg: KilnConfig): KilnConfig {
  return cfg.evals.labeller?.length
    ? { ...cfg, roles: { ...cfg.roles, judge: [...cfg.evals.labeller] } }
    : cfg;
}

/** Resolve away from the evaluated judge, degrading only to a different same-provider tier. */
export function resolveLabeller(deps: LabellerDeps): { model: Model; ref: string; crossProvider: boolean } {
  if (deps.seat) return deps.seat;
  const judge = deps.models("judge");
  const provider = parseModelRef(judge.ref).provider;
  const available = new Set(deps.availableProviders);
  const alternate = otherProvider(provider, available);
  const errors: string[] = [];
  const resolve = (wanted: string, exclude?: string) => {
    if (deps.cfg.evals.labeller?.length) return resolveRoleOn("judge", wanted, customConfig(deps.cfg), available, exclude);
    if (!deps.modelsOn) throw new NoModelError("labeller requires a provider-restricted model resolver");
    return deps.modelsOn("judge", wanted, exclude);
  };
  if (alternate && alternate !== provider) {
    try { return { ...resolve(alternate), crossProvider: true }; }
    catch (error) { errors.push((error as Error).message); }
  }
  try {
    const seat = resolve(provider, judge.ref);
    if (seat.ref === judge.ref) throw new NoModelError(`resolver returned evaluated judge ${judge.ref}`);
    return { ...seat, crossProvider: false };
  } catch (error) {
    errors.push((error as Error).message);
  }
  throw new NoModelError(`no independent calibration labeller for ${judge.ref}: ${errors.join("; ")}`);
}

/** The exact shape-specific Value block, without importing the judge as a second labeller prompt. */
export function valueBlock(home: string, shape: IdeaShape): string {
  const prompt = loadPrompt(home, "judge");
  const section = prompt.split(/^## Value\s*$/m)[1] ?? "";
  const blocks = section.split(/^### /m).slice(1);
  const block = blocks.find((candidate) => candidate.split("\n")[0]?.trim().toLowerCase() === shape);
  if (!block) throw new Error(`judge prompt has no Value block for ${shape}`);
  return `## Value\n\n### ${block.trimEnd()}\n`;
}

function assertGroup(group: LabellerGroup): void {
  if (group.items.length !== 4) throw new Error(`calibration group ${group.id} must contain exactly four ideas`);
  const ids = group.items.map((item) => item.id);
  if (new Set(ids).size !== 4 || ids.some((id) => id.trim() === "")) {
    throw new Error(`calibration group ${group.id} must contain four distinct non-empty ids`);
  }
}

/** Agent M0 anchor: one stateless call and one strict-compatible terminal decision tool. */
export async function labelBestWorst(deps: LabellerDeps, group: LabellerGroup): Promise<LabellerResult> {
  assertGroup(group);
  const chosen = resolveLabeller(deps);
  const ids = new Set(group.items.map((item) => item.id));
  let captured: { best: string; worst: string } | undefined;
  const bws: AgentTool<any> = {
    name: "bws",
    label: "Best-worst",
    intent: "omit",
    description: "Choose the most valuable and least valuable idea in this four-item group.",
    parameters: {
      type: "object",
      properties: { best: { type: "string" }, worst: { type: "string" } },
      required: ["best", "worst"],
      additionalProperties: false,
    },
    examples: [{ caption: "Choose different group members", call: { best: group.items[0]!.id, worst: group.items[3]!.id } }],
    async execute(_id, raw: { best?: string; worst?: string }) {
      const best = String(raw.best ?? "").trim();
      const worst = String(raw.worst ?? "").trim();
      if (!ids.has(best) || !ids.has(worst) || best === worst) {
        return fail("best and worst must be different ids from the supplied group");
      }
      captured = { best, worst };
      return ok("best-worst decision recorded");
    },
  };
  const rubric = readFileSync(join(deps.home, "evals", "judge-rubric.md"), "utf8");
  const effort = clampEffort(chosen.model, "high");
  const brain = createBrain({
    model: chosen.model,
    getApiKey: () => deps.apiKeyFor(String(chosen.model.provider)),
    tools: [bws],
    systemPrompt: [loadPrompt(deps.home, "kernel")],
    pinned: `${rubric.trim()}\n\n${valueBlock(deps.home, group.shape).trim()}`,
    record: deps.record,
    role: "judge",
    phase: "ideate",
    turnCap: 1,
    effort,
    streamFn: deps.streamFn,
    terminalTools: ["bws"],
    shaping: { cfg: deps.cfg, runId: deps.runId ?? group.id },
  });
  const prompt = [
    `Calibration group ${group.id}. Judge value only and call bws once.`,
    ...group.items.flatMap((item) => ["", `## ${item.id}`, item.render.trim()]),
  ].join("\n");
  const result = await brain.run(prompt);
  const decision = captured as { best: string; worst: string } | undefined;
  return {
    ...(decision ? { best: decision.best, worst: decision.worst } : {}),
    refused: decision === undefined || result.stopped === "error" || result.stopped === "refused",
    costUsd: result.costUsd,
    model: chosen.ref,
    crossProvider: chosen.crossProvider,
    effort,
    stopped: result.stopped,
  };
}
