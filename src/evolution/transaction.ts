import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeAtomic } from "../core/paths";
import { hashInput } from "../core/record";

export type TransactionKind = "operator" | "promote" | "rollback";

export interface FileTransition {
  /** Repository-relative path under playbook/, prompts/, or evolution/. */
  path: string;
  /** Equal non-null values form a byte assertion without a mutation. */
  before: string | null;
  after: string | null;
}

export interface EvolutionIntent<TResult = unknown> {
  version: 1;
  kind: TransactionKind;
  id: string;
  operationId: string;
  head: string;
  transitions: FileTransition[];
  result: TResult;
}

export class EvolutionTransactionError extends Error {
  constructor(readonly reason: "invalid_intent" | "transaction_exists" | "transaction_conflict", detail: string) {
    super(`${reason}: ${detail}`); this.name = "EvolutionTransactionError";
  }
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
}

function safeRelative(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\\")) return false;
  const parts = path.split("/");
  return !parts.some((part) => part === "" || part === ".." || part === ".")
    && ["playbook", "prompts", "evolution"].includes(parts[0] ?? "");
}

function intentFile(home: string, kind: TransactionKind, id: string): string {
  if (!safeId(id)) throw new EvolutionTransactionError("invalid_intent", `unsafe transaction id ${id}`);
  return filePath(home, `evolution/work/transactions/${kind}-${hashInput(id).slice(0, 20)}.json`);
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function filePath(home: string, path: string): string {
  if (!safeRelative(path)) throw new EvolutionTransactionError("invalid_intent", `unsafe transition path ${path}`);
  const root = resolve(home); const target = resolve(home, path); const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new EvolutionTransactionError("invalid_intent", `escaping transition path ${path}`);
  let cursor = root;
  for (const part of path.split("/").slice(0, -1)) {
    cursor = join(cursor, part);
    const held = stat(cursor);
    if (!held) break;
    if (!held.isDirectory() || held.isSymbolicLink()) throw new EvolutionTransactionError("transaction_conflict", `${path} has an unsafe ancestor`);
  }
  const leaf = stat(target);
  if (leaf && (!leaf.isFile() || leaf.isSymbolicLink())) {
    throw new EvolutionTransactionError("transaction_conflict", `${path} is not a real file`);
  }
  return target;
}

function current(home: string, transition: FileTransition): string | null {
  const path = filePath(home, transition.path);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function parseIntent<TResult>(value: unknown, kind: TransactionKind, id: string): EvolutionIntent<TResult> {
  if (!jsonValue(value)) throw new EvolutionTransactionError("invalid_intent", "intent must contain only finite JSON values");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvolutionTransactionError("invalid_intent", "intent must be an object");
  const raw = value as Partial<EvolutionIntent<TResult>>;
  if (raw.version !== 1 || raw.kind !== kind || raw.id !== id || typeof raw.operationId !== "string" || !raw.operationId
    || typeof raw.head !== "string" || !/^[0-9a-f]{40,64}$/i.test(raw.head) || !Array.isArray(raw.transitions)) {
    throw new EvolutionTransactionError("invalid_intent", "intent envelope is malformed");
  }
  const seen = new Set<string>();
  for (const item of raw.transitions) {
    if (!item || typeof item !== "object" || !safeRelative(item.path) || seen.has(item.path)
      || !(item.before === null || typeof item.before === "string") || !(item.after === null || typeof item.after === "string")
      || (item.before === null && item.after === null)) throw new EvolutionTransactionError("invalid_intent", "intent transitions are malformed");
    seen.add(item.path);
  }
  const paths = [...seen].sort();
  for (let index = 1; index < paths.length; index++) {
    if (paths[index]!.startsWith(`${paths[index - 1]!}/`)) {
      throw new EvolutionTransactionError("invalid_intent", "intent paths must not contain one another");
    }
  }
  if (!("result" in raw)) throw new EvolutionTransactionError("invalid_intent", "intent result is missing");
  return raw as EvolutionIntent<TResult>;
}

function jsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value as object)) return false;
  seen.add(value as object);
  let valid: boolean;
  if (Array.isArray(value)) valid = value.every((item) => jsonValue(item, seen));
  else {
    const prototype = Object.getPrototypeOf(value);
    valid = (prototype === Object.prototype || prototype === null)
      && Object.values(value as Record<string, unknown>).every((item) => jsonValue(item, seen));
  }
  seen.delete(value as object);
  return valid;
}

function renderIntent<TResult>(intent: EvolutionIntent<TResult>): string {
  const checked = parseIntent<TResult>(intent, intent.kind, intent.id);
  return `${JSON.stringify(checked, null, 2)}\n`;
}

export function readIntent<TResult>(home: string, kind: TransactionKind, id: string): EvolutionIntent<TResult> | undefined {
  const path = intentFile(home, kind, id);
  if (!existsSync(path)) return undefined;
  try { return parseIntent<TResult>(JSON.parse(readFileSync(path, "utf8")), kind, id); }
  catch (error) {
    if (error instanceof EvolutionTransactionError) throw error;
    throw new EvolutionTransactionError("invalid_intent", error instanceof Error ? error.message : String(error));
  }
}

/** Discover durable recovery work without trusting filenames or following links. */
export function listIntents<TResult>(home: string, kind: TransactionKind): EvolutionIntent<TResult>[] {
  const dir = join(home, "evolution", "work", "transactions");
  const held = stat(dir);
  if (!held) return [];
  if (!held.isDirectory() || held.isSymbolicLink()) throw new EvolutionTransactionError("invalid_intent", "transaction directory is unsafe");
  const intents: EvolutionIntent<TResult>[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((item) => item.name.startsWith(`${kind}-`))) {
    const temporary = new RegExp(`^${kind}-[a-f0-9]{20}\\.json\\.(\\d+)\\.\\d+\\.tmp$`).exec(entry.name);
    if (temporary) {
      if (entry.isFile() && !entry.isSymbolicLink()) {
        if (!pidAlive(Number(temporary[1]))) unlinkSync(join(dir, entry.name));
      }
      else throw new EvolutionTransactionError("invalid_intent", `unsafe temporary intent ${entry.name}`);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new EvolutionTransactionError("invalid_intent", `unsafe intent entry ${entry.name}`);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, entry.name), "utf8")); }
    catch (error) { throw new EvolutionTransactionError("invalid_intent", error instanceof Error ? error.message : String(error)); }
    const id = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
    if (typeof id !== "string") throw new EvolutionTransactionError("invalid_intent", `intent ${entry.name} has no id`);
    const intent = parseIntent<TResult>(raw, kind, id);
    if (join(dir, entry.name) !== intentFile(home, kind, intent.id)) throw new EvolutionTransactionError("invalid_intent", `intent filename mismatch for ${intent.id}`);
    intents.push(intent);
  }
  return intents.sort((a, b) => a.id.localeCompare(b.id));
}

export function writeIntent<TResult>(home: string, intent: EvolutionIntent<TResult>): string {
  const path = intentFile(home, intent.kind, intent.id); const rendered = renderIntent(intent);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === rendered) return path;
    throw new EvolutionTransactionError("transaction_exists", `${intent.kind} ${intent.id}`);
  }
  writeAtomic(path, rendered, { mode: 0o600 }); return path;
}

/** Replace one phase with the next only while the exact durable predecessor remains authoritative. */
export function replaceIntent<TResult>(home: string, before: EvolutionIntent, next: EvolutionIntent<TResult>): string {
  if (before.kind !== next.kind || before.id !== next.id || before.operationId !== next.operationId || before.head !== next.head) {
    throw new EvolutionTransactionError("invalid_intent", "replacement changes transaction identity");
  }
  const path = intentFile(home, before.kind, before.id); const expected = renderIntent(before); const rendered = renderIntent(next);
  if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
    throw new EvolutionTransactionError("transaction_conflict", "durable intent differs from the expected phase");
  }
  writeAtomic(path, rendered, { mode: 0o600 }); return path;
}

/** Validate every operation-derived path before a caller begins a non-idempotent external step. */
export function assertTransactionPaths(home: string, paths: readonly string[]): void {
  for (const path of paths) filePath(home, path);
}

/** Remove only dead-writer atomic temp files for this intent's exact owned targets. */
export function cleanupIntentArtifacts(home: string, intent: EvolutionIntent): void {
  assertTransactionPaths(home, intent.transitions.map((item) => item.path));
  for (const item of intent.transitions) {
    const target = filePath(home, item.path); const dir = join(target, "..");
    const held = stat(dir); if (!held || !held.isDirectory() || held.isSymbolicLink()) continue;
    const name = target.slice(dir.length + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${name}\\.(\\d+)\\.\\d+\\.tmp$`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const match = pattern.exec(entry.name); if (!match) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new EvolutionTransactionError("transaction_conflict", `unsafe temporary file for ${item.path}`);
      if (!pidAlive(Number(match[1]))) unlinkSync(join(dir, entry.name));
    }
  }
}

function validateState(home: string, transitions: readonly FileTransition[]): void {
  for (const item of transitions) {
    const held = current(home, item);
    if (held !== item.before && held !== item.after) {
      throw new EvolutionTransactionError("transaction_conflict", `${item.path} differs from both transaction states`);
    }
  }
}

function set(home: string, transition: FileTransition, value: string | null): void {
  const path = filePath(home, transition.path);
  if (value === null) {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } else {
    writeAtomic(path, value);
  }
}

/** Idempotently reach the intended state, refusing before any write if an owned byte diverged. */
export function applyIntent(home: string, intent: EvolutionIntent): void {
  validateState(home, intent.transitions);
  for (const item of intent.transitions) if (item.before !== item.after && current(home, item) === item.before) set(home, item, item.after);
}

/** Restore only exact owned bytes; unrelated files and Git state are never inspected or changed. */
export function rollbackIntent(home: string, intent: EvolutionIntent): void {
  validateState(home, intent.transitions);
  for (const item of [...intent.transitions].reverse()) if (item.before !== item.after && current(home, item) === item.after) set(home, item, item.before);
}

export function removeIntent(home: string, kind: TransactionKind, id: string): void {
  const path = intentFile(home, kind, id);
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Clean only empty directories owned by the transaction subsystem.
  for (const dir of [join(home, "evolution", "work", "transactions")]) {
    try { rmdirSync(dir); } catch {}
  }
}
