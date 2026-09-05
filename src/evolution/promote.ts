import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GitCommitOptions, GitRunner } from "../build/git";
import { loadConfig, type KilnConfig } from "../core/config";
import { candidatePath } from "../core/paths";
import { hashInput } from "../core/record";
import { leakcheck, type LeakcheckResult } from "../evals/leakcheck";
import { verifyEvalsManifest, type ManifestVerification } from "../evals/manifest";
import { costWarning, type CostWarning, type JudgeCalibrationStatus } from "../evals/report";
import { sha256Bytes } from "../evals/seeds";
import { readArchiveReason, type ArchiveReason } from "./archive";
import { assertCandidateId, candidateFileId, readCandidate, validateCandidate, type Candidate, type EvaluatedVerdict } from "./candidate";
import { acquireEvolveLock, EvolveLockedError } from "./lock";
import { parsePlaybook, playbookHash } from "./playbook";
import type { DeltaJournalEntry } from "./operator";
import {
  applyIntent,
  cleanupIntentArtifacts,
  listIntents,
  removeIntent,
  writeIntent,
  type EvolutionIntent,
  type FileTransition,
} from "./transaction";
import { archivedPlaybook, promotedPlaybook, promotionGate, type PromoteReason, type PromoteRefusal, type PromotionGateInput } from "./promotion-policy";

export { archivedPlaybook, promotedPlaybook, promotionGate };
export type { PromoteReason, PromoteRefusal, PromotionGate, PromotionGateInput } from "./promotion-policy";

export interface PromoteRequest { id: string; confirm?: boolean; abandonEvalId?: string; forceLock?: boolean }
export interface PromoteDeps {
  git: GitRunner;
  config?: KilnConfig;
  now?: () => Date;
  verifyManifest?: (home: string) => ManifestVerification;
  leakcheck?: (home: string) => LeakcheckResult;
}
export interface PromoteResult {
  id: string; operationId: string; commit?: string; championBefore: string; championAfter: string;
  confirmed: boolean; costFlag: CostWarning; archived: string[]; idempotent: boolean;
}

export class PromoteError extends Error {
  constructor(readonly refusal: PromoteRefusal, readonly archived = false) {
    super(`${refusal.reason}: ${refusal.detail}`); this.name = "PromoteError";
  }
  get reason(): PromoteReason { return this.refusal.reason; }
  get rung(): number { return this.refusal.rung; }
}

interface ReportView {
  verdict?: EvaluatedVerdict; effortSwept: boolean; heldoutRate?: number;
  judgeCalibrationStatus?: JudgeCalibrationStatus; costFlag: CostWarning; class?: "ideate" | "form" | "build";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function json(path: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch { return undefined; }
}
function reportView(raw: Record<string, unknown> | undefined, cap: number): ReportView {
  const verdicts = ["win", "lose", "not_evidence", "censored", "incomplete"];
  const verdict = verdicts.includes(String(raw?.verdict)) ? raw!.verdict as EvaluatedVerdict : undefined;
  const heldout = object(object(raw?.passes)?.heldout);
  const calibration = object(raw?.judgeCalibration)?.status;
  const usd = object(raw?.usdPerSuccess);
  const candidateUsd = finite(raw?.candidateUsdPerSuccess) ?? finite(usd?.candidate);
  const championUsd = finite(raw?.championUsdPerSuccess) ?? finite(usd?.champion);
  const stored = object(raw?.costFlag);
  const warning = typeof stored?.flagged === "boolean"
    ? { flagged: stored.flagged, ratio: finite(stored.ratio) }
    : costWarning(candidateUsd, championUsd, cap);
  return {
    ...(verdict ? { verdict } : {}), effortSwept: raw?.effortSwept === true,
    ...(finite(heldout?.rate) !== null ? { heldoutRate: finite(heldout?.rate)! } : {}),
    ...(typeof calibration === "string" ? { judgeCalibrationStatus: calibration as JudgeCalibrationStatus } : {}),
    ...(raw?.class === "ideate" || raw?.class === "form" || raw?.class === "build" ? { class: raw.class } : {}),
    costFlag: warning,
  };
}

function dirtyPathsZ(status: string): string[] {
  const fields = status.split("\0"); const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]; if (!field) continue;
    if (field.length < 4 || field[2] !== " ") throw new PromoteError({ rung: 2, reason: "git_contract", detail: "malformed porcelain -z record" });
    paths.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2))) {
      const original = fields[++index];
      if (!original) throw new PromoteError({ rung: 2, reason: "git_contract", detail: "rename record has no original path" });
      paths.push(original);
    }
  }
  return paths;
}

async function championDirty(git: GitRunner, home: string, allowed: ReadonlySet<string> = new Set()): Promise<boolean> {
  if (!git.statusPorcelainZ) throw new PromoteError({ rung: 2, reason: "git_contract", detail: "GitRunner.statusPorcelainZ is required" });
  const dirty = dirtyPathsZ(await git.statusPorcelainZ(home));
  if (dirty.some((path) => !allowed.has(path) && ["playbook/", "prompts/", "evals/"].some((prefix) => path.startsWith(prefix)))) return true;
  if (!dirty.includes("config.json")) return false;
  const diff = await git.diff(home, { ref: "HEAD", path: "config.json" });
  return diff.split(/\r?\n/).some((line) => /^[+-](?![+-])/.test(line) && /["']?judgeGate["']?\s*:/.test(line));
}

function incompleteReports(home: string): string[] {
  const root = join(home, "evolution", "reports");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => entry.name).filter((id) => json(join(root, id, "eval.json"))?.verdict === "incomplete"
      && readArchiveReason(home, id)?.reason !== "superseded").sort();
}

interface PendingCandidate { id: string; bytes: string }
interface PromoteIntentResult {
  mode: "promote" | "archive";
  requestHash: string;
  response?: Omit<PromoteResult, "commit" | "idempotent">;
  refusal?: PromoteRefusal;
  commit: GitCommitOptions;
}
type PromoteIntent = EvolutionIntent<PromoteIntentResult>;

function pending(home: string): PendingCandidate[] {
  const root = join(home, "evolution", "candidates");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ id: candidateFileId(entry.name), bytes: readFileSync(join(root, entry.name), "utf8") }));
}

function journal(path: string): DeltaJournalEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as DeltaJournalEntry] : []; } catch { return []; } });
}

function journalBytes(before: string | null, entry: DeltaJournalEntry): string {
  const prefix = before === null || before === "" ? "" : before.endsWith("\n") ? before : `${before}\n`;
  return `${prefix}${JSON.stringify(entry)}\n`;
}

function requestHash(request: PromoteRequest): string {
  return hashInput({ id: request.id, confirm: request.confirm === true, abandonEvalId: request.abandonEvalId ?? null });
}

function reasonBytes(reason: ArchiveReason, detail: string, at: string): string {
  return `${JSON.stringify({ reason, detail, at }, null, 2)}\n`;
}

function archiveTransitions(home: string, item: PendingCandidate, reason: ArchiveReason, detail: string, at: string): FileTransition[] {
  const reportPath = join(home, "evolution", "reports", item.id, "eval.json");
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  return [
    { path: `evolution/archive/${item.id}/candidate.json`, before: null, after: item.bytes },
    ...(report === null ? [] : [
      { path: `evolution/archive/${item.id}/eval.json`, before: null, after: report },
      { path: `evolution/reports/${item.id}/eval.json`, before: report, after: report },
    ]),
    { path: `evolution/archive/${item.id}/reason.json`, before: null, after: reasonBytes(reason, detail, at) },
    { path: `evolution/candidates/${item.id}.json`, before: item.bytes, after: null },
  ];
}

function trackedPaths(transitions: readonly FileTransition[], extra: readonly string[] = []): string[] {
  return [...new Set([...transitions.map((item) => item.path).filter((path) => !path.startsWith("evolution/candidates/")), ...extra])];
}

function authorityProblem(id: string, candidate: Candidate, raw: Record<string, unknown>, championHash: string): string | undefined {
  if (raw.candidateId !== id) return "eval report candidateId does not match the requested candidate";
  if (raw.playbookHash !== championHash || candidate.playbookHash !== championHash) return "eval report champion hash does not match";
  const embedded = object(raw.candidate) ? readCandidateValue(raw.candidate) : undefined;
  if (!embedded) return "eval report has no valid frozen candidate";
  if (hashInput(embedded) !== hashInput(candidate)) return "live candidate differs from the evaluated candidate";
  if (raw.class !== "ideate" && raw.class !== "form" && raw.class !== "build") return "eval report has no frozen candidate class";
  return undefined;
}

function readCandidateValue(value: unknown): Candidate | undefined {
  const checked = validateCandidate(value); return "reason" in checked ? undefined : checked;
}

function archivedBy(home: string, winner: string): string[] {
  const root = join(home, "evolution", "archive");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .filter((id) => {
      const record = readArchiveReason(home, id);
      return record?.detail === `${winner} moved the champion`;
    }).sort();
}

async function headValues(git: GitRunner, home: string, key: string): Promise<string[]> {
  if (!git.trailerValues) throw new PromoteError({ rung: 2, reason: "git_contract", detail: "GitRunner.trailerValues is required" });
  return git.trailerValues(home, key, { n: 1 });
}

async function executeIntent(home: string, intent: PromoteIntent, request: PromoteRequest, deps: PromoteDeps): Promise<PromoteResult> {
  cleanupIntentArtifacts(home, intent);
  const allowed = new Set(intent.transitions.map((item) => item.path));
  if (await championDirty(deps.git, home, allowed)) throw new PromoteError({ rung: 2, reason: "dirty_tree", detail: "protected bytes outside the pending transaction are dirty" });
  if (await deps.git.hasTrailer(home, "Kiln-Operation", intent.operationId)) {
    removeIntent(home, "promote", intent.id);
    if (intent.result.mode === "archive") throw new PromoteError(intent.result.refusal!, true);
    return { ...intent.result.response!, idempotent: true };
  }
  if (intent.result.requestHash !== requestHash(request)) {
    throw new PromoteError({ rung: 4, reason: "transaction_conflict", detail: "retry arguments differ from the durable promotion intent" });
  }
  if (await deps.git.revParseHead(home) !== intent.head) {
    throw new PromoteError({ rung: 4, reason: "transaction_conflict", detail: "HEAD moved while the promotion intent was pending" });
  }
  applyIntent(home, intent);
  const commit = await deps.git.commit(home, intent.result.commit);
  removeIntent(home, "promote", intent.id);
  if (intent.result.mode === "archive") throw new PromoteError(intent.result.refusal!, true);
  return { ...intent.result.response!, commit, idempotent: false };
}

async function archiveRefusal(home: string, id: string, candidate: Candidate | undefined, refusal: PromoteRefusal, request: PromoteRequest, deps: PromoteDeps, at: string): Promise<never> {
  if (!refusal.archiveReason || !existsSync(candidatePath(home, id))) throw new PromoteError(refusal);
  const source = readFileSync(candidatePath(home, id), "utf8"); const playbookPath = join(home, "playbook", "playbook.md");
  const before = readFileSync(playbookPath, "utf8"); const after = candidate ? archivedPlaybook(before, candidate, refusal.archiveReason) : before;
  const transitions = archiveTransitions(home, { id, bytes: source }, refusal.archiveReason, refusal.detail, at);
  if (after !== before) transitions.unshift({ path: "playbook/playbook.md", before, after });
  const operationId = `archive-${hashInput({ id, refusal, at }).slice(0, 20)}`;
  const intent: PromoteIntent = { version: 1, kind: "promote", id, operationId, head: await deps.git.revParseHead(home), transitions,
    result: { mode: "archive", requestHash: requestHash(request), refusal,
      commit: { message: `evolve(archive): ${id} ${refusal.archiveReason}`, trailers: { "Kiln-Operation": operationId }, paths: trackedPaths(transitions) } } };
  writeIntent(home, intent); await executeIntent(home, intent, request, deps);
  throw new PromoteError(refusal, true);
}

/** Promote one completed candidate and archive every other pending candidate in the same commit. */
export async function promoteCandidate(home: string, request: PromoteRequest, deps: PromoteDeps): Promise<PromoteResult> {
  const config = deps.config ?? loadConfig(home); const now = deps.now ?? (() => new Date());
  const manifest = (deps.verifyManifest ?? verifyEvalsManifest)(home);
  if (!manifest.ok) throw new PromoteError((promotionGate({ manifestOk: false } as PromotionGateInput) as { ok: false; refusal: PromoteRefusal }).refusal);
  let intents: PromoteIntent[];
  try { intents = listIntents<PromoteIntentResult>(home, "promote"); }
  catch (error) { throw new PromoteError({ rung: 4, reason: "transaction_conflict", detail: error instanceof Error ? error.message : String(error) }); }
  if (intents.length > 1 || (intents.length === 1 && intents[0]!.id !== request.id)) {
    throw new PromoteError({ rung: 4, reason: "transaction_conflict", detail: "another promotion transaction requires recovery" });
  }
  if (intents.length === 0 && await championDirty(deps.git, home)) {
    throw new PromoteError((promotionGate({ manifestOk: true, dirty: true } as PromotionGateInput) as { ok: false; refusal: PromoteRefusal }).refusal);
  }
  try {
    assertCandidateId(request.id);
    if (request.abandonEvalId !== undefined) assertCandidateId(request.abandonEvalId);
  } catch (error) {
    throw new PromoteError({ rung: 4, reason: "invalid", detail: error instanceof Error ? error.message : String(error) });
  }
  let lock;
  try { lock = acquireEvolveLock(home, { force: request.forceLock }); }
  catch (error) {
    if (error instanceof EvolveLockedError) throw new PromoteError({ rung: 3, reason: "locked", detail: error.message });
    throw error;
  }
  try {
    if (intents[0]) return executeIntent(home, intents[0], request, deps);
    if (await championDirty(deps.git, home)) throw new PromoteError({ rung: 2, reason: "dirty_tree", detail: "protected champion inputs are dirty" });
    const playbookPath = join(home, "playbook", "playbook.md"); const championText = readFileSync(playbookPath, "utf8");
    const beforeHash = playbookHash(championText); const sourcePath = candidatePath(home, request.id);
    const promotedPath = join(home, "evolution", "promoted", `${request.id}.json`);
    const headCandidates = await headValues(deps.git, home, "Kiln-Candidate");
    if (headCandidates.length === 1 && headCandidates[0] === request.id && existsSync(promotedPath)) {
      const held = readCandidate(promotedPath); const reportPath = join(home, "evolution", "reports", request.id, "eval.json"); const raw = json(reportPath);
      if ("reason" in held || !raw) throw new PromoteError({ rung: 4, reason: "invalid", detail: "committed promotion facts are incomplete" });
      const problem = authorityProblem(request.id, held, raw, held.playbookHash);
      if (problem) throw new PromoteError({ rung: 4, reason: "invalid", detail: problem });
      const operations = await headValues(deps.git, home, "Kiln-Operation"); const confirmations = await headValues(deps.git, home, "Kiln-Confirmed");
      if (operations.length !== 1 || confirmations.length !== 1) throw new PromoteError({ rung: 4, reason: "git_contract", detail: "promotion trailers are incomplete" });
      return { id: request.id, operationId: operations[0]!, championBefore: held.playbookHash, championAfter: beforeHash,
        confirmed: confirmations[0] === "true", costFlag: reportView(raw, config.evals.costRatioCap).costFlag,
        archived: archivedBy(home, request.id), idempotent: true };
    }
    const incompletes = incompleteReports(home);
    const remaining = incompletes.filter((id) => id !== request.abandonEvalId);
    const invalidAbandon = request.abandonEvalId !== undefined && !incompletes.includes(request.abandonEvalId);
    const abandonMissing = request.abandonEvalId !== undefined && !existsSync(candidatePath(home, request.abandonEvalId));
    if (remaining.length || request.abandonEvalId === request.id || invalidAbandon || abandonMissing) {
      throw new PromoteError({ rung: 3, reason: "incomplete_eval", detail: remaining[0] ?? request.abandonEvalId ?? request.id });
    }
    const checked = readCandidate(sourcePath, { currentPlaybookHash: beforeHash });
    const candidate = "reason" in checked ? undefined : checked;
    if (!candidate) {
      const reason = "reason" in checked ? checked.reason : "candidate_not_found";
      await archiveRefusal(home, request.id, undefined, { rung: 4, reason: reason === "stale_champion" ? "stale_champion" : "invalid", detail: reason,
        archiveReason: reason === "stale_champion" ? "stale_champion" : "invalid" }, request, deps, now().toISOString());
    }
    const reportPath = join(home, "evolution", "reports", request.id, "eval.json"); const reportRaw = json(reportPath);
    const report = reportView(reportRaw, config.evals.costRatioCap);
    if (!reportRaw || report.verdict === undefined) {
      await archiveRefusal(home, request.id, candidate, { rung: 5, reason: "missing_report",
        detail: "candidate has no finished eval report", archiveReason: "invalid" }, request, deps, now().toISOString());
    }
    const authority = authorityProblem(request.id, candidate!, reportRaw!, beforeHash);
    if (authority) await archiveRefusal(home, request.id, candidate, { rung: 4, reason: "invalid", detail: authority, archiveReason: "invalid" }, request, deps, now().toISOString());
    let promoted = { text: championText, id: candidate!.delta?.id ?? request.id }; let overflow = false;
    if (candidate!.kind === "playbook") {
      try { promoted = promotedPlaybook(championText, candidate!, request.id, now()); }
      catch (error) {
        if (/120 active/.test((error as Error).message)) overflow = true;
        else await archiveRefusal(home, request.id, candidate, { rung: 4, reason: "invalid", detail: (error as Error).message, archiveReason: "invalid" }, request, deps, now().toISOString());
      }
    }
    const leak = (deps.leakcheck ?? leakcheck)(home);
    const kind = report.class!;
    const gate = promotionGate({ manifestOk: true, dirty: false, locked: false, incompleteEval: false,
      reportExists: true, leak: !leak.ok, activeBullets: overflow ? 121 : parsePlaybook(promoted.text).sections
        .filter((section) => section.name !== "retired").reduce((sum, section) => sum + section.bullets.length, 0),
      effortSwept: report.effortSwept, judgeBased: kind === "ideate",
      judgeCalibrationStatus: kind === "ideate" && config.evals.judgeGate === "removed" ? "removed" : report.judgeCalibrationStatus,
      verdict: report.verdict!, heldoutRate: report.heldoutRate, confirm: request.confirm, confirmEligible: kind !== "form" });
    if (!gate.ok && gate.refusal.reason === "leak" && leak.rows.some((row) => row.kind === "heldout_candidate")) {
      gate.refusal.archiveReason = "heldout_seed";
    }
    if (!gate.ok) await archiveRefusal(home, request.id, candidate, gate.refusal, request, deps, now().toISOString());
    const accepted = gate as { ok: true; confirmed: boolean };

    const at = now().toISOString(); const head = await deps.git.revParseHead(home); const heldPending = pending(home);
    const winner = heldPending.find((item) => item.id === request.id);
    if (!winner) throw new PromoteError({ rung: 4, reason: "transaction_conflict", detail: "candidate changed before intent creation" });
    const journalPath = join(home, "evolution", "deltas.jsonl"); const journalBefore = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : null;
    const targetPath = candidate!.kind === "playbook" ? playbookPath : join(home, "prompts", `${candidate!.prompt!.name}.md`);
    const targetBefore = readFileSync(targetPath, "utf8"); const reportBytes = readFileSync(reportPath, "utf8");
    const operationId = `promote-${hashInput({ id: request.id, candidate: winner.bytes, report: sha256Bytes(reportBytes) }).slice(0, 20)}`;
    const archived = heldPending.filter((item) => item.id !== request.id).map((item) => item.id).sort();
    const transitions = heldPending.filter((item) => item.id !== request.id).flatMap((item) => archiveTransitions(home, item,
      item.id === request.abandonEvalId ? "superseded" : "stale_champion", `${request.id} moved the champion`, at));
    const targetRelative = candidate!.kind === "playbook" ? "playbook/playbook.md" : `prompts/${candidate!.prompt!.name}.md`;
    transitions.push({ path: targetRelative, before: targetBefore, after: candidate!.kind === "playbook" ? promoted.text : candidate!.prompt!.text });
    transitions.push({ path: `evolution/promoted/${request.id}.json`, before: null, after: winner.bytes });
    transitions.push({ path: `evolution/reports/${request.id}/eval.json`, before: reportBytes, after: reportBytes });
    if (candidate!.delta) {
      const held = journal(journalPath); const entry: DeltaJournalEntry = {
        seq: Math.max(0, ...held.map((item) => Number.isInteger(item.seq) ? item.seq : 0)) + 1, ts: at, operationId,
        source: candidate!.author, op: candidate!.delta.op, section: candidate!.delta.section, id: promoted.id,
        ...(candidate!.delta.text ? { text: candidate!.delta.text } : {}), ...(candidate!.delta.why ? { why: candidate!.delta.why } : {}),
        ...(candidate!.delta.kind ? { kind: candidate!.delta.kind } : {}), author: candidate!.author, evidence: candidate!.delta.evidence,
        ...(candidate!.runId ? { runId: candidate!.runId } : {}), candidateId: request.id, evalId: request.id,
      };
      transitions.push({ path: "evolution/deltas.jsonl", before: journalBefore, after: journalBytes(journalBefore, entry) });
    }
    transitions.push({ path: `evolution/candidates/${request.id}.json`, before: winner.bytes, after: null });
    const afterHash = playbookHash(candidate!.kind === "playbook" ? promoted.text : championText);
    const summary = candidate!.kind === "prompt" ? `replace ${candidate!.prompt!.name}` : `${candidate!.delta!.op} ${promoted.id} — ${candidate!.delta!.text.replace(/\s+/g, " ").slice(0, 60)}`;
    const response = { id: request.id, operationId, championBefore: beforeHash, championAfter: afterHash,
      confirmed: accepted.confirmed, costFlag: report.costFlag, archived };
    const intent: PromoteIntent = { version: 1, kind: "promote", id: request.id, operationId, head, transitions,
      result: { mode: "promote", requestHash: requestHash(request), response,
        commit: { message: `evolve(${candidate!.kind === "prompt" ? "prompt" : candidate!.delta!.section}): ${summary}`,
          trailers: { "Kiln-Candidate": request.id, "Kiln-Eval": sha256Bytes(reportBytes), "Kiln-Operation": operationId,
            "Kiln-Champion-Before": beforeHash, "Kiln-Champion-After": afterHash, "Kiln-Confirmed": String(accepted.confirmed),
            "Kiln-Cost-Ratio": report.costFlag.ratio ?? "unknown" }, paths: trackedPaths(transitions) } } };
    writeIntent(home, intent);
    return executeIntent(home, intent, request, deps);
  } finally { lock.release(); }
}
