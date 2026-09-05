import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fail, ok, shapeResult } from "./shape";
import type { ToolContext } from "./index";

const DEFAULT_LIMIT = 400;
const BINARY_PROBE_BYTES = 8 * 1024;

export function readTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "read",
    label: "Read",
    intent: "omit",
    description: "Read a text file with 1-based line numbers. Use offset and limit for large files.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      required: ["path"],
    },
    examples: [{ caption: "Read the first 100 lines", call: { path: "src/index.ts", limit: 100 } }],
    async execute(_id, p: { path: string; offset?: number; limit?: number }) {
      const abs = resolve(ctx.cwd, p.path);
      try {
        const bytes = readFileSync(abs);
        if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return fail("binary file");
        const lines = bytes.toString("utf8").split("\n");
        // A trailing newline is a terminator, not an empty final line.
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const start = Math.max(0, (p.offset ?? 1) - 1);
        const end = Math.min(lines.length, start + (p.limit ?? DEFAULT_LIMIT));
        if (start >= lines.length) return ok(`(${abs} has ${lines.length} lines; offset ${p.offset} is past the end)`);
        const body = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
        return ok(shapeResult(ctx, "read", body));
      } catch (e) {
        return fail(`cannot read ${abs}: ${(e as Error).message}`);
      }
    },
  };
}
