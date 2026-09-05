import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt } from "../../brain/prompts";
import type { DeltaEvidence, PlaybookDelta } from "../../build/delta";
import { RealGitRunner, type GitRunner } from "../../build/git";
import { loadConfig, type KilnConfig } from "../../core/config";
import { candidatePath, kilnHome, writeAtomic } from "../../core/paths";
import { RunRecord } from "../../core/record";
import { runPaths } from "../../core/run";
import { judgeCalibration } from "../../evals/calibrate";
import { createRunExecutor } from "../../evals/executor";
import { verifyEvalsManifest } from "../../evals/manifest";
import {
  archiveCandidate,
  type ArchiveCandidateOptions,
  type ArchivedCandidate,
} from "../../evolution/archive";
import {
  assertCandidateId,
  proposeCandidate,
  readCandidate,
  type PlaybookProposalInput,
  type PromptProposalInput,
} from "../../evolution/candidate";
import { createConflictArbiter } from "../../evolution/conflict";
import {
  candidatePlan,
  createEvolutionJudge,
  evalProjection,
  evolveEval,
  EvolutionEvalError,
  type EvolveEvalDeps,
  type EvolutionArchiveReason,
} from "../../evolution/evolve";
import { candidateList } from "../../evolution/list";
import { acquireEvolveLock } from "../../evolution/lock";
import { archivedPlaybook, promoteCandidate, type PromoteDeps } from "../../evolution/promote";
import { playbookHash } from "../../evolution/playbook";
import { rollbackLatest, RollbackError, type RollbackDeps } from "../../evolution/rollback";
import { NoModelError } from "../../providers/models";
import type { CliDeps, CliIo } from "../main";
import { printJson, table } from "../output";
import { askCli, createCliRuntime } from "../runtime";
import { evolveApplyCommand } from "./evolve-apply";

const USAGE = "usage: kiln evolve list [--json] [--home DIR] | kiln evolve propose (--prompt NAME --file PATH | --op add|edit|retire --section SECTION [--id ID] [--text TEXT] [--why CLAUSE] --evidence KIND:REF) [--json] [--home DIR] | kiln evolve eval ID --budget USD [--rounds N] [--wall-seconds S] [--yes] [--json] | kiln evolve promote ID [--confirm] [--abandon EVAL_ID] [--json] | kiln evolve rollback --confirm [--json] | kiln evolve archive ID --reason operator --detail TEXT [--json] | kiln evolve apply ...\n";
const NO_MODEL_HINT = "hint: configure authenticated evolution seats before starting an evaluation\n";

type Proposal = ReturnType<typeof proposeCandidate>;
type ListResult = ReturnType<typeof candidateList>;

export interface EvolveCommandDeps {
  cli?: CliDeps;
  git?: GitRunner;
  runEval?: typeof evolveEval;
  eval?: Partial<EvolveEvalDeps>;
  runPromote?: typeof promoteCandidate;
  promote?: Partial<PromoteDeps>;
  runRollback?: typeof rollbackLatest;
  rollback?: Partial<RollbackDeps>;
  archiveCandidate?: typeof archiveCandidate;
  listCandidates?: typeof candidateList;
  proposeCandidate?: typeof proposeCandidate;
  now?: () => Date;
}

class UsageError extends Error {}

function value(flags: Record<string, string | boolean>, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] as string : undefined;
}

function positive(raw: string | boolean | undefined, name: string, integer = false): number {
  if (typeof raw !== "string") throw new UsageError(`${name} requires a value`);
  const parsed = Number(raw.replace(/^\$/, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) {
    throw new UsageError(`${name} must be a positive ${integer ? "integer" : "number"}`);
  }
  return parsed;
}

function evidence(raw: string | undefined): DeltaEvidence[] {
  if (!raw) throw new UsageError("--evidence requires KIND:REF");
  if (raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as DeltaEvidence[];
    } catch {}
    throw new UsageError("--evidence must be KIND:REF pairs or a JSON array");
  }
  return raw.split(",").map((part) => {
    const colon = part.indexOf(":");
    const kind = part.slice(0, colon); const ref = part.slice(colon + 1);
    if (colon < 1 || !["digest", "file", "metric"].includes(kind) || !ref.trim()) throw new UsageError(`invalid evidence ${part}`);
    return { kind: kind as DeltaEvidence["kind"], ref: ref.trim() };
  });
}

function sectionPrompt(section: string): "brain" | "generator" | "builder" {
  return section === "lenses" ? "generator" : section === "build" ? "builder" : "brain";
}

function proposalInput(home: string, flags: Record<string, string | boolean>, now: () => Date): PlaybookProposalInput | PromptProposalInput {
  const playbook = readFileSync(join(home, "playbook", "playbook.md"), "utf8");
  const prompt = value(flags, "prompt"); const op = value(flags, "op"); const file = value(flags, "file");
  if (prompt) {
    if (op || !file) throw new UsageError("--prompt requires --file and cannot be combined with --op");
    return { playbook, name: prompt, text: readFileSync(file, "utf8"), createdAt: now().toISOString() };
  }
  if (!op || !["add", "edit", "retire"].includes(op) || file) throw new UsageError("propose requires --prompt NAME --file PATH or --op add|edit|retire");
  const section = value(flags, "section"); const id = value(flags, "id"); const text = value(flags, "text");
  if (!section || ((op === "edit" || op === "retire") && !id) || (op !== "retire" && !text)) throw new UsageError("playbook proposal requires --section, the operation's --id/--text, and --evidence");
  const delta: PlaybookDelta = {
    op: op as PlaybookDelta["op"], section, ...(id ? { id } : {}), text: text ?? "",
    ...(value(flags, "why") ? { why: value(flags, "why") } : {}),
    ...(value(flags, "kind") ? { kind: value(flags, "kind") } : {}), evidence: evidence(value(flags, "evidence")),
  };
  return {
    playbook, delta, createdAt: now().toISOString(),
    context: { digestHeadings: [], runDir: home, metrics: {}, kernel: loadPrompt(home, "kernel"), rolePrompt: loadPrompt(home, sectionPrompt(section)) },
  };
}

async function commitArchive(
  home: string,
  id: string,
  options: ArchiveCandidateOptions,
  git: GitRunner,
  archive: typeof archiveCandidate,
): Promise<ArchivedCandidate> {
  assertCandidateId(id);
  const source = candidatePath(home, id); const sourceBytes = existsSync(source) ? readFileSync(source, "utf8") : undefined;
  const playbookPath = join(home, "playbook", "playbook.md"); const before = readFileSync(playbookPath, "utf8");
  const checked = readCandidate(source); let result: ArchivedCandidate | undefined;
  try {
    result = archive(home, id, options);
    const after = "reason" in checked ? before : archivedPlaybook(before, checked, options.reason);
    if (after !== before) writeAtomic(playbookPath, after);
    const report = join(home, "evolution", "reports", id, "eval.json");
    await git.commit(home, {
      message: `evolve(archive): ${id} ${options.reason}`,
      paths: [`evolution/archive/${id}`, ...(existsSync(report) ? [`evolution/reports/${id}/eval.json`] : []), ...(after === before ? [] : ["playbook/playbook.md"])],
    });
    return result;
  } catch (error) {
    if (result) rmSync(result.dir, { recursive: true, force: true });
    if (sourceBytes !== undefined) writeAtomic(source, sourceBytes);
    writeAtomic(playbookPath, before);
    throw error;
  }
}

async function evalDeps(home: string, id: string, cfg: KilnConfig, kind: ReturnType<typeof candidatePlan>["class"], deps: EvolveCommandDeps): Promise<EvolveEvalDeps> {
  const given = deps.eval ?? {}; const git = given.git ?? deps.git ?? new RealGitRunner(); const cli = deps.cli ?? {};
  let runtime: Awaited<ReturnType<typeof createCliRuntime>> | undefined;
  const getRuntime = async () => runtime ??= await createCliRuntime(home, cfg, cli);
  const resolved = given.models ?? (await getRuntime()).models;
  const judgeRuntime = given.judge ? undefined : await getRuntime();
  const reportDir = join(home, "evolution", "reports", id); const record = new RunRecord(join(reportDir, "record.jsonl"));
  const judge = given.judge ?? createEvolutionJudge((evalDir) => ({
    home, run: { ...runPaths(home, `${id}-judge`), record: join(evalDir, "record.jsonl") }, record,
    cfg, models: resolved, apiKeyFor: judgeRuntime!.apiKeyFor,
    streamFn: cli.streamFn, effort: cfg.effort,
  }), cfg.evals.pairsPerSeed);
  let arbiter: ReturnType<typeof createConflictArbiter> | undefined;
  const conflict = given.arbiter ?? (async (input) => {
    const active = await getRuntime(); const seat = active.models("arbiter");
    arbiter ??= createConflictArbiter({ home, cfg, model: seat.model, runId: `${id}-arbiter`, record, apiKeyFor: active.apiKeyFor, streamFn: cli.streamFn });
    return arbiter(input);
  });
  return {
    git, executor: given.executor ?? createRunExecutor(home, cli), judge, arbiter: conflict,
    archive: given.archive ?? (async (reason: EvolutionArchiveReason, detail: string) => { await commitArchive(home, id, { reason, detail, at: (deps.now ?? (() => new Date()))() }, git, deps.archiveCandidate ?? archiveCandidate); }),
    models: resolved,
    ...(given.calibration ? { calibration: given.calibration } : kind === "ideate" ? { calibration: judgeCalibration(home, cfg, resolved("judge")) } : {}),
    ...(given.buildPairs ? { buildPairs: given.buildPairs } : {}), ...(given.clone ? { clone: given.clone } : {}),
    ...(given.boundaryReady ? { boundaryReady: given.boundaryReady } : {}),
  };
}

function renderList(io: CliIo, result: ListResult): void {
  table(io, [["id", "run", "seed", "kind", "change", "status", "verdict", "held-out [LB,UB]", "seed wins", "n/req", "usd/success c/ch", "flag", "cost", "swept", "calibration", "at"], ...result.rows.map((row) => [
    row.id, row.run ?? "-", row.seed ? `${row.seed}${row.split ? `(${row.split})` : ""}` : "-", row.kind ?? "-",
    row.prompt ? `replace/${row.prompt}` : [row.section, row.op, row.targetId].filter(Boolean).join("/") || "-", row.status, row.verdict ?? "-",
    row.heldoutRate === null ? "-" : `${row.heldoutRate.toFixed(3)} [${row.heldoutLower?.toFixed(3) ?? "-"},${row.heldoutUpper?.toFixed(3) ?? "-"}]`,
    row.seedWins === null ? "-" : row.seedWins.toFixed(1), row.n === null ? "-" : `${row.n}/${row.required ?? "-"}`, row.candidateUsdPerSuccess === null ? "-" : `$${row.candidateUsdPerSuccess.toFixed(2)}/$${row.championUsdPerSuccess?.toFixed(2) ?? "-"}`,
    row.costFlag ? "yes" : "no", row.costUsd === null ? "-" : `$${row.costUsd.toFixed(2)}`, row.effortSwept === null ? "-" : row.effortSwept ? "yes" : "no", row.judgeCalibrationStatus ?? "absent", row.at ?? "-",
  ])]);
  io.write(`judgeCalibration.status: ${result.judgeCalibrationStatus ?? "absent"}\n`);
}

export async function evolveCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: EvolveCommandDeps = {}): Promise<number> {
  const action = cmd[0]; const lengths: Record<string, number> = { list: 1, propose: 1, eval: 2, promote: 2, rollback: 1, archive: 2, apply: 1 };
  if (!action || lengths[action] !== cmd.length) { (io.error ?? io.write)(USAGE); return 2; }
  if (action === "apply") return evolveApplyCommand(flags, io, deps.cli ?? {});
  const home = value(flags, "home") ?? kilnHome(); const json = flags.json === true;
  try {
    if (action === "eval" && flags.budget === undefined) throw new UsageError("--budget requires a value");
    if (action === "rollback" && flags.confirm !== true) throw new UsageError("rollback requires --confirm");
    if (action === "archive" && (value(flags, "reason") !== "operator" || !value(flags, "detail")?.trim())) throw new UsageError("archive requires --reason operator --detail TEXT");
    const manifestResult = verifyEvalsManifest(home);
    if (action !== "eval" && !manifestResult.ok) {
      throw new Error(`integrity: eval manifest mismatch: ${[...manifestResult.changed, ...manifestResult.missing, ...manifestResult.extra].join(", ")}`);
    }
    const cfg = loadConfig(home); const git = deps.git ?? new RealGitRunner();
    if (["eval", "promote", "archive"].includes(action)) assertCandidateId(cmd[1]!);
    if (value(flags, "abandon")) assertCandidateId(value(flags, "abandon")!);
    if (action === "list") {
      const promotedIds = await git.trailerValues?.(home, "Kiln-Candidate");
      const result = (deps.listCandidates ?? candidateList)(home, { currentPlaybookHash: playbookHash(readFileSync(join(home, "playbook", "playbook.md"), "utf8")), costRatioCap: cfg.evals.costRatioCap, promotedIds });
      if (json) printJson(io, result); else renderList(io, result); return 0;
    }
    if (action === "propose") {
      const lock = acquireEvolveLock(home, { force: flags.force === true });
      try {
        const result: Proposal = (deps.proposeCandidate ?? proposeCandidate)(home, proposalInput(home, flags, deps.now ?? (() => new Date())));
        if (json) printJson(io, result); else io.write(`${result.id}: candidate proposed (${result.path})\n`); return 0;
      } finally { lock.release(); }
    }
    if (action === "eval") {
      const budgetUsd = positive(flags.budget, "--budget"); const rounds = flags.rounds === undefined ? undefined : positive(flags.rounds, "--rounds", true);
      const wallSeconds = flags["wall-seconds"] === undefined ? undefined : positive(flags["wall-seconds"], "--wall-seconds", true);
      const evalOptions = { budgetUsd, ...(rounds ? { rounds } : {}), ...(wallSeconds ? { wallSeconds } : {}), forceLock: flags.force === true, ...(deps.now ? { now: deps.now } : {}) };
      const checked = readCandidate(candidatePath(home, cmd[1]!));
      // Integrity and invalid-candidate refusals are candidate terminal outcomes owned by the core
      // evaluator. Enter it without buying projection or model work so its archive callback runs.
      if (!manifestResult.ok || "reason" in checked) {
        const report = await (deps.runEval ?? evolveEval)(home, cmd[1]!, cfg, evalOptions, await evalDeps(home, cmd[1]!, cfg, "build", deps));
        if (json) printJson(io, report);
        return report.verdict === "win" ? 0 : 1;
      }
      const planned = candidatePlan(checked, cfg); const projectedCfg = { ...cfg, evals: { ...cfg.evals, ...(rounds ? { rounds } : {}) } };
      const projection = evalProjection(projectedCfg, planned.class);
      if (!json) {
        table(io, [["evolve eval projection", "expected", "ceiling"], ["per seed pair", `$${(projection.expectedUsd / projection.seedPairs).toFixed(2)}`, `$${projection.pairFloorUsd.toFixed(2)}`], ["total", `$${projection.expectedUsd.toFixed(2)}`, `$${projection.ceilingUsd.toFixed(2)}`]]);
        if (flags.yes !== true) {
          const answer = await askCli(`Evaluate ${cmd[1]}? [y/N] `, io, deps.cli ?? {});
          if (!/^y(?:es)?$/i.test(answer.trim())) { io.write("evolution evaluation cancelled\n"); return 0; }
        }
      }
      if (budgetUsd < projection.pairFloorUsd) throw new EvolutionEvalError("budget", `budget $${budgetUsd.toFixed(2)} is below one pair ceiling $${projection.pairFloorUsd.toFixed(2)}`);
      const report = await (deps.runEval ?? evolveEval)(home, cmd[1]!, cfg, evalOptions, await evalDeps(home, cmd[1]!, cfg, planned.class, deps));
      if (json) printJson(io, report); else table(io, [["candidate", "class", "verdict", "n", "wins", "required", "cost"], [report.candidateId, report.class, report.verdict, String(report.passes.heldout.pairs), String(report.passes.heldout.wins), String(report.passes.heldout.requiredWins), `$${report.costUsd.toFixed(2)}`]]);
      return report.verdict === "win" ? 0 : 1;
    }
    if (action === "promote") {
      const result = await (deps.runPromote ?? promoteCandidate)(home, { id: cmd[1]!, confirm: flags.confirm === true, abandonEvalId: value(flags, "abandon"), forceLock: flags.force === true }, { git, config: cfg, ...(deps.promote ?? {}) });
      if (json) printJson(io, result); else io.write(`${result.id}: ${result.idempotent ? "already promoted" : `promoted${result.commit ? ` (${result.commit})` : ""}`}${result.costFlag.flagged ? `; cost ratio ${result.costFlag.ratio?.toFixed(2) ?? "unknown"}x` : ""}\n`); return 0;
    }
    if (action === "rollback") {
      const result = await (deps.runRollback ?? rollbackLatest)(home, { confirm: true, forceLock: flags.force === true }, { git, ...(deps.rollback ?? {}) });
      if (json) printJson(io, result); else io.write(`rolled back ${result.reverted} with ${result.commit}\n`); return 0;
    }
    const lock = acquireEvolveLock(home, { force: flags.force === true });
    try {
      const result = await commitArchive(home, cmd[1]!, { reason: "operator", detail: value(flags, "detail")!, at: (deps.now ?? (() => new Date()))() }, git, deps.archiveCandidate ?? archiveCandidate);
      if (json) printJson(io, result); else io.write(`${result.id}: archived (operator)\n`); return 0;
    } finally { lock.release(); }
  } catch (error) {
    if (error instanceof NoModelError) { (io.error ?? io.write)(`${error.message}\n${NO_MODEL_HINT}`); return 3; }
    (io.error ?? io.write)(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError || (error instanceof EvolutionEvalError && error.reason === "usage") || (error instanceof RollbackError && error.reason === "confirmation_required")) return 2;
    return 1;
  }
}
