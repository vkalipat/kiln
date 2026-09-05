import { kilnHome } from "../../core/paths";
import type { CliDeps, CliIo } from "../main";

export async function tuiCommand(flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  const runId = typeof flags.run === "string" ? flags.run : undefined;
  if (deps.launchTui) { await deps.launchTui({ home, runId }); return 0; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    (io.error ?? io.write)("kiln tui requires an interactive terminal; use kiln run or kiln project for scripts\n");
    return 2;
  }
  const [{ RunController }, { startTui }] = await Promise.all([import("../../tui/controller"), import("../../tui/app")]);
  const controller = new RunController({ home, cliDeps: deps });
  const session = startTui(controller, { runId });
  try { await session.done; return 0; }
  catch (error) { (io.error ?? io.write)(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  finally { await session.stop(); }
}
