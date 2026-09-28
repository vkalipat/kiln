import { kilnHome } from "../../core/paths";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliDeps, CliIo } from "../main";
import type { TuiControllerPort } from "../../tui/contracts";

export async function createTuiController(home: string, deps: CliDeps, runId?: string, cwd = process.cwd()): Promise<TuiControllerPort & { dispose?: () => Promise<void> }> {
  if (runId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("invalid run id");
  if (runId && !existsSync(join(home, "runs", runId, "operator.json"))) {
    const { RunController } = await import("../../tui/controller");
    return new RunController({ home, cliDeps: deps });
  }
  const { OperatorController } = await import("../../tui/operator-controller");
  return new OperatorController({ home, cwd, cliDeps: deps });
}

export async function tuiCommand(flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  const runId = typeof flags.run === "string" ? flags.run : undefined;
  if (deps.launchTui) { await deps.launchTui({ home, runId }); return 0; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    (io.error ?? io.write)("kiln tui requires an interactive terminal; use kiln run or kiln project for scripts\n");
    return 2;
  }
  const [{ startTui }, controller] = await Promise.all([import("../../tui/app"), createTuiController(home, deps, runId)]);
  const session = startTui(controller, { runId });
  try { await session.done; return 0; }
  catch (error) { (io.error ?? io.write)(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  finally { try { await session.stop(); } finally { await controller.dispose?.(); } }
}
