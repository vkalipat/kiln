import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiffTool, gitLogTool } from "../../src/brain/tools/git";
import type { ToolContext } from "../../src/brain/tools";
import type { ProcessOptions, ProcessResult } from "../../src/core/process";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { FakeGitRunner } from "../build/fake-git";

const processResult = (patch: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, signal: null, stdout: "abc subject\n", stderr: "", timedOut: false,
  durationMs: 1, overrunMs: 0, truncated: false, ...patch,
});

function context(): ToolContext {
  const home = mkdtempSync(join(tmpdir(), "kiln-git-tools-"));
  const run = createRun(home, "seed");
  const cwd = join(home, "detached snapshot; $(safe)");
  return { cwd, roots: [cwd], run, record: new RunRecord(run.record) };
}

async function call(tool: ReturnType<typeof gitLogTool> | ReturnType<typeof gitDiffTool>, args: Record<string, unknown>) {
  const result = await tool.execute("id", args as never);
  return { text: (result.content[0] as { text: string }).text, isError: result.isError === true };
}

describe("auditor git tools", () => {
  test("git_log uses a fixed argument array and defaults to twenty decorated commits", async () => {
    const ctx = context(); const calls: ProcessOptions[] = [];
    const tool = gitLogTool(ctx, async (options) => { calls.push(options); return processResult(); });
    expect((await call(tool, {})).text).toContain("abc subject");
    expect(calls).toEqual([{ cmd: "git", args: ["log", "-n", "20", "--oneline", "--decorate"], cwd: ctx.cwd, timeoutMs: 60_000, shell: false }]);
    await call(tool, { n: 500 });
    expect(calls[1]?.args).toEqual(["log", "-n", "100", "--oneline", "--decorate"]);
  });

  test("git_log returns a structured tool error without retrying through a shell", async () => {
    const tool = gitLogTool(context(), async () => processResult({ exitCode: 2, stderr: "bad ref" }));
    const result = await call(tool, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("git log -n 20 --oneline --decorate exited 2: bad ref");
  });

  test("git_diff keeps a metacharacter path opaque, emits stat first, and abridges each large file", async () => {
    const ctx = context(); const git = new FakeGitRunner();
    const path = "name; touch PWNED $(still-safe).ts";
    const blocks = ["a.ts", "b.ts", "middle.ts", "d.ts", "e.ts"].map((name) => [
      `diff --git a/${name} b/${name}`, ...Array.from({ length: 90 }, (_, index) => `+line ${name} ${index}`), "",
    ].join("\n")).join("");
    git.diff = async (dir, options = {}) => {
      git.calls.push({ method: "diff", dir, options });
      return options.stat ? "2 files changed" : blocks;
    };
    const result = await call(gitDiffTool(ctx, git), { ref: "HEAD^", path });
    expect(result.isError).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(16_000);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(80);
    expect(result.text.indexOf("--stat")).toBeLessThan(result.text.indexOf("--patch"));
    expect(result.text).toContain("bounded per-file head/tail");
    for (const name of ["a.ts", "b.ts", "middle.ts", "d.ts", "e.ts"]) expect(result.text).toContain(`b/${name}`);
    const spill = result.text.match(/full output: (.+)]/)?.[1];
    expect(spill).toBeDefined();
    expect(readFileSync(spill!, "utf8")).toContain(blocks);
    expect(git.calls).toEqual([
      { method: "diff", dir: ctx.cwd, options: { ref: "HEAD^", path, stat: true } },
      { method: "diff", dir: ctx.cwd, options: { ref: "HEAD^", path } },
    ]);
  });
});
