import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { appendAudit } from "../../src/build/audit-contract";
import { parseTrailers } from "../../src/build/git";
import { repairAttemptProgress, repairAttemptStates, repairPassedAttempts } from "../../src/build/loop-recovery";
import { appendProgress, parseProgress } from "../../src/build/progress";
import { appendRecordedState, appendState, foldState, reconcileState } from "../../src/build/state";
import type { AttemptDisposition } from "../../src/core/events";
import { setupLoop, type LoopFixture } from "./loop-fixture";

const HEAD = "a".repeat(40);

function pick(s: LoopFixture, attempt: number) {
  s.record.append({ t: "feature.pick", featureId: "f01", attempt, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
}

function session(s: LoopFixture, attempt: number, exitReasons: string[] = []) {
  s.record.append({ t: "builder.session", featureId: "f01", attempt, arm: "fresh", builderModelRef: "producer/builder", beforeHead: HEAD, afterHead: HEAD, stopped: exitReasons.length > 0 ? "exit" : "done", turns: 1, costUsd: 0.2, selfVerified: false, headMoved: false, contextPressure: false, pinnedTruncated: false, exitReasons });
}

function attempt(s: LoopFixture, attempt: number, disposition: AttemptDisposition, counted = disposition !== "transient" && disposition !== "paused") {
  return s.record.append({ t: "attempt", featureId: "f01", attempt, arm: "fresh", builderStopped: "done", builderSelfVerified: false, builderCommitted: false, contextPressure: false, declaredUnsatisfiable: false, declarationReasons: [], declarationOverruled: false, builderCostUsd: 0.2, auditorCostUsd: 0.1, costUsd: 0.3, counted, disposition });
}

/** The check, audit event, stored audit and agreeing disposition the authenticated chain needs. */
function checked(s: LoopFixture, attempt: number, checkId: string) {
  s.record.append({ t: "check", checkId, featureId: "f01", attempt, kind: "file", phase: "acceptance", ok: true, exitCode: 0, durationMs: 1, overrunMs: 0, timedOut: false, outputPath: `${s.project.checksDir}/${checkId}.txt`, outputTruncated: false });
  const sourceEventSeq = s.record.append({ t: "audit", featureId: "f01", attempt, checkId, shape: "full", verdict: "agree", verifiedCount: 1, claimedUnverifiedCount: 0, regressions: [], checkQualityAdequate: true, truncated: false, usdCapHit: false, crossProvider: true, costUsd: 0.1 });
  appendAudit(s.deps.run, { featureId: "f01", attempt, checkId, sourceEventSeq, createdAt: "2026-09-04T00:00:00.000Z", shape: "full", raw: { verified: ["ok"], claimedUnverified: [], regressions: [], nextSessionNotes: "", checkQuality: { adequate: true, reason: "good" }, verdict: "agree" }, model: { provider: "other", model: "audit", ref: "other/audit" } });
  s.record.append({ t: "audit.disposition", featureId: "f01", attempt, checkId, rawVerdict: "agree", effectiveVerdict: "agree", emptyDisagree: false, malformed: false, truncated: false, retried: false, evidenceUsable: true, checkVoided: false });
}

async function committed(s: LoopFixture, attempt: number, checkId: string) {
  const sha = await s.git.commit(s.project.repo, { message: "feat(f01)", trailers: { "Kiln-Feature": "f01", "Kiln-Run": s.deps.run.id, "Kiln-Attempt": attempt, "Kiln-Check": checkId }, allowEmpty: true });
  const trailers = parseTrailers(await s.git.log(s.project.repo));
  reconcileState(s.deps.run, trailers, { requireAuthenticated: true, runId: s.deps.run.id, record: s.record });
  return { sha, trailers };
}

const transitions = (s: LoopFixture) => s.record.read().flatMap((event) => event.t === "feature.state" ? [{ to: event.to, attempt: event.attempt, reason: event.reason }] : []);

describe("repairAttemptStates", () => {
  test("rebuilds the failed transition a crashed attempt never wrote, exactly once", () => {
    const s = setupLoop(); pick(s, 1); attempt(s, 1, "verify_failed");
    expect(repairAttemptStates(s.deps)).toBe(1);
    expect(transitions(s)).toEqual([{ to: "failed", attempt: 1, reason: "verify_failed" }]);
    expect(foldState(s.deps.run).f01).toMatchObject({ state: "failed", attempts: 1 });
    expect(repairAttemptStates(s.deps)).toBe(0);
    expect(transitions(s)).toHaveLength(1);
  });

  test("a legacy transition without an attempt covers the attempt it follows, but not one it precedes", () => {
    const later = setupLoop(); pick(later, 1); attempt(later, 1, "verify_failed");
    appendRecordedState(later.deps.run, later.record, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify_failed" });
    expect(repairAttemptStates(later.deps)).toBe(0);
    expect(transitions(later)).toHaveLength(1);

    const earlier = setupLoop(); pick(earlier, 1); attempt(earlier, 1, "verify_failed");
    appendRecordedState(earlier.deps.run, earlier.record, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify_failed" });
    pick(earlier, 2); attempt(earlier, 2, "stalled");
    expect(repairAttemptStates(earlier.deps)).toBe(1);
    expect(transitions(earlier)).toEqual([{ to: "failed", attempt: undefined, reason: "verify_failed" }, { to: "failed", attempt: 2, reason: "stalled" }]);
    expect(foldState(earlier.deps.run).f01.attempts).toBe(2);

    const named = setupLoop(); pick(named, 1); attempt(named, 1, "verify_failed");
    appendRecordedState(named.deps.run, named.record, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempt: 1, attempts: 1, reason: "verify_failed" });
    expect(repairAttemptStates(named.deps)).toBe(0);
  });

  test("uncounted attempts keep the attempt count and a passed attempt without its commit is an integrity failure", () => {
    const s = setupLoop(); pick(s, 1); attempt(s, 1, "transient");
    expect(repairAttemptStates(s.deps)).toBe(1);
    expect(foldState(s.deps.run).f01).toMatchObject({ state: "failed", attempts: 0 });

    const orphan = setupLoop(); pick(orphan, 1); attempt(orphan, 1, "passed");
    expect(() => repairAttemptStates(orphan.deps)).toThrow("integrity: passed attempt f01/1 has no authenticated commit");
  });
});

describe("repairPassedAttempts", () => {
  test("recovers the passed attempt of a committed session once and leaves progress to the progress repair", async () => {
    const s = setupLoop(); pick(s, 1); session(s, 1, ["declared"]); checked(s, 1, "check-1");
    const { sha, trailers } = await committed(s, 1, "check-1");
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, passCommitShas: [sha] });
    expect(repairPassedAttempts(s.deps, s.features, trailers)).toBe(1);
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([expect.objectContaining({
      featureId: "f01", attempt: 1, arm: "fresh", disposition: "passed", counted: true, declaredUnsatisfiable: true, declarationOverruled: true, builderCostUsd: 0.2, auditorCostUsd: 0.1,
    })]);
    expect(existsSync(s.project.progress)).toBe(false);
    expect(repairPassedAttempts(s.deps, s.features, trailers)).toBe(0);
    expect(s.record.read().filter((event) => event.t === "attempt")).toHaveLength(1);
  });

  test("ignores sessions whose feature does not pass through their own attempt", async () => {
    const unpassed = setupLoop(); pick(unpassed, 1); session(unpassed, 1); checked(unpassed, 1, "check-1");
    expect(repairPassedAttempts(unpassed.deps, unpassed.features, [])).toBe(0);
    expect(unpassed.record.read().some((event) => event.t === "attempt")).toBe(false);

    const later = setupLoop(); pick(later, 1); session(later, 1); checked(later, 1, "check-1");
    const { trailers } = await committed(later, 1, "check-1");
    attempt(later, 1, "passed");
    appendState(later.deps.run, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f02" });
    pick(later, 2); session(later, 2);
    expect(repairPassedAttempts(later.deps, later.features, trailers)).toBe(0);
    expect(later.record.read().filter((event) => event.t === "attempt")).toHaveLength(1);
  });
});

describe("repairAttemptProgress", () => {
  test("appends one dated entry per final attempt the loop never wrote and leaves written entries untouched", async () => {
    const s = setupLoop(); pick(s, 1); session(s, 1); checked(s, 1, "check-1");
    const { sha, trailers } = await committed(s, 1, "check-1");
    attempt(s, 1, "passed");
    appendProgress(s.deps.run, { featureId: "f01", attempt: 1, kind: "attempt", entryId: "attempt-1", iso: "2026-09-04T01:00:00.000Z", check: { checkId: "check-1", ok: true, kind: "file", exitCode: 0, durationMs: 1, excerpt: "live output" }, commit: { sha, empty: true }, discardStat: " old.ts | 1 -" });
    pick(s, 2); session(s, 2); const transientSeq = attempt(s, 2, "transient");
    pick(s, 3); session(s, 3);
    const checkSeq = s.record.append({ t: "check", checkId: "check-3", featureId: "f01", attempt: 3, kind: "file", phase: "acceptance", ok: false, exitCode: 1, durationMs: 1, overrunMs: 0, timedOut: false, outputPath: `${s.project.checksDir}/check-3.txt`, outputTruncated: false });
    attempt(s, 3, "verify_failed");
    const ts = (seq: number) => s.record.read().find((event) => event.seq === seq)!.ts;

    expect(repairAttemptProgress(s.deps, s.features, trailers)).toBe(2);
    const entries = parseProgress(readFileSync(s.project.progress, "utf8"));
    expect(entries.map((entry) => entry.key)).toEqual(["f01:1:attempt:attempt-1", "f01:2:attempt:attempt-2", "f01:3:attempt:attempt-3"]);
    expect(entries[0]).toMatchObject({ iso: "2026-09-04T01:00:00.000Z" });
    expect(entries[0]?.text).toContain(`commit: ${sha} (allow-empty)`); expect(entries[0]?.text).toContain("discard: old.ts | 1 -"); expect(entries[0]?.text).toContain("live output");
    expect(entries[1]).toMatchObject({ iso: ts(transientSeq) }); expect(entries[1]?.text).toContain("not-run-transient");
    expect(entries[2]).toMatchObject({ iso: ts(checkSeq) }); expect(entries[2]?.text).toContain("fail file check-3");

    const written = readFileSync(s.project.progress, "utf8");
    expect(repairAttemptProgress(s.deps, s.features, trailers)).toBe(0);
    expect(readFileSync(s.project.progress, "utf8")).toBe(written);
  });

  test("skips attempts without a builder session", () => {
    const s = setupLoop(); pick(s, 1); attempt(s, 1, "verify_failed");
    expect(repairAttemptProgress(s.deps, s.features, [])).toBe(0);
    expect(existsSync(s.project.progress)).toBe(false);
  });
});
