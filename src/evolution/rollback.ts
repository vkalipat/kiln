import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "../build/git";
import { hashInput } from "../core/record";
import { assertCandidateId } from "./candidate";
import { acquireEvolveLock } from "./lock";
import type { DeltaJournalEntry } from "./operator";
import { prepareRevert, readEvolutionFile } from "./revert-plan";
import { applyIntent, assertTransactionPaths, cleanupIntentArtifacts, listIntents, removeIntent, replaceIntent, writeIntent, type EvolutionIntent, type FileTransition } from "./transaction";

export interface RollbackRequest { confirm: boolean; forceLock?: boolean }
export interface RollbackDeps { git: GitRunner; now?: () => Date; prepareRevert?: typeof prepareRevert }
export interface RollbackResult { reverted: string; operationId: string; commit: string; candidateId?: string; operatorDeltaId?: string }
export class RollbackError extends Error {
  constructor(readonly reason: "confirmation_required" | "dirty_tree" | "not_evolution_head" | "git_contract", detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason); this.name = "RollbackError";
  }
}
interface RollbackPlan { phase: "inverse" | "metadata"; at: string; value: Omit<RollbackResult, "commit">; final: FileTransition[]; paths: string[] }
function bytes(home: string, path: string): string | null { return existsSync(join(home, path)) ? readFileSync(join(home, path), "utf8") : null; }
function safeIdentity(value: string | undefined): void {
  if (value === undefined) return;
  try { assertCandidateId(value); } catch { throw new RollbackError("git_contract", "evolution trailer has an invalid identifier"); }
}
async function headTrailer(git: GitRunner, home: string, key: string): Promise<string | undefined> {
  if (!git.trailerValues) throw new RollbackError("git_contract", "GitRunner.trailerValues is required");
  const values = await git.trailerValues(home, key, { n: 1 });
  if (values.length > 1) throw new RollbackError("git_contract", `HEAD has ambiguous ${key} trailers`);
  return values[0];
}

async function makeIntent(home: string, head: string, candidateId: string | undefined, operatorDeltaId: string | undefined, at: string, deps: RollbackDeps): Promise<EvolutionIntent<RollbackPlan>> {
  safeIdentity(candidateId); safeIdentity(operatorDeltaId);
  if (Boolean(candidateId) === Boolean(operatorDeltaId) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new RollbackError("git_contract", "rollback identity or timestamp is invalid");
  const inverse = await (deps.prepareRevert ?? prepareRevert)(home, head);
  if (!inverse.length) throw new RollbackError("git_contract", "evolution HEAD has no reversible changes");
  const operationId = `rollback-${hashInput({ head, candidateId: candidateId ?? null, operatorDeltaId: operatorDeltaId ?? null }).slice(0, 20)}`;
  const final = new Map(inverse.map((item) => [item.path, { path: item.path, before: item.after, after: item.path.startsWith("evolution/") ? item.before : item.after }]));
  const set = async (path: string, after: string | null) => {
    const before = final.has(path) ? final.get(path)!.before : await readEvolutionFile(home, head, path);
    if (before === null && after === null) final.delete(path); else final.set(path, { path, before, after });
  };
  if (candidateId) {
    const promotedPath = `evolution/promoted/${candidateId}.json`; const candidate = await readEvolutionFile(home, head, promotedPath);
    if (!candidate) throw new RollbackError("git_contract", "promoted candidate is missing");
    await set(promotedPath, null);
    await set(`evolution/archive/${candidateId}/candidate.json`, candidate);
    await set(`evolution/archive/${candidateId}/reason.json`, `${JSON.stringify({ reason: "rolled_back", detail: `reverted ${head}`, at }, null, 2)}\n`);
    const report = await readEvolutionFile(home, head, `evolution/reports/${candidateId}/eval.json`);
    if (report !== null) await set(`evolution/archive/${candidateId}/eval.json`, report);
  }
  const journalPath = "evolution/deltas.jsonl"; const journal = await readEvolutionFile(home, head, journalPath) ?? "";
  const held = journal.split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as DeltaJournalEntry] : []; } catch { return []; } });
  const entry: DeltaJournalEntry = { seq: Math.max(0, ...held.map((item) => Number.isInteger(item.seq) ? item.seq : 0)) + 1,
    ts: at, operationId, source: "operator", op: "revert", section: "rollback", id: candidateId ?? operatorDeltaId!, author: "operator", reason: `revert ${head}`, ...(candidateId ? { candidateId } : {}) };
  await set(journalPath, `${journal}${journal && !journal.endsWith("\n") ? "\n" : ""}${JSON.stringify(entry)}\n`);
  const finalTransitions = [...final.values()].filter((item) => item.before !== null || item.after !== null);
  return { version: 1, kind: "rollback", id: head, operationId, head, transitions: inverse,
    result: { phase: "inverse", at, value: { reverted: head, operationId, ...(candidateId ? { candidateId } : { operatorDeltaId: operatorDeltaId! }) }, final: finalTransitions,
      paths: [...new Set([...inverse.map((item) => item.path), ...finalTransitions.map((item) => item.path)])] } };
}

async function finish(home: string, intent: EvolutionIntent<RollbackPlan>, deps: RollbackDeps): Promise<RollbackResult> {
  const plan = intent.result;
  if (!plan || !["inverse", "metadata"].includes(plan.phase) || plan.value?.operationId !== intent.operationId || plan.value.reverted !== intent.head) throw new RollbackError("git_contract", "rollback intent does not match its result");
  safeIdentity(plan.value.candidateId); safeIdentity(plan.value.operatorDeltaId);
  const expected = await makeIntent(home, intent.head, plan.value.candidateId, plan.value.operatorDeltaId, plan.at, deps);
  const expectedTransitions = plan.phase === "inverse" ? expected.transitions : expected.result.final;
  if (intent.id !== intent.head || intent.operationId !== expected.operationId || hashInput(intent.transitions) !== hashInput(expectedTransitions)
    || hashInput({ ...plan, phase: "inverse" }) !== hashInput(expected.result)) throw new RollbackError("git_contract", "rollback intent differs from its immutable commit inverse");
  assertTransactionPaths(home, plan.paths);
  cleanupIntentArtifacts(home, intent);
  const head = await deps.git.revParseHead(home);
  if (await deps.git.hasTrailer(home, "Kiln-Operation", intent.operationId)) {
    if (await headTrailer(deps.git, home, "Kiln-Operation") !== intent.operationId) throw new RollbackError("git_contract", "rollback completed but HEAD moved; inspect its recorded operation");
    removeIntent(home, "rollback", intent.id); return { ...plan.value, commit: head };
  }
  if (head !== intent.head) throw new RollbackError("git_contract", "HEAD changed while rollback was pending");
  if (plan.phase === "inverse") {
    // On interruption finish exact inverse bytes without applying the same patch twice.
    if (intent.transitions.every((item) => bytes(home, item.path) === item.before)) await deps.git.revert(home, intent.head, { noCommit: true });
    applyIntent(home, intent);
    const next = { ...intent, transitions: plan.final.map((item) => ({ ...item })), result: { ...plan, phase: "metadata" as const } };
    replaceIntent(home, intent, next); intent = next;
  }
  applyIntent(home, intent);
  const commit = await deps.git.commit(home, { message: `evolve(rollback): revert ${intent.head.slice(0, 12)}`,
    trailers: { "Kiln-Rollback-Of": intent.head, "Kiln-Operation": intent.operationId }, paths: plan.paths });
  removeIntent(home, "rollback", intent.id);
  return { ...plan.value, commit };
}

/** Revert HEAD only, preserving append-only evidence and a durable two-phase recovery record. */
export async function rollbackLatest(home: string, request: RollbackRequest, deps: RollbackDeps): Promise<RollbackResult> {
  if (!request.confirm) throw new RollbackError("confirmation_required", "rollback requires --confirm");
  const lock = acquireEvolveLock(home, { force: request.forceLock });
  try {
    const pending = listIntents<RollbackPlan>(home, "rollback");
    if (pending.length > 1) throw new RollbackError("git_contract", "multiple pending rollbacks require inspection");
    if (pending[0]) return finish(home, pending[0], deps);
    if (listIntents(home, "operator").length || listIntents(home, "promote").length) throw new RollbackError("git_contract", "finish the pending evolution mutation first");
    const dirty = await deps.git.statusPorcelain(home);
    if (dirty.trim()) throw new RollbackError("dirty_tree", dirty.trim());
    const head = await deps.git.revParseHead(home);
    const candidateId = await headTrailer(deps.git, home, "Kiln-Candidate");
    const operatorDeltaId = candidateId ? undefined : await headTrailer(deps.git, home, "Kiln-Operator-Delta");
    if (!candidateId && !operatorDeltaId) throw new RollbackError("not_evolution_head", "HEAD has no eligible evolution trailer");
    safeIdentity(candidateId); safeIdentity(operatorDeltaId);
    const at = (deps.now ?? (() => new Date()))().toISOString();
    if (candidateId && existsSync(join(home, "evolution", "archive", candidateId))) throw new RollbackError("git_contract", "candidate already has a terminal archive");
    const intent = await makeIntent(home, head, candidateId, operatorDeltaId, at, deps);
    assertTransactionPaths(home, intent.result.paths);
    writeIntent(home, intent);
    return finish(home, intent, deps);
  } finally { lock.release(); }
}

export const rollbackEvolution = rollbackLatest;
