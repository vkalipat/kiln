import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
  let scratch: string | undefined;
  const temporaryDirectory = () => {
    const root = realpathSync(ctx.run.dir);
    const parent = join(root, ".shell-tmp");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) {
      throw new Error("shell temporary directory parent must not redirect outside the run");
    }
    scratch ??= mkdtempSync(join(parent, "session-"));
    if (lstatSync(scratch).isSymbolicLink() || realpathSync(scratch) !== scratch) {
      throw new Error("shell temporary directory must not be redirected");
    }
    return scratch;
  };
  return {
    name: "bash",
    label: "Bash",
    intent: "omit",
    description: "Run an unsandboxed shell; return exit code, stdout and stderr. Deadline kills commands. Restrict writes to the assigned workspace and run-owned $TMPDIR (also TMP/TEMP), retained across calls. Use mktemp -d \"$TMPDIR/probe.XXXXXX\" for unique scratch. Never pre-clean guessed global paths. Clean up only exact paths you created and own; never delete workspace roots or unknown contents.",
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
        const temp = temporaryDirectory();
        r = await runProcess({ cmd: "sh", args: ["-c", p.command], cwd: ctx.cwd, timeoutMs,
          env: { ...redactEnv(), TMPDIR: temp, TMP: temp, TEMP: temp }, envReplace: true, signal });
      } catch (e) {
        return fail(`cannot run command: ${(e as Error).message}`);
      }
      const body = `exit ${r.exitCode ?? "null"}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
      const text = r.cancelled
        ? `cancelled: command stopped\n${body}`
        : r.timedOut
          ? `deadline: killed after ${timeoutMs / 1000}s\n${body}`
          : body;
      const shaped = shapeResult(ctx, "bash", text);
      return { ...ok(shaped), details: { process: {
        exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, cancelled: r.cancelled === true,
        outputTruncated: r.truncated || shaped !== text,
      } } };
    },
  };
}
