import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RealGitRunner } from "../../build/git";
import { loadConfig } from "../../core/config";
import { kilnHome } from "../../core/paths";
import { RunRecord } from "../../core/record";
import { verifyEvalsManifest } from "../../evals/manifest";
import { createConflictArbiter } from "../../evolution/conflict";
import { applyOperatorDelta, OperatorApplyError, type OperatorApplyDeps } from "../../evolution/operator";
import { NoModelError } from "../../providers/models";
import type { CliDeps, CliIo } from "../main";
import { printJson } from "../output";
import { askCli, createCliRuntime } from "../runtime";

const USAGE = "usage: kiln evolve apply --op edit|retire --id ID [--text LESSON] [--why CLAUSE] --reason TEXT [--yes] [--json] [--home DIR]\n";
export interface OperatorCliDeps extends CliDeps { operatorApply?: OperatorApplyDeps }

export async function evolveApplyCommand(flags: Record<string, string | boolean>, io: CliIo, deps: OperatorCliDeps = {}): Promise<number> {
  const err = io.error ?? io.write;
  const value = (name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined;
  const op = value("op"); const id = value("id"); const reason = value("reason");
  if ((op !== "edit" && op !== "retire") || !id?.trim() || !reason?.trim() || (op === "edit" && !value("text")?.trim())) { err(USAGE); return 2; }
  const home = value("home") ?? kilnHome();
  try {
    const manifest = verifyEvalsManifest(home);
    if (!manifest.ok) throw new OperatorApplyError("integrity", JSON.stringify(manifest));
    if (flags.yes !== true && flags.json !== true) {
      const answer = await askCli(`Apply operator ${op} to ${id}, resetting its counters? [y/N] `, io, deps);
      if (!/^y(?:es)?$/i.test(answer.trim())) { io.write("operator change cancelled\n"); return 1; }
    }
    let applyDeps = deps.operatorApply;
    if (!applyDeps) {
      const cfg = loadConfig(home); const runtime = await createCliRuntime(home, cfg, deps);
      const { model } = runtime.models("arbiter");
      const runId = `operator-${randomUUID()}`;
      applyDeps = {
        git: new RealGitRunner(),
        arbiter: createConflictArbiter({ home, cfg, model, runId, apiKeyFor: runtime.apiKeyFor, streamFn: deps.streamFn, record: new RunRecord(join(home, "evolution", "work", runId, "record.jsonl")) }),
      };
    }
    const result = await applyOperatorDelta(home, { op, id, reason, text: value("text"), why: value("why"), kind: value("kind"), forceLock: flags.force === true }, applyDeps);
    if (flags.json === true) printJson(io, result);
    else io.write(`${result.id}: operator ${op} ${result.idempotent ? "already recorded" : "committed"}${result.commit ? ` (${result.commit})` : ""}\n`);
    return 0;
  } catch (error) {
    if (error instanceof NoModelError) { err(`${error.message}\n`); return 3; }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof OperatorApplyError && error.reason === "usage" ? 2 : 1;
  }
}
