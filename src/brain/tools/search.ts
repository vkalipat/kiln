import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fail, ok, shapeResult } from "./shape";
import type { ToolContext } from "./index";

const SKIP = ["node_modules/", ".git/", "dist/"];
const DEFAULT_MAX_RESULTS = 50;

export function searchTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "search",
    label: "Search",
    intent: "omit",
    description: "Search file contents with a regular expression and return matching lines as file:line: text. Skips node_modules, .git, dist, and binary files.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, glob: { type: "string" }, path: { type: "string" }, maxResults: { type: "number" } },
      required: ["pattern"],
    },
    examples: [{ caption: "Find a symbol in TypeScript sources", call: { pattern: "createRun\\(", glob: "**/*.ts" } }],
    async execute(_id, p: { pattern: string; glob?: string; path?: string; maxResults?: number }, signal?: AbortSignal) {
      let re: RegExp;
      try {
        re = new RegExp(p.pattern);
      } catch (e) {
        return fail(`invalid pattern ${p.pattern}: ${(e as Error).message}`);
      }
      const base = resolve(ctx.cwd, p.path ?? ctx.cwd);
      const max = p.maxResults ?? DEFAULT_MAX_RESULTS;
      const hits: string[] = [];
      // A wide glob over a big tree is the one tool that can scan for a long time after the phase
      // has been cancelled, so the loop checks the signal per file and reports a partial result.
      let cancelled = false;
      try {
        for (const rel of new Bun.Glob(p.glob ?? "**/*").scanSync({ cwd: base, onlyFiles: true, dot: false })) {
          if (signal?.aborted) { cancelled = true; break; }
          if (hits.length >= max) break;
          if (SKIP.some((s) => rel.includes(s))) continue;
          let content: string;
          try {
            content = readFileSync(join(base, rel), "utf8");
          } catch {
            continue;
          }
          if (content.includes("\0")) continue;
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && hits.length < max; i += 1) {
            if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]}`);
          }
        }
      } catch (e) {
        return fail(`cannot search ${base}: ${(e as Error).message}`);
      }
      const body = hits.length > 0 ? hits.join("\n") : "no matches";
      return ok(shapeResult(ctx, "search", cancelled ? `${body}\n[search cancelled after ${hits.length} results; the scan was incomplete]` : body));
    },
  };
}
