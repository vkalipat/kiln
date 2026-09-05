import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fail, ok } from "./shape";
import type { ToolContext } from "./index";

export const PROBE_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        properties: { ideaId: { type: "string" }, rationale: { type: "string" } },
        required: ["ideaId", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas"],
  additionalProperties: false,
} as const;

/**
 * The brain's only probe-facing tool (record §6): one turn nominates many ideas. The prober
 * worker writes each probe and the harness runs it; the brain never sees a result it did not get
 * from the evidence sidecar.
 */
export function probeRequestTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "probe_request",
    label: "Probe request",
    intent: "omit",
    description: "Nominate ideas whose cheapest test can run in under two minutes. A prober writes each probe; the harness runs it and records the result.",
    parameters: PROBE_REQUEST_SCHEMA,
    examples: [{ caption: "Two probe-able ideas", call: { ideas: [{ ideaId: "r1-i1-3", rationale: "the API is public; one fetch settles it" }, { ideaId: "r1-i2-7", rationale: "a 20-line script reproduces the core claim" }] } }],
    async execute(_id, p: { ideas: { ideaId: string; rationale: string }[] }) {
      const ideas = Array.isArray(p.ideas) ? p.ideas.filter((i) => i && typeof i.ideaId === "string" && i.ideaId.trim() !== "") : [];
      if (ideas.length === 0) return fail("probe_request needs at least one idea with an ideaId");
      if (ideas.length > 40) return fail("probe_request accepts at most 40 ideas per call");
      const cleaned = ideas.map((i) => ({ ideaId: i.ideaId.trim(), rationale: String(i.rationale ?? "").slice(0, 300) }));
      ctx.record.append({ t: "probe.request", round: ctx.round ?? 0, ideas: cleaned });
      ctx.onProbeRequest?.(cleaned);
      return ok(`requested ${cleaned.length} probe${cleaned.length === 1 ? "" : "s"}`);
    },
  };
}
