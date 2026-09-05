import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fail, ok } from "./shape";
import type { ToolContext } from "./index";

const MAX_FINDING_CHARS = 6000;

export function scoutTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "scout",
    label: "Scout",
    intent: "omit",
    description: "Send one question to a fresh scout agent that researches it and reports back. Use it for a self-contained question you do not want to research inline.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    examples: [{ caption: "Delegate a landscape question", call: { question: "Who already sells run journaling to solo founders, and what do they charge?" } }],
    async execute(_id, p: { question: string }) {
      if (!ctx.spawnScout) return fail("scouts are not available in this context");
      try {
        return ok((await ctx.spawnScout(p.question)).slice(0, MAX_FINDING_CHARS));
      } catch (e) {
        return fail(`scout failed: ${(e as Error).message}`);
      }
    },
  };
}
