import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputeMonitor, readComputeMonitor, type ComputeNotice } from "../../src/operator/compute-monitor";
import type { OperatorMeterRow, OperatorMeterSnapshot } from "../../src/operator/meter";
function fixture(run: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(), "kiln-compute-")); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
const row = (id: number, patch: Partial<OperatorMeterRow> = {}): OperatorMeterRow => ({ id, sessionId: "s", lane: "sdk", provider: "mock", model: "m", reservedUsd: 3, chargedUsd: 3, state: "reserved", ...patch });
const usage = (rows: OperatorMeterRow[]): OperatorMeterSnapshot => ({ version: 1, runId: "r", limitUsd: 100, chargedUsd: 0, knownCostUsd: 0, coverage: "estimated-exposure-not-invoice-ceiling", gaps: [], rows, seenMaintenance: [] });
test("failure loops stay per session, warn then pause, with no payload persistence", () => fixture(dir => {
  const notices: ComputeNotice[] = []; const m = createComputeMonitor({ runId: "r", dir, onNotice: n => notices.push(n) });
  for (let i = 0; i < 6; i++) { m.observeTool({ sessionId: "secret-session", name: "bash", args: { token: "private-key" }, result: "private-error", ok: false }); m.observeTool({ sessionId: "other", name: "read", args: i, result: i, ok: true }); }
  expect(notices.map(n => n.severity)).toEqual(["warning", "pause"]);
  expect(notices[1]!.sessionId).toBe("secret-session");
  const stored = readFileSync(join(dir, "compute-monitor.json"), "utf8");
  for (const secret of ["secret-session", "private-key", "private-error", '"bash"']) expect(stored).not.toContain(secret);
  expect(statSync(join(dir, "compute-monitor.json")).mode & 0o777).toBe(0o600);
  expect(m.snapshot().totals).toMatchObject({ toolCalls: 12, failedTools: 6, exactRepeats: 5 });
}));
test("changed results and new turns reset streaks without resetting historical counts", () => fixture(dir => {
  const notices: ComputeNotice[] = []; const m = createComputeMonitor({ runId: "r", dir, onNotice: n => notices.push(n) });
  const observe = (result = "x") => m.observeTool({ sessionId: "s", name: "read", args: {}, result, ok: true });
  for (let i = 0; i < 7; i++) observe(); observe("changed"); observe();
  expect(notices.some(n => n.severity === "pause")).toBe(false);
  m.beginTurn(); for (let i = 0; i < 8; i++) observe();
  expect(notices.at(-1)!.severity).toBe("pause");
  expect(m.snapshot().totals.toolCalls).toBe(17);
  const resumed = createComputeMonitor({ runId: "r", dir }); expect(resumed.snapshot()).toEqual(m.snapshot());
  const copy = resumed.snapshot(); copy.totals.toolCalls = 0; expect(resumed.snapshot().totals.toolCalls).toBe(17);
}));
test("legitimate polling never pauses from unchanged output", () => fixture(dir => {
  const notices: ComputeNotice[] = []; const m = createComputeMonitor({ runId: "r", dir, onNotice: n => notices.push(n) });
  for (let i = 0; i < 12; i++) m.observeTool({ sessionId: "s", name: "poll_status", args: {}, result: "waiting", ok: true });
  expect(notices.length).toBe(2); expect(notices.every(n => n.severity === "warning")).toBe(true);
}));
test("meter snapshots replace aggregates, separate cache counters and unknown exposure", () => fixture(dir => {
  const m = createComputeMonitor({ runId: "r", dir }); m.observeUsage(usage([row(1)])); m.observeUsage(usage([row(1)]));
  expect(m.snapshot().usage.reservedUsd).toBe(3);
  const rows = [row(1, { state: "settled", chargedUsd: 1, costUsd: 1, usage: { input: 10, output: 3, cacheRead: 5, cacheWrite: 2, totalTokens: 13 } }), row(2, { state: "unknown", costUsd: 0.5 })];
  m.observeUsage(usage(rows)); m.observeUsage(usage(rows));
  expect(m.snapshot().usage).toMatchObject({ rows: 2, input: 10, output: 3, cacheRead: 5, cacheWrite: 2, reportedTotalTokens: 13, knownCostUsd: 1.5, reservedUsd: 0, unknownExposureUsd: 2.5 });
  expect(() => m.observeUsage(usage([rows[0]!, rows[0]!]))).toThrow();
  expect(() => m.observeUsage(usage([]))).toThrow();
  expect(m.snapshot().usage.rows).toBe(2);
}));
test("context growth advisories fire once per new observation and never pause", () => fixture(dir => {
  const notices: ComputeNotice[] = []; const m = createComputeMonitor({ runId: "r", dir, onNotice: n => notices.push(n) });
  const rows: OperatorMeterRow[] = [];
  for (let id = 1; id <= 4; id++) { rows.push(row(id, { payloadBytes: 100 * 2 ** id })); m.observeUsage(usage(rows)); m.observeUsage(usage(rows)); }
  expect(notices.map(n => [n.kind, n.severity])).toEqual([["context_growth", "warning"]]);
}));
// Exercise real persistence for 1,080 observations; this checks retention, not disk speed.
test("bounds session history and notice history", () => fixture(dir => {
  const m = createComputeMonitor({ runId: "r", dir });
  for (let id = 0; id < 270; id++) for (let n = 0; n < 4; n++) m.observeTool({ sessionId: String(id), name: "read", args: null, result: null, ok: true });
  expect(m.snapshot().sessions).toHaveLength(256); expect(m.snapshot().notices).toHaveLength(64);
  expect(m.snapshot().totals.evictedSessions).toBe(14);
}), 20_000);
test("malformed restored state, wrong run and getters fail closed", () => fixture(dir => {
  const m = createComputeMonitor({ runId: "r", dir }); m.beginTurn();
  expect(() => createComputeMonitor({ runId: "other", dir })).toThrow();
  let invoked = false; m.observeTool({ sessionId: "s", name: "read", args: { get secret() { invoked = true; return "secret"; } }, result: null, ok: true });
  expect(invoked).toBe(false);
  const raw = m.snapshot() as unknown as Record<string, unknown>; raw.rawPayload = "secret";
  writeFileSync(join(dir, "compute-monitor.json"), JSON.stringify(raw));
  expect(() => createComputeMonitor({ runId: "r", dir })).toThrow();
}));
test("unsupported observations reset streaks with one bounded warning and later valid loops still pause", () => fixture(dir => {
  const notices: ComputeNotice[] = []; const m = createComputeMonitor({ runId: "r", dir, onNotice: n => notices.push(n) });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let accessed = false;
  const values = ["x".repeat(4000001), cyclic, { get secret() { accessed = true; return "secret"; } }, new Date()];
  const good = () => m.observeTool({ sessionId: "s", name: "read", args: {}, result: "same", ok: false });
  for (const value of values) { for (let i = 0; i < 5; i++) good(); m.observeTool({ sessionId: "s", name: "read", args: {}, result: value, ok: false }); }
  expect(accessed).toBe(false);
  expect(notices.filter(n => n.kind === "fingerprint_unavailable")).toHaveLength(1);
  expect(notices.some(n => n.severity === "pause")).toBe(false);
  expect(m.snapshot().totals).toMatchObject({ toolCalls: 24, failedTools: 24 });
  for (let i = 0; i < 6; i++) good();
  expect(notices.at(-1)!.severity).toBe("pause");
  m.beginTurn(); m.observeTool({ sessionId: "s", name: "read", args: cyclic, result: undefined, ok: true });
  expect(notices.filter(n => n.kind === "fingerprint_unavailable")).toHaveLength(2);
  expect(readFileSync(join(dir, "compute-monitor.json"), "utf8")).not.toContain("secret");
}));
test("read helper is nonmutating and rejects dangling symlinks rather than resetting", () => fixture(dir => {
  expect(readComputeMonitor({ runId: "r", dir })).toBeUndefined();
  symlinkSync(join(dir, "missing"), join(dir, "compute-monitor.json"));
  expect(() => readComputeMonitor({ runId: "r", dir })).toThrow();
  expect(() => createComputeMonitor({ runId: "r", dir })).toThrow();
}));
test("undefined and string payloads cannot collide into an exact loop", () => fixture(dir => {
  const notices: ComputeNotice[] = []; const m = createComputeMonitor({ runId: "r", dir, onNotice: n => notices.push(n) });
  for (let i = 0; i < 10; i++) m.observeTool({ sessionId: "s", name: "read", args: i % 2 ? undefined : "<undefined>", result: null, ok: false });
  expect(notices).toHaveLength(0); expect(m.snapshot().totals.exactRepeats).toBe(0);
}));
