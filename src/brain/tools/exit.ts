import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fail, ok } from "./shape";
import { EXIT_KINDS, type ExitKind, type ToolContext } from "./index";

export function exitTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "exit",
    label: "Exit",
    intent: "omit",
    description: `Stop the run honestly instead of inventing work. Kinds: ${EXIT_KINDS.join(", ")}. Give the concrete reasons that led here.`,
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: EXIT_KINDS }, reasons: { type: "array", items: { type: "string" } } },
      required: ["kind", "reasons"],
    },
    examples: [{ caption: "The seed is too thin to shape", call: { kind: "underspecified", reasons: ["no user named", "no outcome named"] } }],
    async execute(_id, p: { kind: string; reasons?: string[] }) {
      if (!EXIT_KINDS.includes(p.kind as ExitKind)) return fail(`unknown exit kind ${p.kind}; expected one of ${EXIT_KINDS.join(", ")}`);
      if (ctx.allowedExitKinds && !ctx.allowedExitKinds.includes(p.kind as ExitKind)) {
        const message = `exit kind ${p.kind} is not allowed in this phase; expected one of ${ctx.allowedExitKinds.join(", ") || "none"}`;
        ctx.record.append({ t: "failure", class: "policy", message });
        return fail(`policy: ${message}`);
      }
      const reasons = p.reasons ?? [];
      ctx.record.append({ t: "honest_exit", kind: p.kind, reasons, source: "declared" });
      ctx.onExit?.(p.kind as ExitKind, reasons);
      return ok(`exit recorded: ${p.kind}`);
    },
  };
}
