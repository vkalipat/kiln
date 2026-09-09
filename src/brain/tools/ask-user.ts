import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { RunCancelledError, throwIfRunCancelled } from "../../core/run-control";
import type { ToolContext } from "./index";
import { fail, ok, shapeResult } from "./shape";
import { readClarification, writeClarification } from "../clarification";

/** One decisive clarification, not a questionnaire or a replacement for safe working assumptions. */
export function askUserTool(ctx: ToolContext): AgentTool<any> {
  let asked = false;
  return {
    name: "ask_user", label: "Ask user", intent: "omit",
    description: "Ask one concise question only when a missing fact blocks progress and cannot safely be assumed. Prefer explicit reversible assumptions for broad goals. Never request credentials or sensitive personal records. If no operator is available, do not invent an answer.",
    parameters: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 800 } }, required: ["question"], additionalProperties: false },
    async execute(_id, params: { question?: string }, signal) {
      throwIfRunCancelled(signal);
      const question = params.question?.trim();
      if (!question || question.length > 800) return fail("question must be one non-empty question of at most 800 characters");
      const saved = readClarification(ctx.run);
      if (asked || (saved && (saved.answer !== undefined || saved.question !== question || !ctx.askUser))) return fail("A clarification has already been requested. Use the answer, state safe assumptions, or explain the specific remaining blocker. A reconnected operator may answer only the same saved unanswered question.");
      asked = true;
      writeClarification(ctx.run, question);
      if (!ctx.askUser) return ok("No interactive operator is available. No answer was supplied. Continue with safe, clearly labeled assumptions where possible; otherwise explain the precise blocker.");
      const answer = await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => reject(new RunCancelledError(signal?.reason));
        signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { throwIfRunCancelled(signal); return ctx.askUser!(question); }).then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
      throwIfRunCancelled(signal);
      if (!answer?.trim()) return ok("The operator supplied no answer. Do not infer one; use safe labeled assumptions or state the unresolved blocker.");
      writeClarification(ctx.run, question, answer);
      return ok(shapeResult(ctx, "ask-user", JSON.stringify({ answered: true, answer })));
    },
  };
}
