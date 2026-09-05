import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../../core/config";
import { classifyFailure } from "../../core/failure";
import { initHome } from "../../core/home";
import { Limiter } from "../../core/limiter";
import { acquireRunLock, RunLockedError, type RunLock } from "../../core/lock";
import { kilnHome, runsDir } from "../../core/paths";
import { RunRecord } from "../../core/record";
import { RunCancelledError, throwIfRunCancelled } from "../../core/run-control";
import { pauseCancelledRun } from "../controlled-command";
import { createRun, readStatus, runExists, runPaths, writeStatus, type RunPaths, type RunStatus } from "../../core/run";
import { runDiscover } from "../../phases/discover";
import { runFrame, type PhaseDeps, type PhaseResult } from "../../phases/frame";
import { runIdeate } from "../../phases/ideate";
import { runBuild, runBuildSingleSession, type BuildDeps } from "../../phases/build";
import { lastChosenIdea, runForm } from "../../phases/form";
import { runReflect } from "../../phases/reflect";
import { runBare } from "../../ideation/bare";
import { projectedRoundCost } from "../../ideation/budget";
import { readJsonIfPresent } from "../../ideation/runtime";
import { runCheckpoint } from "../../phases/checkpoint";
import { stageHome } from "../../evolution/stage";
import { NoModelError } from "../../providers/models";
import type { CliDeps, CliIo } from "../main";
import { printJson, table } from "../output";
import { askCli, createCliRuntime, firstProbePreview } from "../runtime";
import { projectSummary } from "../project-summary";
import { buildProjectionRows } from "../build-projection";
import { routeResume, type ResumePhase } from "./run-routing";
import { HeldoutSeedError } from "../../evals/identity";
import { verifyEvalsManifest } from "../../evals/manifest";
import { manifestDriftNote, resolveNewSeed, type NewSeedInput } from "./run-seed";

const USAGE = 'usage: kiln run new ("<seed>" | --seed-id ID | --seed-file PATH) [--eval ID] [--out DIR] [--through frame|discover|ideate|checkpoint|form|build|reflect] [--bare] [--autonomous] [--reinit] [--single-session] [--yes] [--force] [--json] | kiln run show <id> | kiln run list | kiln run resume <id>\n';
const NO_MODEL_HINT = "hint: run `kiln auth login anthropic` or `kiln auth login openai`, or set ANTHROPIC_API_KEY / OPENAI_API_KEY\n";

/** File and directory outputs that exist so far, relative to the run directory. */
function filesPresent(p: RunPaths): string[] {
  const out: string[] = [];
  for (const [name, path] of [
    ["seed.md", p.seed],
    ["brief.md", p.brief],
    ["landscape.md", p.landscape],
    ["notes.md", p.notes],
  ] as const) {
    if (existsSync(path)) out.push(name);
  }
  if (existsSync(p.discoveryDir) && readdirSync(p.discoveryDir).length > 0) out.push("discovery/");
  if (existsSync(p.ideasDir) && readdirSync(p.ideasDir).length > 0) out.push("ideas/");
  return out;
}

function formatOutcome(result: PhaseResult): string {
  if (result.outcome === "honest_exit") return ` (honest exit: ${result.kind}: ${result.reasons.join("; ")})`;
  if (result.outcome === "failed") return ` (failed: ${result.failureClass}: ${result.message})`;
  if (result.outcome === "stopped") return ` (stopped: ${result.stopKind})`;
  return "";
}

const THROUGH = ["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"] as const;
type Through = (typeof THROUGH)[number];

function reaches(value: Through, target: Through): boolean {
  return THROUGH.indexOf(value) >= THROUGH.indexOf(target);
}

function resultFromStatus(status: RunStatus): PhaseResult {
  const outcome = status.outcome;
  if (outcome?.kind === "stopped" && outcome.stopKind) return { outcome: "stopped", stopKind: outcome.stopKind, truncatedRound: outcome.truncatedRound, frontierEmpty: outcome.frontierEmpty, budgetTargetUsd: outcome.budgetTargetUsd, wallTargetSeconds: outcome.wallTargetSeconds };
  if (outcome?.kind === "honest_exit") return { outcome: "honest_exit", kind: outcome.exitKind as never, reasons: outcome.reasons ?? [] };
  if (outcome?.kind === "failure") return { outcome: "failed", failureClass: outcome.failureClass ?? "verify", message: outcome.message ?? "run failed" };
  return { outcome: "ok" };
}

function checkpointReady(status: RunStatus, run: RunPaths): boolean {
  if (status.state === "done" || status.state === "failed") return false;
  if (status.cursor?.step === "checkpoint") return true;
  if (status.state !== "stopped" || status.outcome?.kind !== "stopped") return false;
  if (status.outcome.stopKind === "rounds" || status.outcome.stopKind === "stagnant") return true;
  return status.outcome.stopKind === "budget" && existsSync(run.frontier);
}

function shouldRunIdeate(status: RunStatus, run: RunPaths): boolean {
  if (status.phase !== "ideate" || checkpointReady(status, run)) return false;
  if (status.state === "running") return true;
  if (status.state === "stopped") return status.outcome?.stopKind === "stalled" || (status.outcome?.stopKind === "budget" && !existsSync(run.frontier));
  return false;
}

async function confirmIdeate(cfg: ReturnType<typeof loadConfig>, models: PhaseDeps["models"], io: CliIo, deps: CliDeps): Promise<boolean> {
  const projection = projectedRoundCost(cfg, models);
  table(io, [["ideate round", "calls", "estimated cost"], ...projection.rows.map((row) => [row.name, String(row.calls), `$${row.costUsd.toFixed(3)}`]), ["total", String(projection.calls), `$${projection.costUsd.toFixed(3)}`]]);
  const answer = (await askCli("Run the ideate phase? [y/N] ", io, deps)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function confirmBuild(cfg: ReturnType<typeof loadConfig>, record: RunRecord, io: CliIo, deps: CliDeps): Promise<boolean> {
  table(io, [["build estimate", "value"], ...buildProjectionRows(cfg, record.read()).map((row) => [row.name, row.value])]);
  const answer = (await askCli("Run the build phase? [y/N] ", io, deps)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function summaryValue(run: RunPaths, result: PhaseResult) {
  const status = readStatus(run); const record = new RunRecord(run.record);
  const formed = existsSync(run.features) ? projectSummary(run) : undefined;
  const cost = (readJsonIfPresent(run.metrics) as { cost?: unknown } | undefined)?.cost;
  return {
    id: run.id, dir: run.dir,
    ...(formed?.projectDir ? { projectDir: formed.projectDir } : {}),
    status, costUsd: record.costUsd(), outcome: result,
    ...(formed ? { features: formed.features } : {}),
    frontier: readJsonIfPresent(run.frontier),
    ...(cost === undefined ? {} : { cost }),
  };
}

function printRunSummary(run: RunPaths, result: PhaseResult, json: boolean, io: CliIo): void {
  const summary = summaryValue(run, result);
  if (json) printJson(io, summary);
  else io.write(`\nrun ${run.id}: ${summary.status.phase} ${summary.status.state} $${summary.costUsd.toFixed(2)}${formatOutcome(result)}\n`);
}

export async function runCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const err = io.error ?? io.write;
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  // Capture drift before initHome's copy-if-absent bootstrap can fill a missing bundled file.
  const manifestAtEntry = existsSync(join(home, "config.json")) ? verifyEvalsManifest(home) : undefined;
  initHome(home);
  const json = flags.json === true;

  if (cmd[0] === "list") {
    const ids = readdirSync(runsDir(home)).filter((id) => runExists(home, id)).sort();
    const summaries = ids.map((id) => {
      const p = runPaths(home, id);
      const s = readStatus(p);
      return { id, phase: s.phase, state: s.state, costUsd: new RunRecord(p.record).costUsd(), createdAt: s.createdAt };
    });
    if (json) printJson(io, summaries);
    else table(io, [["id", "phase", "state", "cost", "created"], ...summaries.map((s) => [s.id, s.phase, s.state, `$${s.costUsd.toFixed(2)}`, s.createdAt])]);
    return 0;
  }

  if (cmd[0] === "show") {
    const id = cmd[1];
    if (!id || !runExists(home, id)) {
      err(`unknown run ${id}\n`);
      return 2;
    }
    const p = runPaths(home, id);
    const status = readStatus(p);
    const record = new RunRecord(p.record);
    const v = { id, dir: p.dir, status, files: filesPresent(p), costUsd: record.costUsd(), lastEvents: record.read().slice(-10) };
    if (json) {
      printJson(io, v);
    } else {
      io.write(`run ${id}: ${status.phase} ${status.state} $${v.costUsd.toFixed(2)}\n`);
      io.write(`files: ${v.files.length > 0 ? v.files.join(", ") : "(none)"}\n`);
      for (const e of v.lastEvents) io.write(`  ${e.seq} ${e.ts} ${e.t}\n`);
    }
    return 0;
  }

  if (cmd[0] !== "new" && cmd[0] !== "resume") {
    err(USAGE);
    return 2;
  }

  if (cmd[0] === "resume") {
    const id = cmd[1];
    if (!id || !runExists(home, id)) {
      err(`unknown run ${id}\n`);
      return 2;
    }
    if (flags["seed-id"] !== undefined || flags["seed-file"] !== undefined) {
      err("run resume does not accept --seed-id or --seed-file\n");
      return 2;
    }
  }

  const throughRaw = typeof flags.through === "string" ? flags.through : "checkpoint";
  if (!THROUGH.includes(throughRaw as Through)) { err(`${USAGE}unknown --through value ${throughRaw}\n`); return 2; }
  const through = throughRaw as Through;
  let cfg = loadConfig(home); if (flags.autonomous === true) cfg.autonomous = true;
  let seedInput: NewSeedInput | undefined;
  if (cmd[0] === "new") {
    try { seedInput = resolveNewSeed(home, cmd.slice(1), flags); }
    catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof HeldoutSeedError ? 1 : 2;
    }
  }
  const evalManifest = manifestAtEntry ?? verifyEvalsManifest(home);
  const drift = manifestDriftNote(evalManifest);
  const resumedRun = cmd[0] === "resume" ? runPaths(home, cmd[1]!) : undefined;
  const resumedStatus = resumedRun ? readStatus(resumedRun) : undefined;
  if (resumedRun && drift) {
    let noteLock: RunLock;
    try { noteLock = acquireRunLock(resumedRun, { force: flags.force === true }); }
    catch (error) { if (error instanceof RunLockedError) { err(`${error.message}\n`); return 2; } throw error; }
    try { new RunRecord(resumedRun.record).append({ t: "note", text: drift }); }
    finally { noteLock.release(); }
  }
  const route = resumedRun && resumedStatus ? routeResume(resumedStatus, existsSync(resumedRun.frontier), cfg) : undefined;
  if (route?.kind === "wait") {
    if (!json) io.write(`run ${resumedRun!.id} is paused${route.wakeAt ? ` until ${route.wakeAt}` : ""}\n`);
    printRunSummary(resumedRun!, resultFromStatus(resumedStatus!), json, io);
    return 0;
  }
  if (route?.kind === "refuse") { err(`${route.message}\n`); return 2; }
  if (route?.kind === "stop") {
    if (!json) io.write(`${route.message}\n`);
    printRunSummary(resumedRun!, resultFromStatus(resumedStatus!), json, io);
    return 0;
  }

  // Held-out material never enters the ordinary home run tree. The explicit eval admission creates
  // a dedicated staged arm; credentials still resolve from the real home below.
  const runHome = seedInput?.identity?.split === "heldout" && typeof flags.eval === "string"
    ? stageHome(home, flags.eval, "manual").home
    : home;
  if (runHome !== home) cfg = loadConfig(runHome);
  const runtime = await createCliRuntime(home, cfg, deps);
  if (!resumedRun) {
    try { runtime.models("brain"); }
    catch (e) { if (e instanceof NoModelError) { err(`${e.message}\n${NO_MODEL_HINT}`); return 3; } throw e; }
  }
  const run = resumedRun ?? createRun(runHome, seedInput!.text, { projectDir: typeof flags.out === "string" ? resolve(flags.out) : undefined });
  const record = new RunRecord(run.record);
  if (cmd[0] === "new") {
    if (seedInput!.identity) writeStatus(run, { seed: seedInput!.identity });
    record.append({ t: "run.created", seed: seedInput!.text });
    if (drift) record.append({ t: "note", text: drift });
  }

  const base: PhaseDeps = {
    home: runHome,
    run,
    record,
    cfg,
    models: runtime.models,
    availableProviders: runtime.available,
    modelsOn: runtime.modelsOn,
    apiKeyFor: runtime.apiKeyFor,
    streamFn: deps.streamFn,
    effort: cfg.effort,
    fetchImpl: deps.fetchImpl,
    fetchUsage: runtime.fetchUsage,
    forceLock: flags.force === true,
    lockHeld: true,
    onProbePreview: firstProbePreview(io, !json && !cfg.autonomous),
    limiter: new Limiter(cfg.ideation.concurrency),
    onText: json ? undefined : (t: string) => io.write(t),
    onTool: json ? undefined : (e: { name: string; phase: "start" | "end"; ok?: boolean }) => {
      if (e.phase === "end") io.write(`\n${e.ok === false ? "✗" : "✓"} ${e.name}\n`);
    },
  };

  let result: PhaseResult = { outcome: "ok" };
  let status = readStatus(run);
  const forced = route?.kind === "phase" ? route.phase : undefined;
  const eligible = (phase: ResumePhase): boolean => reaches(through, phase as Through) || forced === phase;
  let commandLock: RunLock;
  try { commandLock = acquireRunLock(run, { force: flags.force === true }); }
  catch (error) { if (error instanceof RunLockedError) { err(`${error.message}\n`); return 2; } throw error; }
  try {
    deps.onRun?.(run);
    if (route?.kind === "phase" && route.wake) {
      writeStatus(run, { state: "running", outcome: undefined, pausedReason: undefined, wakeAt: undefined });
      status = readStatus(run);
    }
    if (eligible("frame") && status.phase === "frame" && status.state === "running") {
      runtime.models("brain");
      result = await (deps.runFrame ?? runFrame)(base);
      throwIfRunCancelled();
      status = readStatus(run);
    }
    if (result.outcome === "ok" && eligible("discover") && status.phase === "discover" && status.state === "running") {
      runtime.models("brain"); runtime.models("scout");
      result = await (deps.runDiscover ?? runDiscover)(base);
      throwIfRunCancelled();
      status = readStatus(run);
    }
    if (result.outcome === "ok" && eligible("ideate") && status.phase === "ideate") {
      if (shouldRunIdeate(status, run)) {
        const first = !record.read().some((event) => event.t === "phase.start" && event.phase === "ideate");
        if (first && !json && flags.yes !== true && !await confirmIdeate(cfg, runtime.models, io, deps)) {
          io.write("ideate cancelled before the first round\n");
        } else {
          const injectedIslands = deps.islandModels ?? (deps.models?.generator ? {
            generator: [runtime.models("generator")],
            cheap: deps.models.prober ? [runtime.models("prober")] : undefined,
          } : undefined);
          result = flags.bare === true ? await (deps.runBare ?? runBare)(base) : await (deps.runIdeate ?? runIdeate)({ ...base, islandModels: injectedIslands });
          throwIfRunCancelled();
          status = readStatus(run);
        }
      } else result = resultFromStatus(status);
    }
    if (eligible("checkpoint") && status.phase === "ideate" && checkpointReady(status, run)) {
      result = await (deps.runCheckpoint ?? runCheckpoint)(base, { write: json ? () => {} : io.write, ask: (prompt) => askCli(prompt, io, deps) }, { autonomous: cfg.autonomous });
      throwIfRunCancelled();
      status = readStatus(run);
    }
    if (result.outcome === "ok" && eligible("form") && status.phase === "form" && status.state === "running") {
      result = await (deps.runForm ?? runForm)(base, status.chosenIdeaId ?? lastChosenIdea(record), {
        out: typeof flags.out === "string" ? flags.out : undefined,
        force: flags.force === true,
        io: { write: json ? () => {} : io.write, ask: (prompt) => askCli(prompt, io, deps) },
      });
      throwIfRunCancelled();
      status = readStatus(run);
    }
    let ranBuild = false;
    if (result.outcome === "ok" && eligible("build") && status.phase === "build" && status.state !== "paused") {
      const first = !record.read().some((event) => event.t === "feature.pick");
      if (first && !json && flags.yes !== true && !await confirmBuild(cfg, record, io, deps)) {
        io.write("build cancelled before the first feature\n");
      } else {
        const buildDeps: BuildDeps = { ...base, ...(deps.buildDeps ?? {}), reinit: flags.reinit === true };
        const runner = flags["single-session"] === true ? (deps.runBuildSingleSession ?? runBuildSingleSession) : (deps.runBuild ?? runBuild);
        result = await runner(buildDeps, { ask: (prompt) => askCli(prompt, io, deps) });
        throwIfRunCancelled();
        ranBuild = true;
        status = readStatus(run);
      }
    }
    const reflectReached = eligible("reflect") && (status.phase === "reflect" || ranBuild);
    if (reflectReached && status.state !== "paused") {
      runtime.models("reflector");
      await (deps.runReflect ?? runReflect)(base);
      throwIfRunCancelled();
      status = readStatus(run);
    }
  } catch (e) {
    if (e instanceof RunCancelledError) { pauseCancelledRun(run); throw e; }
    if (e instanceof RunLockedError) { err(`${e.message}\n`); return 2; }
    if (e instanceof NoModelError) { err(`${e.message}\n${NO_MODEL_HINT}`); return 3; }
    // A phase that throws instead of returning a result would otherwise leave the run marked
    // `running` forever, with nothing in the journal saying why. Record it, mark it failed, and
    // report it — an unexpected exception is still a terminal outcome the user can resume from.
    const message = e instanceof Error ? e.message : String(e);
    const failureClass = classifyFailure({ error: e });
    record.append({ t: "failure", class: failureClass, message });
    writeStatus(run, { state: "failed", usdSpent: record.costUsd(), outcome: { kind: "failure", failureClass, message } });
    err(`${message}\n`);
    return 1;
  } finally { commandLock.release(); }
  // Every terminal path reports what it spent, not just the successful one: an honest exit and a
  // failure both cost money, and a status that omits the cost reads as a run that was free.
  writeStatus(run, { usdSpent: record.costUsd() });
  status = readStatus(run);

  printRunSummary(run, result, json, io);

  return result.outcome === "failed" || status.state === "failed" ? 1 : 0;
}
