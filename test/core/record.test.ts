import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordEvent } from "../../src/core/record";
import { RunRecord, excerpt, hashInput } from "../../src/core/record";

describe("excerpt", () => {
  test("short text unchanged", () => expect(excerpt("a\nb", 40, 40)).toEqual({ text: "a\nb", omitted: 0 }));
  test("keeps head and tail with omitted count", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    const e = excerpt(lines.join("\n"), 3, 2);
    expect(e.omitted).toBe(95);
    expect(e.text).toBe("L0\nL1\nL2\n... [95 lines omitted] ...\nL98\nL99");
  });
});

describe("hashInput", () => {
  test("is key-order independent", () => expect(hashInput({ a: 1, b: [1, 2] })).toBe(hashInput({ b: [1, 2], a: 1 })));
});

describe("RunRecord", () => {
  test("appends with seq and ts and sums cost", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const r = new RunRecord(join(d, "record.jsonl"));
    expect(r.append({ t: "note", text: "hi" })).toBe(1);
    r.append({ t: "model.call", role: "brain", provider: "mock", model: "m", inputHash: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, stopReason: "stop", excerpt: "ok" });
    r.append({ t: "model.call", role: "scout", provider: "mock", model: "m", inputHash: "y", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5, stopReason: "stop", excerpt: "ok" });
    const all = r.read();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(typeof all[0].ts).toBe("string");
    expect(r.costUsd()).toBeCloseTo(0.75);
    const r2 = new RunRecord(join(d, "record.jsonl"));
    expect(r2.append({ t: "note", text: "again" })).toBe(4);
  });
  test("read skips a torn line and keeps counting seq from the last parseable one", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "record.jsonl");
    const r = new RunRecord(path);
    r.append({ t: "note", text: "one" });
    appendFileSync(path, '{"seq":2,"ts":"2026-01-01T00:00:0\n'); // torn write
    r.append({ t: "note", text: "two" });

    const events = r.read();
    expect(events.length).toBe(2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.corrupt).toBe(1);

    const reopened = new RunRecord(path);
    expect(reopened.corrupt).toBe(1);
    // seq continues one past the last parseable line's own seq (2), not past the raw line count.
    expect(reopened.append({ t: "note", text: "three" })).toBe(3);
  });
  test("readWithDiagnostics reports the skipped lines", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "record.jsonl");
    const r = new RunRecord(path);
    r.append({ t: "note", text: "one" });
    appendFileSync(path, "not json at all\n");
    const diag = r.readWithDiagnostics();
    expect(diag.events.length).toBe(1);
    expect(diag.corrupt).toEqual(["not json at all"]);
  });
  test("costUsd ignores torn lines", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "record.jsonl");
    const r = new RunRecord(path);
    r.append({ t: "model.call", role: "brain", provider: "mock", model: "m", inputHash: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, stopReason: "stop", excerpt: "ok" });
    appendFileSync(path, '{"t":"model.call","costUsd":\n');
    expect(r.costUsd()).toBeCloseTo(0.25);
  });
});

describe("RunRecord running cost total", () => {
  const call = (costUsd: number) =>
    ({ t: "model.call", role: "brain", provider: "mock", model: "m", inputHash: "h", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd, stopReason: "stop", excerpt: "ok" }) as const;

  test("costUsd is a running total after three appends and after reopen", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "record.jsonl");
    const r = new RunRecord(path);
    r.append(call(0.25));
    r.append(call(0.5));
    r.append(call(0.125));
    expect(r.costUsd()).toBeCloseTo(0.875);

    const reopened = new RunRecord(path);
    expect(reopened.costUsd()).toBeCloseTo(0.875);
    reopened.append(call(0.125));
    expect(reopened.costUsd()).toBeCloseTo(1);
  });

  test("costUsd is O(1): it does not re-read the journal", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const r = new RunRecord(join(d, "record.jsonl"));
    r.append(call(0.25));
    const spy = spyOn(r, "read");
    expect(r.costUsd()).toBeCloseTo(0.25);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("RecordEvent variants", () => {
  test("every new variant round trips through append and read", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "record.jsonl");
    const r = new RunRecord(path);
    const events: RecordEvent[] = [
      { t: "island.assign", round: 1, island: 0, model: "anthropic/claude-opus-4-8", lens: "constraint", operator: "recombine" },
      { t: "island.assign", round: 2, island: 1, model: "openai/gpt-5.5" },
      { t: "idea.insert", id: "r1-i0-1", cell: "hobbyists|sensor", similarity: 0.12, parents: ["r0-i0-2"] },
      { t: "idea.reject", id: "r1-i0-2", reason: "restatement", against: "r1-i0-1" },
      { t: "idea.reject", id: "r1-i0-3", reason: "lost_cell" },
      { t: "idea.reject", id: "r1-i0-4", reason: "collided", against: "https://example.com/paper" },
      { t: "arbiter.verdict", kind: "novelty", id: "r1-i0-2", against: "r1-i0-1", verdict: "same", costUsd: 0.001 },
      { t: "arbiter.verdict", kind: "collision", id: "r1-i0-4", verdict: "not_falsified", costUsd: 0.002 },
      { t: "probe", id: "r1-i0-1", status: "pass", durationMs: 1200, exitCode: 0 },
      { t: "probe", id: "r1-i0-2", status: "not_run", reason: "missing_dependency:psql", durationMs: 0 },
      { t: "probe.request", round: 1, ideas: [{ ideaId: "r1-i0-1", rationale: "cheapest test is a script" }] },
      { t: "search.health", tool: "web_search", status: "blocked" },
      { t: "search.health", tool: "scholar_search", status: "ok" },
      { t: "verdict", round: 1, a: "r1-i0-1", b: "r1-i1-3", order: "ab", valueWinner: "r1-i0-1", feasibilityWinner: "r1-i1-3", judgeModel: "openai/gpt-5.5", costUsd: 0.004 },
      { t: "checkpoint.shown", round: 3, ideas: ["r1-i0-1", "r2-i1-2"], hashes: ["aaa", "bbb"], ladders: { value: ["r1-i0-1", "r2-i1-2"], feasibility: ["r2-i1-2", "r1-i0-1"] } },
      { t: "checkpoint.bws", group: ["a", "b", "c", "d"], best: "a", worst: "d" },
      { t: "checkpoint.decision", kind: "pick", id: "r1-i0-1" },
      { t: "checkpoint.decision", kind: "reject", id: "r2-i1-2", reason: "already built" },
      { t: "checkpoint.decision", kind: "another_round", steering: "more sensor ideas" },
      { t: "checkpoint.decision", kind: "autonomous_pick", id: "r1-i0-1" },
      { t: "pause", reason: "usage_limit", wakeAt: "2026-09-03T10:00:00.000Z" },
      { t: "honest_exit", kind: "not_formable", reasons: ["mechanical floor"], source: "mechanical" },
      { t: "failure", class: "refusal", message: "model refused", category: "safety" },
      { t: "critique", verdict: "revise", scopeCreep: [{ featureId: "f02", text: "outside scope" }], unverifiable: [], missing: [{ text: "first milestone" }], crossProvider: true, provider: "anthropic", model: "anthropic/critic", stopped: "done", costUsd: 0.106, usdCapHit: false },
      { t: "formation.attempt", ideaId: "r1-i0-1", attempt: 1 },
      { t: "formation.revision", ideaId: "r1-i0-1", attempt: 1 },
      { t: "freeze", featureCount: 8, lockIdsHash: "ids", lockHash: "lock", manualCount: 1, executableCount: 7, needsUnion: ["bun"], specHash: "spec" },
      { t: "relock", before: "old", after: "new", confirmed: true },
      { t: "spec.drift", expected: "old-spec", actual: "new-spec" },
      { t: "feature.pick", featureId: "f01", attempt: 1, phaseBudgetUsd: 11.875, featureBudgetUsd: 3.327 },
      { t: "builder.session", featureId: "f01", attempt: 1, arm: "fresh", builderModelRef: "openai/builder", beforeHead: "before", afterHead: "after", stopped: "refused", turns: 4, costUsd: 0.7, selfVerified: true, headMoved: false, contextPressure: false, pinnedTruncated: false, exitReasons: [], stallTool: undefined, stallFingerprint: undefined },
      { t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1, commitSha: "abc" },
      { t: "feature.state", featureId: "f01", from: "passed", to: "passed", observedCommitShas: ["older"], legacyCommitShas: ["legacy"] },
      { t: "attempt", featureId: "f01", attempt: 1, arm: "fresh", builderStopped: "refused", builderSelfVerified: true, builderCommitted: false, contextPressure: false, declaredUnsatisfiable: false, declarationReasons: [], declarationOverruled: false, builderCostUsd: 0.7, auditorCostUsd: 0.3, costUsd: 1, counted: false, disposition: "refused" },
      { t: "check", checkId: "check-1", featureId: "f01", attempt: 1, kind: "shell", phase: "acceptance", ok: true, exitCode: 0, durationMs: 50, overrunMs: 0, timedOut: false, predicateMatched: true, outputPath: "checks/a.txt", outputTruncated: false },
      { t: "audit", featureId: "f01", attempt: 1, checkId: "check-1", shape: "full", verdict: "agree", verifiedCount: 1, claimedUnverifiedCount: 0, regressions: [], checkQualityAdequate: true, truncated: false, usdCapHit: true, crossProvider: true, costUsd: 0.3 },
      { t: "audit.disposition", featureId: "f01", attempt: 1, checkId: "check-1", rawVerdict: "disagree", effectiveVerdict: "agree", emptyDisagree: true, malformed: false, truncated: false, retried: false, evidenceUsable: true, checkVoided: false },
      { t: "commit", featureId: "f01", attempt: 1, sha: "abc", empty: false },
      { t: "stall", featureId: "f02", attempt: 2, tool: "read", fingerprint: "fp" },
      { t: "sweep", featureId: "f01", planned: 2, run: 1, skipped: ["f00"], durationMs: 10, complete: false, scope: "partial" },
      { t: "digest", hash: "digest", bytes: 1024, truncated: false },
      { t: "delta", op: "edit", section: "build", id: "B1", accepted: true, source: "reflector" },
      { t: "stop", stopKind: "budget", round: 2, truncatedRound: 2, frontierEmpty: true, budgetTargetUsd: 25, wallTargetSeconds: 14_400 },
      { t: "stop", stopKind: "blocked" },
      { t: "stop", stopKind: "deadline" },
      { t: "stop", stopKind: "transient" },
      { t: "stop", stopKind: "no_idea_clears_bar", round: 3 },
      { t: "model.call", role: "generator", provider: "anthropic", model: "claude-opus-4-8", effort: "medium", effortSent: "medium", addendaHash: "addenda", inputHash: "h", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01, stopReason: "error", stopDetails: { type: "refusal", category: "safety" }, fallbackServed: false, reasoningTokens: 1, ttftMs: 12, excerpt: "x", errorStatus: 429, errorId: "req_1", requests: 3 },
    ];
    for (const e of events) r.append(e);
    const stored = r.read();
    expect(stored.length).toBe(events.length);
    for (const [i, e] of events.entries()) {
      const { seq, ts, ...rest } = stored[i]!;
      expect(seq).toBe(i + 1);
      expect(typeof ts).toBe("string");
      expect(rest as unknown as RecordEvent).toEqual(e);
    }
    expect(r.costUsd()).toBeCloseTo(0.01);
  });
});
