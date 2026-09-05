import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { runProcess } from "../../core/process";
import { redactEnv } from "../../core/secrets";
import { fail, ok, shapeResult } from "./shape";
import type { ToolContext } from "./index";

const DEFAULT_TIMEOUT_MS = 120_000;
/** No model-chosen command may hold the phase open longer than this, whatever it asks for. */
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;

/** Clamps a model-supplied `timeoutSeconds` into the range the harness is willing to wait. */
export function clampTimeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(seconds * 1000)));
}

export function bashTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "bash",
    label: "Bash",
    intent: "omit",
    description: "Run a shell command in the working directory and return its exit code, stdout, and stderr. Commands are killed at the deadline.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeoutSeconds: { type: "number" } },
      required: ["command"],
    },
    examples: [{ caption: "Run the tests", call: { command: "bun test", timeoutSeconds: 120 } }],
    async execute(_id, p: { command: string; timeoutSeconds?: number }, signal?: AbortSignal) {
      const timeoutMs = p.timeoutSeconds !== undefined ? clampTimeoutMs(p.timeoutSeconds) : ctx.bashTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      let r;
      try {
        // The child gets an environment with every credential-named variable stripped, as its
        // whole environment (not an overlay), so `env` or a leaky subprocess cannot echo a key.
        r = await runProcess({ cmd: "sh", args: ["-c", p.command], cwd: ctx.cwd, timeoutMs, env: redactEnv(), envReplace: true, signal });
      } catch (e) {
        return fail(`cannot run command: ${(e as Error).message}`);
      }
      const body = `exit ${r.exitCode ?? "null"}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
      const text = r.cancelled
        ? `cancelled: command stopped\n${body}`
        : r.timedOut
          ? `deadline: killed after ${timeoutMs / 1000}s\n${body}`
          : body;
      return ok(shapeResult(ctx, "bash", text));
    },
  };
}
