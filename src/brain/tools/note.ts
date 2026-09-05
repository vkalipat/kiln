import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { appendLine } from "../../core/paths";
import { fail, ok } from "./shape";
import type { ToolContext } from "./index";

export function noteTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "note",
    label: "Note",
    intent: "omit",
    description: "Append a timestamped line to the run notes. Use it to keep a decision or observation that later phases should see.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    examples: [{ caption: "Record a decision", call: { text: "ruled out the marketplace angle: no supply side" } }],
    async execute(_id, p: { text: string }) {
      try {
        appendLine(ctx.run.notes, `- ${new Date().toISOString()} ${p.text}`);
      } catch (e) {
        return fail(`cannot write notes: ${(e as Error).message}`);
      }
      return ok("noted");
    },
  };
}
