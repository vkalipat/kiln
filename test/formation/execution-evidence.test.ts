import { expect, test } from "bun:test";
import type { StoredEvent } from "../../src/core/events";
import { formationExecutionEvidence } from "../../src/formation/execution-evidence";

function execution(seq: number, extra = {}): StoredEvent {
  return { t: "tool.call", seq, ts: "2026-09-09T00:00:00Z", name: "bash", args: { command: "python3 check.py" },
    ok: true, durationMs: 5, excerpt: "exit 7\nfailed", ...extra } as StoredEvent;
}

test("execution evidence preserves process failure and marks legacy completeness unknown", () => {
  const evidence = JSON.parse(formationExecutionEvidence([
    execution(1), execution(2, { resultChars: 2000, excerptTruncated: true, process: { exitCode: 7, timedOut: false, cancelled: false } }),
    execution(3, { resultChars: 13, excerptTruncated: false, process: { exitCode: null, timedOut: true, cancelled: false } }),
  ]));
  expect(evidence.entries[0]).toMatchObject({ toolOk: true, process: null, outputCompleteness: "unknown (legacy record)" });
  expect(evidence.entries[1]).toMatchObject({ toolOk: true, process: { exitCode: 7 }, outputCompleteness: "truncated", resultChars: 2000 });
  expect(evidence.entries[2].process).toEqual({ exitCode: null, timedOut: true, cancelled: false });
});

test("execution evidence bounds command, output and total payload with explicit omissions", () => {
  const raw = formationExecutionEvidence(Array.from({ length: 30 }, (_, i) => execution(i + 1, {
    args: { command: "x".repeat(10000) }, excerpt: "y".repeat(10000), resultChars: 10000, excerptTruncated: false,
  })));
  const evidence = JSON.parse(raw);
  expect(raw.length).toBeLessThan(12500);
  expect(evidence.recordedExecutions).toBe(30);
  expect(evidence.omittedExecutions).toBe(30 - evidence.entries.length);
  expect(evidence.entries.length).toBeLessThanOrEqual(8);
  for (const entry of evidence.entries) {
    expect(entry.command).toHaveLength(2000);
    expect(entry.commandTruncated).toBe(true);
    expect(entry.excerpt).toHaveLength(1000);
    expect(entry.outputCompleteness).toBe("truncated");
  }
});

test("process collector truncation and termination signals survive the evidence handoff", () => {
  const process = { exitCode: 0, signal: "SIGTERM", timedOut: false, cancelled: true, outputTruncated: true };
  const evidence = JSON.parse(formationExecutionEvidence([
    execution(1, { process, resultChars: 13, excerptTruncated: false }),
    execution(2, { process: { ...process, signal: null, cancelled: false, outputTruncated: false }, resultChars: 13, excerptTruncated: false }),
  ]));
  expect(evidence.entries[0].process).toEqual(process);
  expect(evidence.entries[0].outputCompleteness).toBe("truncated");
  expect(evidence.entries[1].outputCompleteness).toBe("complete");
});
