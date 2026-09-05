import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { validateDelta, type DeltaContext, type DeltaEvidence, type PlaybookDelta } from "../build/delta";
import { type GitRunner } from "../build/git";
import { hashInput } from "../core/record";
import { verifyEvalsManifest } from "../evals/manifest";
import { acquireEvolveLock } from "./lock";
import { applyDelta, parsePlaybook, playbookHash, type PlaybookBullet, type PlaybookSectionName } from "./playbook";
import { applyIntent, listIntents, readIntent, removeIntent, writeIntent, type EvolutionIntent } from "./transaction";

export type OperatorOp = "edit" | "retire";

export interface OperatorApplyRequest {
  op: OperatorOp;
  id: string;
  text?: string;
  why?: string;
  reason: string;
  kind?: string;
  author?: string;
  forceLock?: boolean;
}

export interface ConflictInput {
  bullet: string;
  against: string;
  againstId: string | null;
  kind: "role_prompt" | "sibling";
}

export interface ConflictVerdict {
  conflicts: boolean;
  against: string | null;
  reason: string;
}

export type ConflictArbiter = (input: ConflictInput) => Promise<ConflictVerdict>;

export interface OperatorApplyDeps {
  git: GitRunner;
  arbiter: ConflictArbiter;
  now?: () => Date;
}

export interface DeltaJournalEntry {
  seq: number;
  ts: string;
  operationId: string;
  source: "operator" | "reflector";
  op: OperatorOp | "add" | "revert";
  section: string;
  id: string;
  text?: string;
  why?: string;
  kind?: string;
  author: string;
  reason?: string;
  /** Omitted for same-commit writes; derive it from `Kiln-Operation` in Git history. */
  commit?: string;
  evidence?: DeltaEvidence[];
  runId?: string;
  candidateId?: string;
  evalId?: string;
  championBefore?: string;
  championAfter?: string;
  conflictChecks?: ConflictVerdict[];
}

export interface OperatorApplyResult {
  operationId: string;
  commit?: string;
  section: string;
  id: string;
  championBefore?: string;
  championAfter?: string;
  conflictChecks: ConflictVerdict[];
  idempotent: boolean;
}

export class OperatorApplyError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "OperatorApplyError";
  }
}

interface OperatorIntentResult {
  value: OperatorApplyResult;
  message: string;
  trailers: Record<string, string>;
}

function invalidIntent(detail: string): never { throw new OperatorApplyError("incomplete_operation", detail); }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validConflict(value: unknown): value is ConflictVerdict {
  const held = object(value);
  return typeof held?.conflicts === "boolean" && (typeof held.against === "string" || held.against === null) && typeof held.reason === "string";
}

/** A pending intent is trusted instead of re-buying arbitration, so its internal bindings must be exact. */
function validateOperatorIntent(intent: EvolutionIntent<OperatorIntentResult>, request: OperatorApplyRequest): void {
  const expectedId = operationId(request);
  const paths = intent.transitions.map((item) => item.path);
  if (intent.id !== expectedId || intent.operationId !== expectedId || paths.length !== 2
    || !paths.includes("playbook/playbook.md") || !paths.includes("evolution/deltas.jsonl")) invalidIntent("operator intent has an invalid write scope or request identity");
  const playbook = intent.transitions.find((item) => item.path === "playbook/playbook.md")!;
  const journal = intent.transitions.find((item) => item.path === "evolution/deltas.jsonl")!;
  const result = object(intent.result); const value = object(result?.value); const trailers = object(result?.trailers);
  if (!result || !value || !trailers || typeof result.message !== "string" || !result.message
    || value.operationId !== intent.operationId || value.id !== request.id || value.idempotent !== false || value.commit !== undefined
    || typeof value.section !== "string" || typeof value.championBefore !== "string" || typeof value.championAfter !== "string"
    || !Array.isArray(value.conflictChecks) || !value.conflictChecks.every(validConflict)
    || typeof playbook.before !== "string" || typeof playbook.after !== "string" || typeof journal.after !== "string") {
    invalidIntent("operator intent result is malformed");
  }
  const before = playbookHash(playbook.before); const after = playbookHash(playbook.after);
  const expectedMessage = `evolve(operator): ${request.op} ${request.id} — ${(request.op === "edit" ? request.text! : request.reason).replace(/\s+/g, " ").trim().slice(0, 60)}`;
  const trailerKeys = ["Kiln-Champion-After", "Kiln-Champion-Before", "Kiln-Operation", "Kiln-Operator-Delta"];
  if (value.championBefore !== before || value.championAfter !== after
    || result.message !== expectedMessage || JSON.stringify(Object.keys(trailers).sort()) !== JSON.stringify(trailerKeys)
    || trailers["Kiln-Operation"] !== intent.operationId || trailers["Kiln-Operator-Delta"] !== request.id
    || trailers["Kiln-Champion-Before"] !== before || trailers["Kiln-Champion-After"] !== after) invalidIntent("operator intent hashes or trailers do not match");
  const held = journal.before ?? ""; const prefix = `${held}${held && !held.endsWith("\n") ? "\n" : ""}`;
  if (!journal.after.startsWith(prefix)) invalidIntent("operator intent journal rewrites prior bytes");
  const lines = journal.after.slice(prefix.length).split("\n").filter(Boolean);
  let entry: Record<string, unknown> | undefined;
  try { if (lines.length === 1) entry = object(JSON.parse(lines[0]!)); } catch { /* handled below */ }
  const section = activeTarget(playbook.before, request.id).section;
  const checks = entry?.conflictChecks;
  if (!entry || entry.operationId !== intent.operationId || entry.source !== "operator" || entry.op !== request.op
    || entry.section !== section || value.section !== section || entry.id !== request.id || entry.championBefore !== before || entry.championAfter !== after
    || entry.reason !== request.reason || entry.author !== (request.author ?? "operator") || entry.kind !== (request.kind ?? "correction")
    || !Array.isArray(checks) || !checks.every(validConflict) || JSON.stringify(checks) !== JSON.stringify(value.conflictChecks)) invalidIntent("operator intent journal identity does not match");
  const evidence: DeltaEvidence[] = [{ kind: "metric", ref: request.op === "retire" ? "operator.target.harmful" : "operator.reason" }];
  const delta: PlaybookDelta = { op: request.op, section, id: request.id, text: request.op === "edit" ? request.text! : "",
    ...(request.why === undefined ? {} : { why: request.why }), ...(request.kind === undefined ? {} : { kind: request.kind }), evidence };
  if (JSON.stringify(entry.evidence) !== JSON.stringify(evidence) || entry.text !== (request.op === "edit" ? request.text : undefined)
    || entry.why !== request.why || typeof entry.ts !== "string"
    || applyDelta(playbook.before, delta, { by: request.author ?? "operator", at: entry.ts, resetCounters: true }) !== playbook.after) invalidIntent("operator intent mutation does not match the request");
}

async function completeOperatorIntent(home: string, intent: EvolutionIntent<OperatorIntentResult>, request: OperatorApplyRequest, deps: OperatorApplyDeps): Promise<OperatorApplyResult> {
  validateOperatorIntent(intent, request);
  if (await deps.git.hasTrailer(home, "Kiln-Operation", intent.operationId)) {
    removeIntent(home, "operator", intent.id);
    return { ...intent.result.value, idempotent: true };
  }
  if (await deps.git.revParseHead(home) !== intent.head) throw new OperatorApplyError("incomplete_operation", "HEAD changed while the operator correction was pending");
  const paths = intent.transitions.map((transition) => transition.path);
  applyIntent(home, intent);
  // Retain the intent on any failure, including a lost commit acknowledgement. A retry owns only
  // these two paths; unrelated worktree and index content must never be reset or cleaned.
  const commit = await deps.git.commit(home, { message: intent.result.message, trailers: intent.result.trailers, paths });
  removeIntent(home, "operator", intent.id);
  return { ...intent.result.value, commit };
}

function readModelInput(home: string, first: "playbook" | "prompts", name: string): string {
  const root = realpathSync(home); const parts = [first, name]; let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch { throw new OperatorApplyError("integrity", `${parts.join("/")} must be a real file`); }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new OperatorApplyError("integrity", `${parts.join("/")} must be a real file`);
    }
  }
  return readFileSync(cursor, "utf8");
}

const SECTION_PROMPT: Record<Exclude<PlaybookSectionName, "retired">, "brain" | "generator" | "builder"> = {
  lenses: "generator", frame: "brain", discover: "brain", ideate: "brain", form: "brain", build: "builder",
};

function evalMaterialFiles(home: string): string[] {
  const root = join(home, "evals");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  visit(root, "");
  return out.sort();
}

/** Manifest-less operation is allowed only before any evaluator corpus byte exists. */
function assertManifestOrBootstrap(home: string): void {
  const manifest = join(home, "evals", "manifest.json");
  if (!existsSync(manifest)) {
    const files = evalMaterialFiles(home);
    if (files.length > 0) throw new OperatorApplyError("integrity", `eval manifest is missing for initialized corpus (${files.join(", ")})`);
    return;
  }
  const verification = verifyEvalsManifest(home);
  if (!verification.ok) {
    const details = [
      ...verification.changed.map((file) => `changed:${file}`),
      ...verification.missing.map((file) => `missing:${file}`),
      ...verification.extra.map((file) => `extra:${file}`),
    ];
    throw new OperatorApplyError("integrity", details.join(", ") || "eval manifest is invalid");
  }
}

function operationId(request: OperatorApplyRequest): string {
  return `operator-${hashInput({
    op: request.op, id: request.id, text: request.text ?? null, why: request.why ?? null,
    reason: request.reason, kind: request.kind ?? "correction", author: request.author ?? "operator",
  }).slice(0, 20)}`;
}

function journal(path: string): DeltaJournalEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as DeltaJournalEntry]; } catch { return []; }
  });
}

function activeTarget(playbook: string, id: string): { section: Exclude<PlaybookSectionName, "retired">; bullet: PlaybookBullet } {
  const matches = parsePlaybook(playbook).sections
    .filter((section) => section.name !== "retired")
    .flatMap((section) => section.bullets.filter((bullet) => bullet.id === id).map((bullet) => ({ section: section.name as Exclude<PlaybookSectionName, "retired">, bullet })));
  if (matches.length !== 1) throw new OperatorApplyError("unknown_bullet", `expected one active bullet ${id}, found ${matches.length}`);
  return matches[0]!;
}

function similarity(a: string, b: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const left = tokens(a); const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function proposedText(request: OperatorApplyRequest, target: PlaybookBullet): string {
  if (request.op === "retire") return `Retire ${target.id}: ${target.text} Reason: ${request.reason}`;
  return `${request.text?.trim() ?? ""}${request.why?.trim() ? ` Why: ${request.why.trim()}` : ""}`;
}

async function conflictChecks(
  arbiter: ConflictArbiter,
  proposed: string,
  rolePrompt: string,
  siblings: readonly PlaybookBullet[],
): Promise<ConflictVerdict[]> {
  const against = [
    { kind: "role_prompt" as const, id: null, text: rolePrompt },
    ...siblings.map((bullet) => ({ kind: "sibling" as const, id: bullet.id, text: bullet.text })),
  ];
  const verdicts: ConflictVerdict[] = [];
  for (const item of against) {
    const verdict = await arbiter({ bullet: proposed, against: item.text, againstId: item.id, kind: item.kind });
    if (!validConflict(verdict)) {
      throw new OperatorApplyError("arbiter_invalid", "conflict arbiter returned a malformed verdict");
    }
    verdicts.push(verdict);
  }
  return verdicts;
}

/** Validate, semantically check, journal and commit one ungated operator correction. */
export async function applyOperatorDelta(home: string, request: OperatorApplyRequest, deps: OperatorApplyDeps): Promise<OperatorApplyResult> {
  if (request.op !== "edit" && request.op !== "retire") throw new OperatorApplyError("usage", "operator changes require edit or retire");
  if (!request.id.trim()) throw new OperatorApplyError("usage", "--id must be non-empty");
  if (!request.reason.trim() || /\r|\n/.test(request.reason)) throw new OperatorApplyError("usage", "--reason must be one non-empty line");
  if (request.op === "edit" && request.text === undefined) throw new OperatorApplyError("usage", "edit requires --text");
  assertManifestOrBootstrap(home);
  const lock = acquireEvolveLock(home, { force: request.forceLock });
  try {
    const id = operationId(request);
    const intent = readIntent<OperatorIntentResult>(home, "operator", id);
    if (intent) {
      if (intent.operationId !== id) throw new OperatorApplyError("incomplete_operation", "operator intent does not match the request");
      return completeOperatorIntent(home, intent, request, deps);
    }
    const journalPath = join(home, "evolution", "deltas.jsonl");
    const heldJournal = journal(journalPath);
    const existing = heldJournal.find((entry) => entry.operationId === id);
    if (existing) {
      if (!await deps.git.hasTrailer(home, "Kiln-Operation", id)) throw new OperatorApplyError("incomplete_operation", id);
      return {
        operationId: id, section: existing.section, id: existing.id, conflictChecks: existing.conflictChecks ?? [],
        championBefore: existing.championBefore, championAfter: existing.championAfter, idempotent: true,
      };
    }
    const pending = (["operator", "promote", "rollback"] as const).flatMap((kind) => listIntents(home, kind));
    if (pending.length) throw new OperatorApplyError("incomplete_operation", `finish pending ${pending[0]!.kind} ${pending[0]!.id} before another correction`);
    const dirty = await deps.git.statusPorcelain(home);
    if (dirty.trim()) throw new OperatorApplyError("dirty_tree", dirty.trim());

    const playbookPath = join(home, "playbook", "playbook.md");
    const beforeText = readModelInput(home, "playbook", "playbook.md");
    const before = playbookHash(beforeText);
    const target = activeTarget(beforeText, request.id);
    const metrics = { operator: { reason: request.reason, target: { helpful: target.bullet.helpful, harmful: target.bullet.harmful } } };
    // This run-less command cites the target's actual durable counter rather than manufacturing a
    // scientific result. Zero is still resolvable evidence: operator authority, recorded in
    // `reason`, is allowed to retire conflicting legacy guidance outside the promotion gate.
    const evidence: DeltaEvidence[] = [{ kind: "metric", ref: request.op === "retire" ? "operator.target.harmful" : "operator.reason" }];
    const delta: PlaybookDelta = {
      op: request.op, section: target.section, id: request.id, text: request.op === "edit" ? request.text! : "",
      ...(request.why === undefined ? {} : { why: request.why }),
      ...(request.kind === undefined ? {} : { kind: request.kind }), evidence,
    };
    const rolePrompt = readModelInput(home, "prompts", `${SECTION_PROMPT[target.section]}.md`);
    const validationContext: DeltaContext = {
      digestHeadings: [], runDir: home, metrics, playbook: beforeText,
      kernel: readModelInput(home, "prompts", "kernel.md"), rolePrompt,
    };
    const validation = validateDelta(delta, validationContext);
    if (!validation.ok) throw new OperatorApplyError(validation.reason);

    const siblings = parsePlaybook(beforeText).sections.find((section) => section.name === target.section)!.bullets
      .filter((bullet) => bullet.id !== target.bullet.id)
      .map((bullet) => ({ bullet, score: similarity(proposedText(request, target.bullet), bullet.text) }))
      .sort((a, b) => b.score - a.score || a.bullet.id.localeCompare(b.bullet.id)).slice(0, 5).map((item) => item.bullet);
    const checks = await conflictChecks(deps.arbiter, proposedText(request, target.bullet), rolePrompt, siblings);
    const conflictIndex = checks.findIndex((verdict) => verdict.conflicts);
    if (conflictIndex >= 0) {
      const conflict = checks[conflictIndex]!;
      throw new OperatorApplyError(conflictIndex === 0 ? "conflicting_prompt" : "conflicting_bullet", conflict.reason);
    }

    const at = (deps.now ?? (() => new Date()))().toISOString();
    const afterText = applyDelta(beforeText, delta, { by: request.author ?? "operator", at, resetCounters: true });
    const after = playbookHash(afterText);
    const entry: DeltaJournalEntry = {
      seq: Math.max(0, ...heldJournal.map((item) => Number.isInteger(item.seq) ? item.seq : 0)) + 1,
      ts: at, operationId: id, source: "operator", op: request.op, section: target.section, id: request.id,
      ...(request.op === "edit" ? { text: request.text } : {}), ...(request.why === undefined ? {} : { why: request.why }),
      kind: request.kind ?? "correction", author: request.author ?? "operator", reason: request.reason, evidence,
      championBefore: before, championAfter: after, conflictChecks: checks,
    };
    const originalHead = await deps.git.revParseHead(home);
    const journalBefore = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : null;
    const summary = (request.op === "edit" ? request.text! : request.reason).replace(/\s+/g, " ").trim().slice(0, 60);
    const prepared: EvolutionIntent<OperatorIntentResult> = {
      version: 1, kind: "operator", id, operationId: id, head: originalHead,
      transitions: [
        { path: "playbook/playbook.md", before: beforeText, after: afterText },
        { path: "evolution/deltas.jsonl", before: journalBefore, after: `${journalBefore ?? ""}${journalBefore && !journalBefore.endsWith("\n") ? "\n" : ""}${JSON.stringify(entry)}\n` },
      ],
      result: {
        value: { operationId: id, section: target.section, id: request.id, championBefore: before, championAfter: after, conflictChecks: checks, idempotent: false },
        message: `evolve(operator): ${request.op} ${request.id} — ${summary}`,
        trailers: { "Kiln-Operator-Delta": request.id, "Kiln-Operation": id, "Kiln-Champion-Before": before, "Kiln-Champion-After": after },
      },
    };
    writeIntent(home, prepared);
    return completeOperatorIntent(home, prepared, request, deps);
  } finally {
    lock.release();
  }
}
