import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fail, ok } from "./shape";
import { refuseIfNotWritable } from "./write";
import type { ToolContext } from "./index";

export function editTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "edit",
    label: "Edit",
    intent: "omit",
    description: "Replace an exact string in a file. The old text must appear exactly once unless all is true. Only paths under the run or project are allowed.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } },
      required: ["path", "old", "new"],
    },
    examples: [{ caption: "Rename one call site", call: { path: "src/index.ts", old: "oldName(", new: "newName(" } }],
    async execute(_id, p: { path: string; old: string; new: string; all?: boolean }) {
      const refused = refuseIfNotWritable(ctx, "edit", p.path);
      if (refused) return refused;
      const abs = resolve(ctx.cwd, p.path);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch (e) {
        return fail(`cannot read ${abs}: ${(e as Error).message}`);
      }
      if (p.old.length === 0) return fail(`old text is empty for ${abs}`);
      const parts = content.split(p.old);
      const count = parts.length - 1;
      if (count === 0) return fail(`0 matches for old text in ${abs}`);
      if (count > 1 && p.all !== true) return fail(`${count} matches; pass all:true or make old unique`);
      // Literal splice — never `String.replace`, whose $-patterns would rewrite `new`.
      const next = p.all === true ? parts.join(p.new) : `${parts[0]}${p.new}${parts.slice(1).join(p.old)}`;
      try {
        writeFileSync(abs, next);
      } catch (e) {
        return fail(`cannot write ${abs}: ${(e as Error).message}`);
      }
      return ok(`edited ${abs}: ${p.all === true ? count : 1} replacement(s)`);
    },
  };
}
