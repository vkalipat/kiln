import type { CliDeps, CliIo } from "./main";
import { askCli } from "./runtime";

/** Never open stdin in autonomous/JSON execution; UI and embedding questions share normal cancellation. */
export function clarificationFor(io: CliIo, deps: CliDeps, options: { interactive: boolean }): ((question: string) => Promise<string | undefined>) | undefined {
  if (!options.interactive || (!io.ask && !deps.stdin && !process.stdin.isTTY)) return undefined;
  return (question) => askCli(`${question}\n> `, io, deps);
}
