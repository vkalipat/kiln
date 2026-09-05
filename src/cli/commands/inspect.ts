import { ROLES, loadConfig, saveConfig, type Effort } from "../../core/config";
import { initHome } from "../../core/home";
import { kilnHome } from "../../core/paths";
import { RunRecord } from "../../core/record";
import { runExists, runPaths } from "../../core/run";
import type { CliIo } from "../main";
import { printJson, table } from "../output";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

/** Disk-only inspection and explicit operator effort changes; no provider is resolved. */
export function inspectCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo): number {
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  initHome(home);
  const err = io.error ?? io.write;
  if (cmd[0] === "run" && cmd[1] === "record") {
    const id = cmd[2];
    if (!id || !runExists(home, id)) { err(`unknown run ${id ?? ""}\n`); return 2; }
    const record = new RunRecord(runPaths(home, id).record);
    const events = record.read();
    if (flags.json) printJson(io, events);
    else for (const event of events) io.write(`${JSON.stringify(event)}\n`);
    return 0;
  }
  const cfg = loadConfig(home);
  if (cmd[0] === "model" && cmd[1] === "roles") {
    const roles = ROLES.map((role) => ({ role, refs: cfg.roles[role], effort: cfg.effortByRole?.[role] ?? cfg.effort }));
    if (flags.json) printJson(io, roles);
    else table(io, [["role", "effort", "configured models"], ...roles.map((row) => [row.role, row.effort, row.refs.join(", ")])]);
    return 0;
  }
  if (cmd[0] === "mode" && ["show", "set", "toggle"].includes(cmd[1] ?? "show")) {
    const action = cmd[1] ?? "show";
    const requested = cmd[2] === "ultra" ? "xhigh" : cmd[2];
    if (action === "set" && !EFFORTS.includes(requested as Effort)) {
      err("usage: kiln mode set low|medium|high|xhigh\n"); return 2;
    }
    if (action !== "show") {
      cfg.effort = action === "toggle" ? EFFORTS[(EFFORTS.indexOf(cfg.effort) + 1) % EFFORTS.length]! : requested as Effort;
      // An explicit operator mode applies to every seat; automatic sweeps remain a separate action.
      cfg.effortByRole = Object.fromEntries(ROLES.map((role) => [role, cfg.effort]));
      saveConfig(home, cfg);
    }
    if (flags.json) printJson(io, { effort: cfg.effort, effortByRole: cfg.effortByRole });
    else io.write(`effort: ${cfg.effort}\n`);
    return 0;
  }
  err("usage: kiln model roles | kiln mode show|set|toggle | kiln run record <id>\n");
  return 2;
}
