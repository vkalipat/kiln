import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import type { RunRecord } from "../core/record";
import type { PhaseDeps } from "../phases/frame";
import { effortFor } from "../providers/models";
import type { Axis } from "./dossier";
import type { DerivedIdea } from "./islands";

const PREFIX = "axis.mapping ";

export interface AxisMappingRecord {
  id: string;
  axis: string;
  from: string;
  to: string;
  source: "case" | "arbiter" | "cap_fallback" | "invalid_fallback";
  costUsd: number;
}

function key(id: string, axis: string, from: string): string {
  return `${id}\0${axis}\0${from}`;
}

/** Durable mappings from prior attempts. The journal makes an OOV decision resume-idempotent. */
export function recordedAxisMappings(record: RunRecord): Map<string, AxisMappingRecord> {
  const out = new Map<string, AxisMappingRecord>();
  for (const event of record.read()) {
    if (event.t !== "note" || !event.text.startsWith(PREFIX)) continue;
    try {
      const mapping = JSON.parse(event.text.slice(PREFIX.length)) as AxisMappingRecord;
      if (mapping.id && mapping.axis && mapping.from && mapping.to) out.set(key(mapping.id, mapping.axis, mapping.from), mapping);
    } catch {
      // A malformed human note with the same prefix is not an authoritative mapping.
    }
  }
  return out;
}

function recordMapping(record: RunRecord, mapping: AxisMappingRecord): void {
  record.append({ t: "note", text: `${PREFIX}${JSON.stringify(mapping)}` });
}

export function axisMapSchema(allowed: readonly string[]) {
  return {
    type: "object",
    properties: { value: { type: "string", enum: allowed }, reason: { type: "string" } },
    required: ["value", "reason"],
    additionalProperties: false,
  } as const;
}

async function arbitrateAxis(deps: PhaseDeps, idea: DerivedIdea, unknown: DerivedIdea["unknown"][number]): Promise<{ value?: string; costUsd: number }> {
  const { model } = deps.models("arbiter");
  let value: string | undefined;
  const tool: AgentTool<any> = {
    name: "axis_map",
    label: "Axis map",
    intent: "omit",
    description: "Map the idea's out-of-vocabulary axis value to exactly one allowed value.",
    parameters: axisMapSchema(unknown.allowed),
    examples: [{ caption: "Map to the closest allowed value", call: { value: unknown.allowed[0] ?? "", reason: "Closest mechanism." } }],
    async execute(_id, params: { value?: string }) {
      const hit = unknown.allowed.find((allowed) => allowed.toLowerCase() === String(params.value ?? "").trim().toLowerCase());
      if (!hit) return { content: [{ type: "text" as const, text: "error: value must be one of the allowed values" }], isError: true };
      value = hit;
      return { content: [{ type: "text" as const, text: "axis mapping recorded" }] };
    },
  };
  const brain = createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "arbiter")],
    pinned: `Closed-vocabulary mapping for ${idea.dossier.id}.`,
    record: deps.record,
    role: "arbiter",
    phase: "ideate",
    turnCap: 1,
    effort: effortFor(deps.cfg, "arbiter", model),
    streamFn: deps.streamFn,
    terminalTools: ["axis_map"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const result = await brain.run([
    `Idea title: ${idea.dossier.title}`,
    `Axis: ${unknown.axis}`,
    `The island wrote: ${unknown.value}`,
    `Allowed values: ${unknown.allowed.join(" | ")}`,
    "Call axis_map once.",
  ].join("\n"));
  return { value, costUsd: result.costUsd };
}

export interface ApplyAxisResult { arbiterCalls: number; costUsd: number }

/** Apply case mappings and one-call OOV mappings before archive insertion. */
export async function applyAxisMappings(
  deps: PhaseDeps,
  ideas: readonly DerivedIdea[],
  _axes: readonly Axis[],
  arbiterBudget: number,
): Promise<ApplyAxisResult> {
  const known = recordedAxisMappings(deps.record);
  let arbiterCalls = 0;
  let costUsd = 0;
  for (const idea of ideas) {
    for (const mapped of idea.mapped) {
      const k = key(idea.dossier.id, mapped.axis, mapped.from);
      if (known.has(k)) continue;
      const record = { id: idea.dossier.id, axis: mapped.axis, from: mapped.from, to: mapped.to, source: "case" as const, costUsd: 0 };
      recordMapping(deps.record, record);
      known.set(k, record);
    }
    for (const unknown of idea.unknown) {
      const k = key(idea.dossier.id, unknown.axis, unknown.value);
      const held = known.get(k);
      if (held) {
        idea.dossier.axisValues[unknown.axis] = held.to;
        continue;
      }
      let to = unknown.allowed[0];
      let source: AxisMappingRecord["source"] = "cap_fallback";
      let spent = 0;
      if (arbiterCalls < arbiterBudget) {
        arbiterCalls += 1;
        const verdict = await arbitrateAxis(deps, idea, unknown);
        spent = verdict.costUsd;
        costUsd += spent;
        if (verdict.value) {
          to = verdict.value;
          source = "arbiter";
        } else {
          source = "invalid_fallback";
        }
      }
      if (!to) continue;
      idea.dossier.axisValues[unknown.axis] = to;
      const record = { id: idea.dossier.id, axis: unknown.axis, from: unknown.value, to, source, costUsd: spent };
      recordMapping(deps.record, record);
      known.set(k, record);
    }
  }
  return { arbiterCalls, costUsd };
}
