import { join } from "node:path";
import { excerpt } from "../../core/record";
import { writeAtomic } from "../../core/paths";
import type { ToolContext } from "./index";

const MAX_LINES = 80;
const MAX_CHARS = 16_000;
const MAX_BASE64_RUN = 2_000;
const BASE64_LIKE_RUN = new RegExp(`[A-Za-z0-9+/_=-]{${MAX_BASE64_RUN + 1},}`);
let counter = 0;

function spill(ctx: ToolContext, name: string, text: string): string {
  counter += 1;
  const path = join(ctx.run.toolOutputDir, `${String(counter).padStart(4, "0")}-${name}.txt`);
  writeAtomic(path, text);
  return path;
}

/**
 * Keep tool results safe and small enough to live in the model's context.
 * Binary-looking output is spilled without an excerpt. Oversized text is
 * spilled whole and represented by its head 40 + tail 40 plus the spill path.
 */
export function shapeResult(ctx: ToolContext, name: string, text: string): string {
  if (text.includes("\0") || BASE64_LIKE_RUN.test(text)) {
    return `[binary or base64-like output omitted; full output: ${spill(ctx, name, text)}]`;
  }
  if (text.split("\n").length <= MAX_LINES && text.length <= MAX_CHARS) return text;
  const path = spill(ctx, name, text);
  return `${excerpt(text, 40, 40).text}\n[full output: ${path}]`;
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(text: string) {
  return { content: [{ type: "text" as const, text: `error: ${text}` }], isError: true };
}
