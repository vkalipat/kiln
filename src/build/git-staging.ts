import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ProcessResult } from "../core/process";

function entry(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** An already-staged deletion no longer matches git add, but must remain in commit --only. */
export async function stagePathspecs(dir: string, paths: readonly string[] | undefined, command: (args: string[]) => Promise<ProcessResult>): Promise<string[]> {
  if (paths === undefined) return ["."];
  const unique = [...new Set(paths)];
  const indexed = (await command(["ls-files", "-z", "--", ...unique.map((path) => `:(literal)${path}`)])).stdout.split("\0").filter(Boolean);
  return unique.filter((path) => entry(join(dir, path)) || indexed.some((file) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`))).map((path) => `:(literal)${path}`);
}
