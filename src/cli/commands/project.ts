import { existsSync, readFileSync } from "node:fs";
import { hashInput, RunRecord } from "../../core/record";
import { RunCancelledError, throwIfRunCancelled } from "../../core/run-control";
import { pauseCancelledRun } from "../controlled-command";
import { loadConfig } from "../../core/config";
import { initHome } from "../../core/home";
import { Limiter } from "../../core/limiter";
import { acquireRunLock, RunLockedError } from "../../core/lock";
import { kilnHome } from "../../core/paths";
import { readStatus, runExists, runPaths, writeStatus, type RunPaths } from "../../core/run";
import { renderAudit } from "../../build/audit-contract";
import { runBuild, runBuildSingleSession, type BuildDeps } from "../../phases/build";
import { lastChosenIdea, runForm } from "../../phases/form";
import { runReflect } from "../../phases/reflect";
import type { PhaseDeps, PhaseResult } from "../../phases/frame";
import { parseFeatures, type FeaturesFile } from "../../formation/features";
import { relock } from "../../formation/lock";
import { projectPaths } from "../../formation/paths";
import { NoModelError } from "../../providers/models";
import type { CliDeps, CliIo } from "../main";
import { buildProjectionRows } from "../build-projection";
import { latestAudits, projectSummary } from "../project-summary";
import { printJson, table } from "../output";
import { askCli, createCliRuntime } from "../runtime";

const USAGE = "usage: kiln project form <run> [--out DIR] [--force] | kiln project build <run> [--autonomous] [--reinit] [--single-session] [--yes] [--json] | kiln project status <run> [--json] | kiln project audit <run> [--json] | kiln project relock <run> --confirm\n";
const NO_MODEL_HINT = "hint: run `kiln auth login anthropic` or `kiln auth login openai`, or set ANTHROPIC_API_KEY / OPENAI_API_KEY\n";

function printSummary(io: CliIo, run: RunPaths, json: boolean, outcome?: PhaseResult): void {
  const summary = projectSummary(run);
  const value = outcome ? { ...summary, outcome } : summary;
  if (json) { printJson(io, value); return; }
  io.write(`project ${run.id}: ${summary.status.phase} ${summary.status.state} $${summary.costUsd.toFixed(2)}\n`);
  if (summary.projectDir) io.write(`directory: ${summary.projectDir}\n`);
  if (summary.features.length > 0) table(io, [["id", "state", "attempts", "title"], ...summary.features.map((feature) => [feature.id, feature.state, String(feature.attempts), feature.title])]);
}

function baseDeps(home: string, run: RunPaths, cfg: ReturnType<typeof loadConfig>, runtime: Awaited<ReturnType<typeof createCliRuntime>>, flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): PhaseDeps {
  const json = flags.json === true;
  return {
    home, run, record: new RunRecord(run.record), cfg, models: runtime.models,
    availableProviders: runtime.available, modelsOn: runtime.modelsOn, apiKeyFor: runtime.apiKeyFor,
    streamFn: deps.streamFn, effort: cfg.effort, fetchImpl: deps.fetchImpl, fetchUsage: runtime.fetchUsage,
    forceLock: flags.force === true, lockHeld: true, limiter: new Limiter(cfg.ideation.concurrency),
    onText: json ? undefined : io.write,
    onTool: json ? undefined : (event) => { if (event.phase === "end") io.write(`\n${event.ok === false ? "✗" : "✓"} ${event.name}\n`); },
  };
}

function phaseExit(result: PhaseResult, run: RunPaths): number {
  return result.outcome === "failed" || readStatus(run).state === "failed" ? 1 : 0;
}

async function formCommand(run: RunPaths, flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps, home: string): Promise<number> {
  const cfg = loadConfig(home); if (flags.autonomous === true) cfg.autonomous = true;
  const runtime = await createCliRuntime(home, cfg, deps);
  const base = baseDeps(home, run, cfg, runtime, flags, io, deps);
  const status = readStatus(run); const record = base.record;
  const ideaId = status.chosenIdeaId ?? lastChosenIdea(record);
  const result = await (deps.runForm ?? runForm)(base, ideaId, {
    out: typeof flags.out === "string" ? flags.out : undefined,
    force: flags.force === true,
    io: { write: flags.json === true ? () => {} : io.write, ask: (prompt) => askCli(prompt, io, deps) },
  });
  throwIfRunCancelled();
  writeStatus(run, { usdSpent: record.costUsd() });
  printSummary(io, run, flags.json === true, result);
  return phaseExit(result, run);
}

async function confirmBuild(cfg: ReturnType<typeof loadConfig>, record: RunRecord, io: CliIo, deps: CliDeps): Promise<boolean> {
  table(io, [["build estimate", "value"], ...buildProjectionRows(cfg, record.read()).map((row) => [row.name, row.value])]);
  const answer = (await askCli("Run the build phase? [y/N] ", io, deps)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function reflectAfterBuild(base: PhaseDeps, deps: CliDeps): Promise<void> {
  if (readStatus(base.run).state === "paused") return;
  base.models("reflector");
  await (deps.runReflect ?? runReflect)(base);
  throwIfRunCancelled();
}

async function buildCommand(run: RunPaths, flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps, home: string): Promise<number> {
  const cfg = loadConfig(home); if (flags.autonomous === true) cfg.autonomous = true;
  const runtime = await createCliRuntime(home, cfg, deps);
  const base = baseDeps(home, run, cfg, runtime, flags, io, deps);
  const record = base.record;
  let result: PhaseResult = { outcome: "ok" };
  const entry = readStatus(run);

  if (entry.phase === "build") {
    if (!record.read().some((event) => event.t === "feature.pick") && flags.json !== true && flags.yes !== true && !await confirmBuild(cfg, record, io, deps)) {
      io.write("build cancelled before the first feature\n");
      return 0;
    }
    const buildDeps: BuildDeps = { ...base, ...(deps.buildDeps ?? {}), reinit: flags.reinit === true };
    const runner = flags["single-session"] === true ? (deps.runBuildSingleSession ?? runBuildSingleSession) : (deps.runBuild ?? runBuild);
    result = await runner(buildDeps, { ask: (prompt) => askCli(prompt, io, deps) });
    throwIfRunCancelled();
  } else if (entry.phase !== "reflect") {
    throw new Error(`run ${run.id} is in ${entry.phase}; form it before building`);
  }

  await reflectAfterBuild(base, deps);
  writeStatus(run, { usdSpent: record.costUsd() });
  printSummary(io, run, flags.json === true, result);
  return phaseExit(result, run);
}

function statusCommand(run: RunPaths, flags: Record<string, string | boolean>, io: CliIo): number {
  printSummary(io, run, flags.json === true);
  return 0;
}

function auditCommand(run: RunPaths, flags: Record<string, string | boolean>, io: CliIo): number {
  const audits = latestAudits(run);
  if (flags.json === true) printJson(io, audits);
  else if (audits.length === 0) io.write("(no audits)\n");
  else for (const audit of audits) io.write(renderAudit(audit));
  return 0;
}

function relockCommand(run: RunPaths, flags: Record<string, string | boolean>, io: CliIo): number {
  if (flags.confirm !== true) { (io.error ?? io.write)("project relock requires --confirm\n"); return 2; }
  const status = readStatus(run);
  const projectDir = status.projectDir ?? run.project;
  const file = parseFeatures(readFileSync(run.features, "utf8")) as FeaturesFile;
  const currentSpecHash = hashInput(readFileSync(projectPaths(projectDir).spec, "utf8"));
  relock(run, file, currentSpecHash, new RunRecord(run.record));
  writeStatus(run, { phase: "build", state: "running", outcome: undefined, cursor: { step: "relocked" }, pausedReason: undefined, wakeAt: undefined });
  printSummary(io, run, flags.json === true);
  return 0;
}

export async function projectCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const err = io.error ?? io.write;
  const action = cmd[0]; const id = cmd[1];
  if (!action || !id || !["form", "build", "status", "audit", "relock"].includes(action)) { err(USAGE); return 2; }
  const home = typeof flags.home === "string" ? flags.home : kilnHome(); initHome(home);
  if (!runExists(home, id)) { err(`unknown run ${id}\n`); return 2; }
  const run = runPaths(home, id);
  if ((action === "build" || action === "relock") && !existsSync(run.features)) { err(`run ${id} has not been formed\n`); return 2; }
  if (action === "status") return statusCommand(run, flags, io);
  if (action === "audit") return auditCommand(run, flags, io);
  if (action === "relock" && flags.confirm !== true) return relockCommand(run, flags, io);

  let lock;
  try { lock = acquireRunLock(run, { force: flags.force === true }); }
  catch (error) { if (error instanceof RunLockedError) { err(`${error.message}\n`); return 2; } throw error; }
  try {
    if (action === "form" || action === "build") deps.onRun?.(run);
    if (action === "form") return await formCommand(run, flags, io, deps, home);
    if (action === "build") return await buildCommand(run, flags, io, deps, home);
    return relockCommand(run, flags, io);
  } catch (error) {
    if (error instanceof RunCancelledError) { pauseCancelledRun(run); throw error; }
    if (error instanceof NoModelError) { err(`${error.message}\n${NO_MODEL_HINT}`); return 3; }
    if (error instanceof RunLockedError) { err(`${error.message}\n`); return 2; }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally { lock.release(); }
}
