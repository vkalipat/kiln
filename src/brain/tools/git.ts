import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { join } from "node:path";
import type { GitRunner } from "../../build/git";
import { writeAtomic } from "../../core/paths";
import { runProcess, type ProcessOptions, type ProcessResult } from "../../core/process";
import { excerpt } from "../../core/record";
import { fail, ok, shapeResult } from "./shape";
import type { ToolContext } from "./index";

const GIT_TIMEOUT_MS = 60_000;
const SHAPE_LINES = 80;
const SHAPE_CHARS = 16_000;
let diffCounter = 0;

export type GitToolProcessRunner = (options: ProcessOptions) => Promise<ProcessResult>;

function failed(result: ProcessResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

function failure(args: readonly string[], result: ProcessResult): string {
  const reason = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "without a status"}`;
  const detail = (result.stderr || result.stdout).trim();
  return `git ${args.join(" ")} ${reason}${detail ? `: ${detail}` : ""}`;
}

/** Auditor-only, fixed-argument history lookup rooted at the detached snapshot. */
export function gitLogTool(ctx: ToolContext, run: GitToolProcessRunner = runProcess): AgentTool<any> {
  return {
    name: "git_log",
    label: "Git log",
    intent: "omit",
    description: "Show recent commits from the detached audit snapshot.",
    parameters: {
      type: "object",
      properties: { n: { type: "number", minimum: 1, maximum: 100 } },
    },
    async execute(_id, input: { n?: number }) {
      const n = Number.isFinite(input.n) ? Math.min(100, Math.max(1, Math.floor(input.n!))) : 20;
      const args = ["log", "-n", String(n), "--oneline", "--decorate"];
      const result = await run({ cmd: "git", args, cwd: ctx.cwd, timeoutMs: GIT_TIMEOUT_MS, shell: false });
      if (failed(result)) return fail(failure(args, result));
      return ok(shapeResult(ctx, "git_log", result.stdout || "(no commits)"));
    },
  };
}

function fits(text: string): boolean {
  return text.length <= SHAPE_CHARS && text.split("\n").length <= SHAPE_LINES;
}

function clipChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const notice = "\n... [characters omitted] ...\n";
  const half = Math.max(0, Math.floor((limit - notice.length) / 2));
  return `${text.slice(0, half)}${notice}${text.slice(-half)}`;
}

function blocks(text: string): string[] {
  const found = text.split(/(?=^diff --git )/m).filter(Boolean);
  return found.length > 0 ? found : [text];
}

function spilledPreview(ctx: ToolContext, stat: string, full: string): string {
  diffCounter += 1;
  const path = join(ctx.run.toolOutputDir, `${String(diffCounter).padStart(4, "0")}-git_diff.txt`);
  writeAtomic(path, [`--stat`, stat, "", "--patch", full].join("\n"));
  const files = blocks(full);
  const names = files.map((block, index) => block.split("\n", 1)[0] || `(unnamed diff ${index + 1})`);
  const statPreview = clipChars(excerpt(stat, 8, 8).text, 3_500);
  const fixed = [`--stat`, statPreview || "(no changes)", "", `--files (${files.length})`, names.map((name, index) => `${index + 1}: ${name}`).join(" | "), "", "--patch (bounded per-file head/tail)"].join("\n");
  const availableLines = Math.max(0, SHAPE_LINES - fixed.split("\n").length - 3);
  const availableChars = Math.max(0, SHAPE_CHARS - fixed.length - path.length - 64);
  const linesEach = Math.floor(availableLines / files.length);
  const charsEach = Math.floor(availableChars / files.length);
  const previews = linesEach >= 4 && charsEach >= 120
    ? files.map((block) => clipChars(excerpt(block, Math.floor((linesEach - 1) / 2), Math.ceil((linesEach - 1) / 2)).text, charsEach)).join("\n")
    : "(per-file excerpts omitted; use the complete output path)";
  return `${fixed}\n${previews}\n[diff abridged; full output: ${path}]`;
}

/** Snapshot-aware diff: the GitRunner owns attribute-neutral raw-tree comparison. */
export function gitDiffTool(ctx: ToolContext, git: Pick<GitRunner, "diff">): AgentTool<any> {
  return {
    name: "git_diff",
    label: "Git diff",
    intent: "omit",
    description: "Show a stat and patch from the detached audit snapshot. Use ref HEAD^ for the captured feature delta.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, path: { type: "string" } },
    },
    async execute(_id, input: { ref?: string; path?: string }) {
      try {
        const options = { ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.path === undefined ? {} : { path: input.path }) };
        const stat = await git.diff(ctx.cwd, { ...options, stat: true });
        const full = await git.diff(ctx.cwd, options);
        const complete = [`--stat`, stat.trim() || "(no changes)", "", "--patch", full.trim() || "(no changes)"].join("\n");
        if (fits(complete)) return ok(complete);
        return ok(spilledPreview(ctx, stat, full));
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  };
}
