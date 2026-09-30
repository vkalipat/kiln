import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliDeps, CliIo } from "../main";
import { askCli } from "../runtime";
import { kilnHome } from "../../core/paths";
import { runPaths, readStatus } from "../../core/run";
import { currentRunControl, RunControl } from "../../core/run-control";
import { localIntakeReply } from "../../tui/intake";
import type { OperatorRuntime, OperatorEvent } from "../../operator/runtime";
import { loadConfig, saveConfig } from "../../core/config";
import { readComputeMonitor } from "../../operator/compute-monitor";

/** Scriptable entry to the same persistent operator used by the Amp-style TUI. */
export async function taskCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const fail = io.error ?? io.write;
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  const validId = (value: string | undefined) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  if (cmd[0] === "monitor") {
    if (!validId(cmd[1]) || cmd.length !== 2) { fail("usage: kiln task monitor RUN_ID [--json]\n"); return 2; }
    try {
      const run = runPaths(home, cmd[1]!);
      const snapshot = readComputeMonitor({ runId: run.id, dir: run.dir });
      if (!snapshot) { fail("This run has no compute-monitor receipt yet.\n"); return 2; }
      io.write(JSON.stringify(snapshot, null, 2) + "\n"); return 0;
    } catch (error) { fail(`Cannot read compute monitor: ${(error as Error).message}\n`); return 2; }
  }
  const numeric = (name: string): number | null | undefined => flags[name] === undefined ? undefined
    : flags[name] === "unlimited" ? null : typeof flags[name] === "string" ? Number(flags[name]) : NaN;
  let budgetUsd = numeric("budget"), wallSeconds = numeric("wall-seconds");
  if (flags.uncapped !== undefined) {
    if (flags.uncapped !== true || budgetUsd !== undefined || wallSeconds !== undefined) {
      fail("Use --uncapped alone, or specify --budget / --wall-seconds separately.\n"); return 2;
    }
    budgetUsd = null; wallSeconds = null;
  }
  if ([budgetUsd, wallSeconds].some(value => value !== undefined && value !== null && (!Number.isFinite(value) || value <= 0))) {
    fail("Budget and wall seconds must be positive numbers or unlimited.\n"); return 2;
  }
  if (cmd[0] === "limits") {
    if (cmd.length !== 1) { fail("usage: kiln task limits [--uncapped | --budget USD|unlimited --wall-seconds N|unlimited]\n"); return 2; }
    try {
      const cfg = loadConfig(home);
      if (budgetUsd !== undefined || wallSeconds !== undefined) {
        cfg.operator = { ...cfg.operator, ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(wallSeconds !== undefined ? { wallSeconds } : {}) };
        saveConfig(home, cfg);
      }
      io.write(JSON.stringify({ budgetUsd: cfg.operator?.budgetUsd !== undefined ? cfg.operator.budgetUsd : cfg.budgets.usd,
        wallSeconds: cfg.operator?.wallSeconds !== undefined ? cfg.operator.wallSeconds : cfg.budgets.wallSeconds,
        appliesTo: "new native operator sessions", nullMeans: "uncapped", computeMonitor: "enabled" }, null, 2) + "\n");
      return 0;
    } catch (error) { fail(`Cannot configure operator limits: ${(error as Error).message}\n`); return 2; }
  }
  const resume = cmd[0] === "resume" ? cmd[1] : undefined;
  if (cmd[0] === "resume" && !resume) { fail("usage: kiln task resume RUN_ID [message]\n"); return 2; }
  if (flags.through !== undefined || flags.bare !== undefined) { fail("task uses the adaptive operator; use kiln run new for the explicit legacy phase pipeline\n"); return 2; }
  const textArgs = resume ? cmd.slice(2) : cmd[0] === "new" ? cmd.slice(1) : cmd;
  let text = textArgs.join(" ");
  if (typeof flags["seed-file"] === "string") {
    if (text) { fail("Provide task text or --seed-file, not both\n"); return 2; }
    try { text = readFileSync(resolve(flags["seed-file"]), "utf8"); }
    catch (error) { fail(`Cannot read task: ${(error as Error).message}\n`); return 2; }
  }
  if (resume && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(resume)) { fail("Invalid run id\n"); return 2; }
  if (!resume && !text.trim()) { fail("usage: kiln task \"your task\" [--cwd DIR] [--uncapped | --budget USD|unlimited --wall-seconds N|unlimited]\n"); return 2; }
  if (!resume) {
    const local = localIntakeReply(text);
    if (local) { io.write(flags.json ? JSON.stringify({ local: true, text: local }) + "\n" : local); return 0; }
  }
  let cwd = typeof flags.cwd === "string" ? resolve(flags.cwd) : process.cwd();
  if (resume) {
    const path = join(runPaths(home, resume).dir, "operator.json");
    if (!existsSync(path)) { fail("This is not an operator session; use kiln run resume for a legacy workflow\n"); return 2; }
    if (flags.cwd === undefined) cwd = JSON.parse(readFileSync(path, "utf8")).cwd;
    if (!text.trim()) { io.write(JSON.stringify({ runId: resume, status: readStatus(runPaths(home, resume)), message: "Session retained. Open kiln --run RUN_ID or supply a follow-up message to continue." }, null, 2) + "\n"); return 0; }
  }
  let runtime: OperatorRuntime | undefined;
  const control = currentRunControl() ?? new RunControl();
  const interrupt = () => control.cancel("operator interrupted");
  const onEvent = (event: OperatorEvent) => {
    if (event.type === "run") deps.onRun?.(event.run);
    if (flags.json) return;
    if (event.type === "run") io.write(`run ${event.run.id}\n`);
    else if (event.type === "text") io.write(event.text);
    else if (event.type === "tool_start") io.write(`\n▸ ${event.name}\n`);
    else if (event.type === "tool_end") io.write(`${event.ok ? "✓" : "✗"} ${event.name}\n`);
    else if (event.type === "compute_notice") io.write(`\nCompute monitor (${event.notice.severity}): ${event.notice.message}\n`);
  };
  try {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const factory = deps.createOperatorRuntime ?? (await import("../../operator/runtime")).createOperatorRuntime;
    runtime = await factory({ home, cwd, seed: resume ? undefined : text, runId: resume,
      id: !resume && typeof flags.id === "string" ? flags.id : undefined, budgetUsd, wallSeconds, onEvent, signal: control.signal,
      ask: io.ask || deps.stdin || process.stdin.isTTY ? question => askCli(question, io, deps) : undefined });
    const result = await runtime.prompt(text);
    if (flags.json) io.write(JSON.stringify({ ...result, dir: result.run.dir, runId: result.run.id }, null, 2) + "\n");
    else io.write(`\nrun ${result.run.id}: ${result.stopped}; $${result.costUsd.toFixed(2)} recorded estimate\n`);
    return result.stopped === "completed" ? 0 : 1;
  } catch (error) { fail(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  finally {
    try { await runtime?.dispose(); }
    finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  }
}
