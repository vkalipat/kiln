import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config";
import { initHome } from "../../core/home";
import { Limiter } from "../../core/limiter";
import { acquireRunLock, RunLockedError, type RunLock } from "../../core/lock";
import { kilnHome } from "../../core/paths";
import { RunRecord } from "../../core/record";
import { readStatus, runExists, runPaths } from "../../core/run";
import { writeMetrics } from "../../ideation/metrics";
import { runTournament, type TournamentRecord } from "../../ideation/tournament";
import { pickIdea, readFrontier, rejectIdea, requestAnotherRound } from "../../phases/checkpoint";
import { NoModelError } from "../../providers/models";
import type { Criteria } from "../../ideation/judge";
import type { PhaseDeps } from "../../phases/frame";
import type { CliDeps, CliIo } from "../main";
import { printJson, table } from "../output";
import { createCliRuntime } from "../runtime";

const IDEAS_USAGE = "usage: kiln ideas frontier <run> [--json] | kiln ideas pick <run> <id> | kiln ideas reject <run> <id> <reason> | kiln ideas another <run> <steering>\n";
const JUDGE_USAGE = "usage: kiln judge pair <run> <a> <b> [--json]\n";

function context(home: string, id: string) {
  if (!id || !runExists(home, id)) return undefined;
  const run = runPaths(home, id);
  return { run, record: new RunRecord(run.record) };
}

function codeFor(result: ReturnType<typeof pickIdea>): number {
  return result.outcome === "failed" ? 1 : 0;
}

export async function ideasCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo): Promise<number> {
  const err = io.error ?? io.write;
  const home = typeof flags.home === "string" ? flags.home : kilnHome(); initHome(home);
  const found = context(home, cmd[1] ?? "");
  if (!found) { err(`unknown run ${cmd[1]}\n`); return 2; }
  const { run, record } = found;

  if (cmd[0] === "frontier") {
    try {
      const frontier = readFrontier({ run });
      if (flags.json === true) printJson(io, frontier);
      else table(io, [["id", "value", "feasibility", "cell", "backfill"], ...frontier.ideas.map((idea) => [
        idea.id, idea.value?.mean.toFixed(3) ?? "", idea.feasibility?.mean.toFixed(3) ?? "", idea.cell ?? "", String(idea.backfill),
      ])]);
      return 0;
    } catch (error) { err(`${(error as Error).message}\n`); return 1; }
  }

  let lock: RunLock;
  try { lock = acquireRunLock(run, { force: flags.force === true }); }
  catch (error) { if (error instanceof RunLockedError) { err(`${error.message}\n`); return 2; } throw error; }
  try {
    let result;
    if (cmd[0] === "pick" && cmd[2]) result = pickIdea({ run, record }, cmd[2]);
    else if (cmd[0] === "reject" && cmd[2] && cmd.slice(3).length > 0) result = rejectIdea({ run, record }, cmd[2], cmd.slice(3).join(" "));
    else if (cmd[0] === "another" && cmd.slice(2).length > 0) result = requestAnotherRound({ run, record }, cmd.slice(2).join(" "));
    else { err(IDEAS_USAGE); return 2; }
    writeMetrics(run);
    if (result.outcome === "failed") err(`${result.message}\n`);
    else if (flags.json === true) printJson(io, { id: run.id, status: readStatus(run), outcome: result });
    else io.write(`run ${run.id}: ${cmd[0]} recorded\n`);
    return codeFor(result);
  } finally { lock.release(); }
}

function latestRender(dir: string, id: string): { round: number; text: string; hash: string } | undefined {
  const matches = readdirSync(dir).flatMap((file) => {
    const match = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-r(\\d+)\\.md$`).exec(file);
    return match ? [{ file, round: Number(match[1]) }] : [];
  }).sort((a, b) => b.round - a.round);
  const hit = matches[0]; if (!hit) return undefined;
  const text = readFileSync(join(dir, hit.file), "utf8");
  return { round: hit.round, text, hash: Bun.CryptoHasher.hash("sha256", text, "hex") };
}

function criteriaFor(run: ReturnType<typeof runPaths>, round: number): Criteria | undefined {
  if (!existsSync(run.criteriaDir)) return undefined;
  const file = readdirSync(run.criteriaDir).filter((name) => name.startsWith(`r${round}-`) && name.endsWith(".md") && !name.endsWith("-meta.md")).sort()[0];
  if (!file) return undefined;
  return { id: file.slice(0, -3), text: readFileSync(join(run.criteriaDir, file), "utf8").trim(), round, shape: readStatus(run).shape ?? "product" };
}

export async function judgeCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const err = io.error ?? io.write;
  if (cmd[0] !== "pair" || !cmd[1] || !cmd[2] || !cmd[3]) { err(JUDGE_USAGE); return 2; }
  const home = typeof flags.home === "string" ? flags.home : kilnHome(); initHome(home);
  const found = context(home, cmd[1]); if (!found) { err(`unknown run ${cmd[1]}\n`); return 2; }
  const { run, record } = found; const [left, right] = [cmd[2], cmd[3]].sort();
  const a = latestRender(run.renderedDir, left!); const b = latestRender(run.renderedDir, right!);
  if (!a || !b || a.round !== b.round) { err("both ideas need rendered files from the same round\n"); return 1; }
  const criteria = criteriaFor(run, a.round); if (!criteria) { err(`no criteria for round ${a.round}\n`); return 1; }
  const cfg = loadConfig(home); const runtime = await createCliRuntime(home, cfg, deps);
  try { runtime.models("judge"); }
  catch (error) { if (error instanceof NoModelError) { err(`${error.message}\n`); return 3; } throw error; }
  const phase: PhaseDeps = { home, run, record, cfg, models: runtime.models, availableProviders: runtime.available, modelsOn: runtime.modelsOn, apiKeyFor: runtime.apiKeyFor, streamFn: deps.streamFn, effort: cfg.effort, fetchImpl: deps.fetchImpl, limiter: new Limiter(cfg.ideation.concurrency) };
  const assignments = new Map<string, string>(record.read().flatMap((event) => event.t === "island.assign" ? [[`${event.round}|${event.island}`, event.model] as [string, string]] : []));
  const generatedBy = (id: string) => { const match = /^r(\d+)-i(\d+)-/.exec(id); return match ? assignments.get(`${match[1]}|${match[2]}`) ?? "unknown" : "unknown"; };
  let lock: RunLock;
  try { lock = acquireRunLock(run, { force: flags.force === true }); }
  catch (error) { if (error instanceof RunLockedError) { err(`${error.message}\n`); return 2; } throw error; }
  try {
    const lines = await runTournament(phase, { round: a.round, pairs: [[left!, right!]], renders: { [left!]: a, [right!]: b }, genModels: { [left!]: generatedBy(left!), [right!]: generatedBy(right!) }, criteria, limiter: phase.limiter });
    const pair = lines.filter((line) => line.a === left && line.b === right) as TournamentRecord[];
    if (flags.json === true) printJson(io, pair); else for (const line of pair) io.write(`${line.order}: value=${line.valueWinner} feasibility=${line.feasibilityWinner}\n`);
    return 0;
  } finally { try { writeMetrics(run); } finally { lock.release(); } }
}
