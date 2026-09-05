import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, type RunPaths } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { projectPaths } from "../../src/formation/paths";
import type { FeaturesFile } from "../../src/formation/features";
import { appendAudit } from "../../src/build/audit-contract";
import { appendRecordedState, appendState, foldState, pickFeature, reconcile, reconcileState, syncStateRecord, type FeatureTransition } from "../../src/build/state";

const features: FeaturesFile = {
  version: 1,
  init: { needs: [] },
  features: ["f01", "f02", "f03"].map((id) => ({ id, title: id, description: id, acceptance: { type: "file", path: `${id}.txt` } })),
};

function setup() {
  const run = createRun(mkdtempSync(join(tmpdir(), "kiln-state-")), "seed");
  const project = projectPaths(run.project);
  mkdirSync(project.dir, { recursive: true });
  writeFileSync(run.features, `${JSON.stringify(features, null, 2)}\n`);
  writeFileSync(run.acceptanceLock, "{\"lock\":true}\n");
  writeFileSync(run.featureState, "");
  writeFileSync(project.featuresMirror, "poison features\n");
  writeFileSync(project.lockMirror, "poison lock\n");
  return { run, project };
}

/** The durable links `authenticated()` requires before a feature trailer can recover a pass. */
const EVIDENCE_LINKS = ["pick", "session", "check", "audit", "stored", "disposition"] as const;
type EvidenceLink = (typeof EVIDENCE_LINKS)[number];

function evidenceChain(run: RunPaths, record: RunRecord) {
  const featureId = "f01";
  return {
    /** The per-attempt links: exactly one pick and one builder session. */
    attempt(attempt: number, omit?: EvidenceLink) {
      if (omit !== "pick") record.append({ t: "feature.pick", featureId, attempt, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
      if (omit !== "session") record.append({ t: "builder.session", featureId, attempt, arm: "fresh", builderModelRef: "producer/builder", beforeHead: "a".repeat(40), afterHead: "a".repeat(40), stopped: "done", turns: 1, costUsd: 0.2, selfVerified: false, headMoved: false, contextPressure: false, pinnedTruncated: false, exitReasons: [] });
    },
    /** The per-check links: one check event, one audit event, one stored audit, one disposition. */
    check(checkId: string, attempt: number, options: { verdict?: "agree" | "disagree"; voided?: boolean; omit?: EvidenceLink } = {}) {
      const verdict = options.verdict ?? "agree";
      if (options.omit !== "check") record.append({ t: "check", checkId, featureId, attempt, kind: "file", phase: "acceptance", ok: true, durationMs: 1, overrunMs: 0, timedOut: false, outputPath: checkId, outputTruncated: false });
      const sourceEventSeq = options.omit === "audit" ? record.read().length + 1 : record.append({ t: "audit", featureId, attempt, checkId, shape: "full", verdict, verifiedCount: 1, claimedUnverifiedCount: 0, regressions: [], checkQualityAdequate: true, truncated: false, usdCapHit: false, crossProvider: true, costUsd: 0.1 });
      if (options.omit !== "stored") appendAudit(run, { featureId, attempt, checkId, sourceEventSeq, createdAt: "2026-09-04T00:00:00.000Z", shape: "full", raw: { verified: ["ok"], claimedUnverified: [], regressions: [], nextSessionNotes: "", checkQuality: { adequate: true, reason: "good" }, verdict }, model: { provider: "other", model: "audit", ref: "other/audit" } });
      if (options.omit !== "disposition") record.append({ t: "audit.disposition", featureId, attempt, checkId, rawVerdict: verdict, effectiveVerdict: verdict, emptyDisagree: false, malformed: false, truncated: false, retried: false, evidenceUsable: true, checkVoided: options.voided ?? false });
    },
  };
}

function recover(run: RunPaths, record: RunRecord, sha: string, checkId: string, attempt: number, runId = run.id) {
  return reconcileState(run, [{ featureId: "f01", sha, runId, checkId, attempt }], { requireAuthenticated: true, runId: run.id, record }).f01!;
}

describe("build state", () => {
  test("folds absolute transitions, deduplicates replay, and repairs mirrors after every append", () => {
    const { run, project } = setup();
    const failed = { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify" } as const;
    appendState(run, failed);
    appendState(run, failed);
    expect(readFileSync(run.featureState, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(project.featuresMirror, "utf8")).toBe(readFileSync(run.features, "utf8"));
    expect(readFileSync(project.lockMirror, "utf8")).toBe(readFileSync(run.acceptanceLock, "utf8"));
    expect(foldState(run).f01).toMatchObject({ state: "failed", passes: false, attempts: 1, repairs: 0 });

    writeFileSync(project.featuresMirror, JSON.stringify({ features: [{ id: "evil" }] }));
    appendState(run, { t: "feature.state", featureId: "f01", from: "failed", to: "blocked", attempts: 1, reason: "attempts_exhausted" });
    const folded = foldState(run);
    expect(folded.f01).toMatchObject({ blocked: true, blockedReason: "attempts_exhausted" });
    expect(pickFeature(features, folded, { maxAttempts: 3 })).toEqual({ feature: features.features[1], attempt: 1 });
    expect(readFileSync(project.featuresMirror, "utf8")).toBe(readFileSync(run.features, "utf8"));
  });

  test("reconciles feature trailers without mutating state and validates before append", () => {
    const { run } = setup();
    const folded = foldState(run);
    const recovered = reconcile(folded, [{ featureId: "f03", sha: "abc" }, { featureId: "unknown", sha: "def" }]);
    expect(folded.f03!.passes).toBe(false);
    expect(recovered.f03).toMatchObject({ state: "passed", passes: true, passSource: "executed" });
    expect(pickFeature(features, recovered, { maxAttempts: 3 })?.feature.id).toBe("f01");

    expect(() => appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: -1 })).toThrow("absolute non-decreasing");
    expect(readFileSync(run.featureState, "utf8")).toBe("");
  });

  test("trailers fill a missing pass only and never erase later authoritative state", () => {
    const { run } = setup();
    appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify" });
    appendState(run, { t: "feature.state", featureId: "f02", from: "pending", to: "passed", source: "executed", attempts: 1 });
    appendState(run, { t: "feature.state", featureId: "f02", from: "passed", to: "blocked", attempts: 1, reason: "attempts_exhausted" });
    appendState(run, { t: "feature.state", featureId: "f03", from: "pending", to: "passed", source: "executed", attempts: 1 });
    appendState(run, { t: "feature.state", featureId: "f03", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f01" });
    const recovered = reconcile(foldState(run), [
      { featureId: "f01", sha: "later-commit" }, { featureId: "f02", sha: "old-commit" }, { featureId: "f03", sha: "old-commit" },
    ]);
    expect(recovered.f01).toMatchObject({ state: "passed", passes: true, passTransitions: 1 });
    expect(recovered.f02).toMatchObject({ state: "blocked", passes: false });
    expect(recovered.f03).toMatchObject({ state: "regressed", passes: false, passTransitions: 1 });
    const repaired = reconcile(foldState(run), [{ featureId: "f03", sha: "new-repair" }, { featureId: "f03", sha: "old-commit" }]);
    expect(repaired.f03).toMatchObject({ state: "passed", passes: true, passTransitions: 2 });
  });

  test("authenticated recovery rejects forged run/feature trailers and stale, disagreed or voided checks", () => {
    const { run } = setup(); const record = new RunRecord(run.record);
    appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify" });
    const chain = evidenceChain(run, record);
    chain.attempt(1); chain.check("old", 1);
    expect(recover(run, record, "stale", "old", 1).passes).toBe(false);
    chain.attempt(2); chain.check("new-disagree", 2, { verdict: "disagree" });
    expect(recover(run, record, "no-veto-bypass", "new-disagree", 2).passes).toBe(false);
    chain.check("new-void", 2, { voided: true });
    expect(recover(run, record, "void", "new-void", 2).passes).toBe(false);
    chain.check("new", 2);
    expect(recover(run, record, "other-run", "new", 2, "other-run").passes).toBe(false);
    const recovered = recover(run, record, "harness", "new", 2);
    expect(recovered).toMatchObject({ passes: true, attempts: 2, passCommitShas: ["harness"] });
    expect(record.read().some((event) => event.t === "feature.state" && event.commitSha === "harness" && event.attempt === 2)).toBe(true);
  });

  test("authenticated recovery needs every durable link of the evidence chain", () => {
    for (const omit of [undefined, ...EVIDENCE_LINKS]) {
      const { run } = setup(); const record = new RunRecord(run.record);
      appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify" });
      const chain = evidenceChain(run, record);
      chain.attempt(2, omit); chain.check("new", 2, { omit });
      expect({ omit, passes: recover(run, record, "harness", "new", 2).passes }).toEqual({ omit, passes: omit === undefined });
    }
  });

  test("authenticated recovery accepts an auditor record re-persisted after an interior crash and rejects records that disagree", () => {
    const storedAudit = (run: RunPaths, attempt: number, verdict: "agree" | "disagree", sourceEventSeq: number) => appendAudit(run, { featureId: "f01", attempt, checkId: "new", sourceEventSeq, createdAt: "2026-09-04T00:00:00.000Z", shape: "full", raw: { verified: ["ok"], claimedUnverified: [], regressions: [], nextSessionNotes: "", checkQuality: { adequate: true, reason: "good" }, verdict }, model: { provider: "other", model: "audit", ref: "other/audit" } });
    const auditEvent = (record: RunRecord, attempt: number, verdict: "agree" | "disagree") => record.append({ t: "audit", featureId: "f01", attempt, checkId: "new", shape: "full", verdict, verifiedCount: 1, claimedUnverifiedCount: 0, regressions: [], checkQualityAdequate: true, truncated: false, usdCapHit: false, crossProvider: true, costUsd: 0.1 });
    const cases: Array<[string, (run: RunPaths, record: RunRecord) => void, boolean]> = [
      ["a second identical audit event and stored audit", (run, record) => { storedAudit(run, 2, "agree", auditEvent(record, 2, "agree")); }, true],
      ["a second audit event with another verdict", (_run, record) => { auditEvent(record, 2, "disagree"); }, false],
      ["a second audit event for another attempt", (_run, record) => { auditEvent(record, 3, "agree"); }, false],
      ["a second stored audit with another verdict", (run) => { storedAudit(run, 2, "disagree", 99); }, false],
      ["a second stored audit for another attempt", (run) => { storedAudit(run, 3, "agree", 99); }, false],
    ];
    for (const [name, extra, passes] of cases) {
      const { run } = setup(); const record = new RunRecord(run.record);
      appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify" });
      const chain = evidenceChain(run, record); chain.attempt(2); chain.check("new", 2);
      extra(run, record);
      expect({ name, passes: recover(run, record, "harness", "new", 2).passes }).toEqual({ name, passes });
    }
  });

  test("syncs the state-written record-missing crash window exactly once", () => {
    const { run } = setup(); const record = new RunRecord(run.record);
    const transition = { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1, reason: "verify" } as const;
    expect(() => appendRecordedState(run, record, transition, { afterState: () => { throw new Error("kill after state"); } })).toThrow("kill after state");
    expect(foldState(run).f01).toMatchObject({ state: "failed", attempts: 1 });
    expect(record.read().some((event) => event.t === "feature.state")).toBe(false);
    expect(syncStateRecord(run, record)).toBe(1);
    expect(syncStateRecord(run, record)).toBe(0);
    expect(record.read().filter((event) => event.t === "feature.state")).toHaveLength(1);
  });

  test("durably consumes unmatched trailers before later state transitions", () => {
    const { run, project } = setup();
    appendState(run, { t: "feature.state", featureId: "f03", from: "pending", to: "failed", attempts: 1, reason: "verify" });
    const initial = [
      { featureId: "f01", sha: "f01-initial" },
      { featureId: "f02", sha: "f02-initial" },
      { featureId: "f03", sha: "f03-later" },
    ];
    let recovered = reconcileState(run, initial);
    expect(Object.values(recovered).every((state) => state.passes && state.passTransitions === 1)).toBe(true);
    expect(readFileSync(run.featureState, "utf8")).toContain('"commitSha":"f01-initial"');
    const lineCount = readFileSync(run.featureState, "utf8").trim().split("\n").length;
    writeFileSync(project.featuresMirror, "poison");
    recovered = reconcileState(run, initial);
    expect(readFileSync(run.featureState, "utf8").trim().split("\n")).toHaveLength(lineCount);
    expect(readFileSync(project.featuresMirror, "utf8")).toBe(readFileSync(run.features, "utf8"));

    appendState(run, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f02" });
    expect(reconcileState(run, initial).f01).toMatchObject({ state: "regressed", passes: false, passTransitions: 1 });
    recovered = reconcileState(run, [{ featureId: "f01", sha: "f01-repair" }, { featureId: "f01", sha: "f01-initial" }, ...initial.slice(1)]);
    expect(recovered.f01).toMatchObject({ state: "passed", passes: true, passTransitions: 2 });
    expect(readFileSync(run.featureState, "utf8")).toContain('"commitSha":"f01-repair"');
    appendState(run, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 2, regressedBy: "f03" });
    expect(reconcileState(run, [{ featureId: "f01", sha: "f01-repair" }, { featureId: "f01", sha: "f01-initial" }]).f01).toMatchObject({ state: "regressed", passes: false, passTransitions: 2 });
  });

  test("anchors identities across expanded and reordered trailer histories", () => {
    const { run } = setup();
    reconcileState(run, [{ featureId: "f01", sha: "only-newest" }]);
    appendState(run, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f02" });
    let state = reconcileState(run, [
      { featureId: "f01", sha: "only-newest" }, { featureId: "f01", sha: "older-2" }, { featureId: "f01", sha: "older-1" },
    ]).f01!;
    expect(state).toMatchObject({ state: "regressed", passCommitShas: ["only-newest"] });
    expect(state.observedCommitShas).toEqual(expect.arrayContaining(["only-newest", "older-2", "older-1"]));
    const expandedLines = readFileSync(run.featureState, "utf8").trim().split("\n").length;

    state = reconcileState(run, [
      { featureId: "f01", sha: "older-2" }, { featureId: "f01", sha: "only-newest" }, { featureId: "f01", sha: "older-1" },
    ]).f01!;
    expect(state.state).toBe("regressed");
    expect(readFileSync(run.featureState, "utf8").trim().split("\n")).toHaveLength(expandedLines);

    state = reconcileState(run, [
      { featureId: "f01", sha: "brand-new" }, { featureId: "f01", sha: "only-newest" },
      { featureId: "f01", sha: "older-2" }, { featureId: "f01", sha: "older-1" },
    ]).f01!;
    expect(state).toMatchObject({ state: "passed", passTransitions: 2 });
    expect(state.passCommitShas).toEqual(["only-newest", "brand-new"]);
    const persisted = readFileSync(run.featureState, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeatureTransition);
    expect(persisted.flatMap((event) => event.commitSha ? [event.commitSha] : [])).toEqual(["only-newest", "brand-new"]);
    const recoveredLines = persisted.length;
    reconcileState(run, [
      { featureId: "f01", sha: "older-1" }, { featureId: "f01", sha: "brand-new" },
      { featureId: "f01", sha: "only-newest" }, { featureId: "f01", sha: "older-2" },
    ]);
    expect(readFileSync(run.featureState, "utf8").trim().split("\n")).toHaveLength(recoveredLines);
  });

  test("legacy pass transitions consume the oldest visible identities", () => {
    const { run } = setup();
    appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1 });
    appendState(run, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f02" });
    const state = reconcileState(run, [{ featureId: "f01", sha: "new-repair" }, { featureId: "f01", sha: "legacy-pass" }]).f01!;
    expect(state).toMatchObject({ state: "passed", passTransitions: 2, legacyPassTransitions: 1 });
    expect(state.legacyCommitShas).toEqual(["legacy-pass"]);
    expect(state.passCommitShas).toEqual(expect.arrayContaining(["legacy-pass", "new-repair"]));
    const persisted = readFileSync(run.featureState, "utf8");
    expect(persisted).toContain('"commitSha":"new-repair"');
    expect(persisted).toContain('"legacyCommitShas":["legacy-pass"]');
  });

  test("torn state tails are ignored and regressed history survives a later pass", () => {
    const { run } = setup();
    appendState(run, { t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1 });
    appendState(run, { t: "feature.state", featureId: "f01", from: "passed", to: "regressed", attempts: 1, repairs: 1, regressedBy: "f02" });
    appendState(run, { t: "feature.state", featureId: "f01", from: "regressed", to: "passed", source: "executed", attempts: 2, repairs: 1 });
    writeFileSync(run.featureState, `${readFileSync(run.featureState, "utf8")}{torn`);
    expect(foldState(run).f01).toMatchObject({ passes: true, attempts: 2, repairs: 1, regressedBy: "f02" });
    appendState(run, { t: "feature.state", featureId: "f02", from: "pending", to: "failed", attempts: 1, reason: "verify" });
    expect(readFileSync(run.featureState, "utf8")).not.toContain("{torn");
    expect(foldState(run).f02).toMatchObject({ state: "failed", attempts: 1 });
  });

  test("interior or terminated corruption is an integrity failure", () => {
    const { run } = setup();
    const valid = JSON.stringify({ t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempts: 1 });
    writeFileSync(run.featureState, `${valid}\n{bad\n${valid}\n`);
    expect(() => foldState(run)).toThrow("malformed state.jsonl line 2");
    writeFileSync(run.featureState, `${valid}\n{bad\n`);
    expect(() => foldState(run)).toThrow("malformed state.jsonl line 2");
    writeFileSync(run.featureState, `${valid}\n{\"t\":\"note\"}`);
    expect(() => foldState(run)).toThrow("not a feature.state event");
  });
});
