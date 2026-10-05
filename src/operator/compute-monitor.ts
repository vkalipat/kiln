import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../core/paths";
import type { OperatorMeterSnapshot, OperatorMeterRow, OperatorMeterChange } from "./meter";

export interface ComputeNotice {
  kind: "repeated_failure" | "repeated_tool" | "context_growth" | "session_capacity" | "fingerprint_unavailable";
  severity: "warning" | "pause";
  message: string;
  sessionId?: string;
}
type Session = { id: string; signature: string; result: string; repeats: number; failures: number; calls: number; contextBytes: number; contextRow: number; growth: number };
type Totals = { toolCalls: number; failedTools: number; exactRepeats: number; evictedSessions: number };
type Usage = { rows: number; lastRow: number; input: number; output: number; cacheRead: number; cacheWrite: number; reportedTotalTokens: number; knownCostUsd: number; reservedUsd: number; unknownExposureUsd: number; rowsWithoutUsage: number };
export interface ComputeSnapshot {
  version: 1; runHash: string; turn: number; totals: Totals; usage: Usage;
  sessions: Session[];
  notices: { kind: ComputeNotice["kind"]; severity: ComputeNotice["severity"]; turn: number; sessionHash?: string }[];
}
export type ComputeMonitorSnapshot = ComputeSnapshot;
export const COMPUTE_MONITOR_FILENAME = "compute-monitor.json";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const numeric = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const count = (n: unknown): n is number => numeric(n) && Number.isSafeInteger(n);
function fail(): never { throw new Error("Invalid compute monitor state or observation"); }
function keys(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail();
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512) fail();
}
/** Deterministic bounded hashing; rejects accessors/cycles instead of calling user toJSON. */
function fingerprint(value: unknown): string {
  const active = new Set<object>(); let nodes = 0; let chars = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 50000 || depth > 32) fail();
    if (item === undefined) return "undefined:";
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(); return JSON.stringify(item); }
    if (typeof item === "string") { chars += item.length; if (chars > 4000000) fail(); return JSON.stringify(item); }
    if (!item || typeof item !== "object" || active.has(item) || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) || Object.getOwnPropertySymbols(item).length) fail();
    active.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const entries = Object.keys(descriptors).filter(k => !(Array.isArray(item) && k === "length")).sort();
    const output = entries.map(k => { chars += k.length; if (chars > 4000000) fail(); const d = descriptors[k]!; if (!("value" in d) || !d.enumerable) fail(); return JSON.stringify(k) + ":" + visit(d.value, depth + 1); });
    active.delete(item);
    return (Array.isArray(item) ? `array:${item.length}:` : "object:") + "{" + output.join(",") + "}";
  };
  return hash(visit(value, 0));
}
const usageKeys = ["rows", "lastRow", "input", "output", "cacheRead", "cacheWrite", "reportedTotalTokens", "knownCostUsd", "reservedUsd", "unknownExposureUsd", "rowsWithoutUsage"];
const sessionKeys = ["id", "signature", "result", "repeats", "failures", "calls", "contextBytes", "contextRow", "growth"];
const kinds = ["repeated_failure", "repeated_tool", "context_growth", "session_capacity", "fingerprint_unavailable"];
function validate(raw: unknown, runHash: string): asserts raw is ComputeSnapshot {
  keys(raw, ["version", "runHash", "turn", "totals", "usage", "sessions", "notices"]);
  if (raw.version !== 1 || raw.runHash !== runHash || !count(raw.turn)) fail();
  keys(raw.totals, ["toolCalls", "failedTools", "exactRepeats", "evictedSessions"]);
  if (Object.values(raw.totals).some(n => !count(n))) fail();
  keys(raw.usage, usageKeys);
  if (Object.entries(raw.usage).some(([k, v]) => k.endsWith("Usd") ? !numeric(v) : !count(v))) fail();
  if (!Array.isArray(raw.sessions) || raw.sessions.length > 256 || !Array.isArray(raw.notices) || raw.notices.length > 64) fail();
  const seen = new Set<string>();
  for (const s of raw.sessions) {
    keys(s, sessionKeys);
    if (![s.id, s.signature, s.result].every(v => typeof v === "string" && (v === "" || digest.test(v))) || !s.id || seen.has(s.id as string)) fail();
    if (sessionKeys.slice(3).some(k => !count(s[k]))) fail();
    if ((s.failures as number) > (s.repeats as number) || (s.repeats as number) > (s.calls as number)) fail();
    seen.add(s.id as string);
  }
  for (const n of raw.notices) {
    if (!n || typeof n !== "object") fail();
    keys(n, ["kind", "severity", "turn", ...(Object.hasOwn(n, "sessionHash") ? ["sessionHash"] : [])]);
    if (!kinds.includes(n.kind as string) || !["warning", "pause"].includes(n.severity as string) || !count(n.turn) || n.turn > raw.turn || (n.sessionHash !== undefined && (typeof n.sessionHash !== "string" || !digest.test(n.sessionHash)))) fail();
  }
}

export function readComputeMonitor(options: { runId: string; dir: string }): ComputeMonitorSnapshot | undefined {
  identity(options.runId);
  const path = join(options.dir, COMPUTE_MONITOR_FILENAME);
  try { if (!lstatSync(path).isFile()) fail(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 262144) fail();
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8")); validate(parsed, hash(options.runId)); return parsed;
  } finally { closeSync(fd); }
}

export function createComputeMonitor(options: { runId: string; dir: string; onNotice?: (notice: ComputeNotice) => void }) {
  identity(options.runId);
  const runHash = hash(options.runId), path = join(options.dir, COMPUTE_MONITOR_FILENAME);
  let state: ComputeSnapshot = { version: 1, runHash, turn: 0,
    totals: { toolCalls: 0, failedTools: 0, exactRepeats: 0, evictedSessions: 0 },
    usage: { rows: 0, lastRow: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedTotalTokens: 0, knownCostUsd: 0, reservedUsd: 0, unknownExposureUsd: 0, rowsWithoutUsage: 0 }, sessions: [], notices: [] };
  state = readComputeMonitor(options) ?? state;
  // Ephemeral warning suppression; never retain payloads or unbounded session identities.
  const fingerprintWarnings = new Set<string>(state.notices.filter(n => n.kind === "fingerprint_unavailable" && n.turn === state.turn && n.sessionHash).map(n => n.sessionHash!));
  const persist = () => { validate(state, runHash); writeAtomic(path, JSON.stringify(state), { mode: 0o600 }); };
  const emit = (notice: ComputeNotice) => {
    state.notices.push({ kind: notice.kind, severity: notice.severity, turn: state.turn, ...(notice.sessionId ? { sessionHash: hash(notice.sessionId) } : {}) });
    state.notices = state.notices.slice(-64); persist(); options.onNotice?.(notice);
  };
  const session = (id: string) => {
    const key = hash(id); let entry = state.sessions.find(s => s.id === key);
    if (!entry) {
      if (state.sessions.length === 256) { state.sessions.shift(); state.totals.evictedSessions++; }
      entry = { id: key, signature: "", result: "", repeats: 0, failures: 0, calls: 0, contextBytes: 0, contextRow: 0, growth: 0 }; state.sessions.push(entry);
    }
    return entry;
  };
  return {
    beginTurn() {
      state.turn++;
      fingerprintWarnings.clear();
      for (const s of state.sessions) { s.signature = ""; s.result = ""; s.repeats = 0; s.failures = 0; s.growth = 0; s.contextBytes = 0; }
      persist();
    },
    observeTool(input: { sessionId: string; name: string; args: unknown; result: unknown; ok: boolean; polling?: boolean }) {
      identity(input.sessionId); identity(input.name); if (typeof input.ok !== "boolean" || (input.polling !== undefined && typeof input.polling !== "boolean")) fail();
      const s = session(input.sessionId);
      s.calls++; state.totals.toolCalls++; if (!input.ok) state.totals.failedTools++;
      let signature: string, result: string;
      try { signature = fingerprint({ name: input.name, args: input.args }); result = fingerprint(input.result); }
      catch {
        s.signature = ""; s.result = ""; s.repeats = 0; s.failures = 0;
        persist();
        if (!fingerprintWarnings.has(s.id)) {
          if (fingerprintWarnings.size >= 256) fingerprintWarnings.delete(fingerprintWarnings.values().next().value!);
          fingerprintWarnings.add(s.id);
          emit({ kind: "fingerprint_unavailable", severity: "warning", sessionId: input.sessionId, message: "Tool observation exceeded safe fingerprint limits or used an unsupported value; repetition coverage is incomplete and the streak was reset." });
        }
        return;
      }
      const same = s.signature === signature && s.result === result;
      if (same) state.totals.exactRepeats++;
      s.repeats = same ? s.repeats + 1 : 1;
      s.failures = !input.ok ? (same ? s.failures + 1 : 1) : 0;
      s.signature = signature; s.result = result;
      const polling = input.polling === true || /(?:^|_)(?:wait|poll|watch|status)(?:_|$)/i.test(input.name);
      persist();
      if (!input.ok && (s.failures === 3 || s.failures === 6)) emit({ kind: "repeated_failure", severity: s.failures === 6 && !polling ? "pause" : "warning", sessionId: input.sessionId, message: polling ? "Repeated identical polling failures; inspect the wait condition." : s.failures === 6 ? "Six identical tool failures in one session; pause to inspect the loop." : "Three identical tool failures in one session; no changed result observed." });
      else if (input.ok && (s.repeats === 4 || s.repeats === 8)) emit({ kind: "repeated_tool", severity: s.repeats === 8 && !polling ? "pause" : "warning", sessionId: input.sessionId, message: polling ? "Repeated unchanged polling results; progress remains unproven." : s.repeats === 8 ? "Eight identical tool calls and results in one session; pause to inspect the loop." : "Repeated identical tool calls and results; success does not establish task progress." });
    },
    observeUsage(snapshot: OperatorMeterSnapshot) {
      if (snapshot.version !== 1 || snapshot.runId !== options.runId || !Array.isArray(snapshot.rows)) fail();
      const next: Usage = { rows: snapshot.rows.length, lastRow: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedTotalTokens: 0, knownCostUsd: 0, reservedUsd: 0, unknownExposureUsd: 0, rowsWithoutUsage: 0 };
      const seen = new Set<number>(); const context = new Map<string, { row: number; bytes: number }>();
      for (const row of snapshot.rows) {
        if (!count(row.id) || seen.has(row.id) || !numeric(row.reservedUsd) || !numeric(row.chargedUsd) || !["reserved", "settled", "unknown"].includes(row.state)) fail();
        identity(row.sessionId); seen.add(row.id); next.lastRow = Math.max(next.lastRow, row.id);
        if (row.costUsd !== undefined) { if (!numeric(row.costUsd)) fail(); next.knownCostUsd += row.costUsd; }
        if (row.state === "reserved") next.reservedUsd += row.chargedUsd;
        if (row.state === "unknown") next.unknownExposureUsd += Math.max(0, row.chargedUsd - (row.costUsd ?? 0));
        if (row.usage) {
          for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) if (!count(row.usage[k])) fail();
          next.input += row.usage.input; next.output += row.usage.output; next.cacheRead += row.usage.cacheRead; next.cacheWrite += row.usage.cacheWrite; next.reportedTotalTokens += row.usage.totalTokens;
        } else next.rowsWithoutUsage++;
        if (row.payloadBytes !== undefined) {
          if (!count(row.payloadBytes)) fail();
          if (row.id > (context.get(row.sessionId)?.row ?? -1)) context.set(row.sessionId, { row: row.id, bytes: row.payloadBytes });
        }
      }
      if (next.rows < state.usage.rows || next.lastRow < state.usage.lastRow) fail();
      const notices: ComputeNotice[] = [];
      for (const [id, current] of context) {
        const s = session(id); if (current.row <= s.contextRow) continue;
        s.growth = s.contextBytes > 0 && current.bytes >= s.contextBytes * 1.5 ? s.growth + 1 : 0;
        s.contextBytes = current.bytes; s.contextRow = current.row;
        if (s.growth === 3) notices.push({ kind: "context_growth", severity: "warning", sessionId: id, message: "Serialized request context grew at least 50% across three observations; inspect context reuse. This is not a tokenizer count." });
      }
      state.usage = next; persist(); for (const notice of notices) emit(notice);
    },
    observeUsageDelta(summary: Omit<OperatorMeterSnapshot, "rows">, changes: readonly OperatorMeterChange[], initial = false) {
      if (summary.version !== 1 || summary.runId !== options.runId) fail();
      const next: Usage = initial ? { rows: 0, lastRow: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedTotalTokens: 0,
        knownCostUsd: 0, reservedUsd: 0, unknownExposureUsd: 0, rowsWithoutUsage: 0 } : { ...state.usage };
      const contribution = (row: OperatorMeterRow, sign: number) => {
        identity(row.sessionId);
        if (!count(row.id) || !numeric(row.reservedUsd) || !numeric(row.chargedUsd) || !["reserved", "settled", "unknown"].includes(row.state)) fail();
        if (row.costUsd !== undefined) { if (!numeric(row.costUsd)) fail(); next.knownCostUsd += sign * row.costUsd; }
        if (row.state === "reserved") next.reservedUsd += sign * row.chargedUsd;
        if (row.state === "unknown") next.unknownExposureUsd += sign * Math.max(0, row.chargedUsd - (row.costUsd ?? 0));
        if (row.usage) {
          for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) if (!count(row.usage[k])) fail();
          next.input += sign * row.usage.input; next.output += sign * row.usage.output;
          next.cacheRead += sign * row.usage.cacheRead; next.cacheWrite += sign * row.usage.cacheWrite;
          next.reportedTotalTokens += sign * row.usage.totalTokens;
        } else next.rowsWithoutUsage += sign;
      };
      const notices: ComputeNotice[] = [];
      const seen = new Set<number>();
      for (const { row, previous } of changes) {
        if (seen.has(row.id)) fail(); seen.add(row.id);
        if (previous) { if (initial || previous.id !== row.id || row.id > next.lastRow) fail(); contribution(previous, -1); }
        else { if (row.id !== next.lastRow + 1) fail(); next.lastRow = row.id; next.rows++; }
        contribution(row, 1);
        if (row.payloadBytes !== undefined && !count(row.payloadBytes)) fail();
      }
      for (const [key, value] of Object.entries(next)) {
        if (key.endsWith("Usd") && value < 0 && value > -1e-8) (next as unknown as Record<string, number>)[key] = 0;
        else if (key.endsWith("Usd") ? !numeric(value) : !count(value)) fail();
      }
      // Validate the entire batch before changing session history or aggregates.
      for (const { row } of changes) {
        if (row.payloadBytes !== undefined) {
          const s = session(row.sessionId);
          if (row.id > s.contextRow) {
            s.growth = s.contextBytes > 0 && row.payloadBytes >= s.contextBytes * 1.5 ? s.growth + 1 : 0;
            s.contextBytes = row.payloadBytes; s.contextRow = row.id;
            if (s.growth === 3) notices.push({ kind: "context_growth", severity: "warning", sessionId: row.sessionId,
              message: "Serialized request context grew at least 50% across three observations; inspect context reuse. This is not a tokenizer count." });
          }
        }
      }
      state.usage = next; persist(); for (const notice of notices) emit(notice);
    },
    snapshot(): ComputeSnapshot { return structuredClone(state); },
  };
}
