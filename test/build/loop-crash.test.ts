import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BuildStepCrash, runBuild } from "../../src/build/loop";
import { foldState } from "../../src/build/state";
import { appendRecordedState } from "../../src/build/state";
import { parseProgress } from "../../src/build/progress";
import { readAudits } from "../../src/build/audit-contract";
import { feature, setupLoop } from "./loop-fixture";

async function crash(run: Promise<unknown>): Promise<unknown> { try { await run; } catch (error) { return error; } return undefined; }

type AuditPersistCrash = "after_audit_event" | "before_disposition";

/** The auditor's three durable writes have two interior crash points: after its `audit` event, and after its stored audit but before its disposition. */
function crashInsideAuditPersist(s: ReturnType<typeof setupLoop>, point: AuditPersistCrash): void {
  const append = s.record.append.bind(s.record); let crashed = false;
  s.record.append = (event) => {
    if (point === "before_disposition" && event.t === "audit.disposition" && !crashed) { crashed = true; throw new BuildStepCrash(5, "check", new Error("crash before the disposition")); }
    const seq = append(event);
    if (point === "after_audit_event" && event.t === "audit" && !crashed) { crashed = true; throw new BuildStepCrash(5, "check", new Error("crash after the audit event")); }
    return seq;
  };
}

/** The feature commit was made; the process died before its commit event. */
function crashAfterCommit(s: ReturnType<typeof setupLoop>): void {
  const commit = s.git.commit.bind(s.git); let crashed = false;
  s.git.commit = async (dir, options) => { const sha = await commit(dir, options); if (!crashed) { crashed = true; throw new BuildStepCrash(8, "commit", new Error("crash after the commit")); } return sha; };
}

function canonical(s: ReturnType<typeof setupLoop>) {
  const state = foldState(s.deps.run).f01!;
  const events = s.record.read();
  return {
    state: { state: state.state, passes: state.passes, attempts: state.attempts, repairs: state.repairs, passSource: state.passSource, commits: state.passCommitShas },
    sessions: events.filter((event) => event.t === "builder.session").length,
    attempts: events.filter((event) => event.t === "attempt").map((event) => event.t === "attempt" ? { n: event.attempt, disposition: event.disposition, cost: event.costUsd } : undefined),
    commits: events.filter((event) => event.t === "commit").map((event) => event.t === "commit" ? event.sha : ""),
    progress: parseProgress(readFileSync(s.project.progress, "utf8")).map((entry) => entry.key),
    outcome: events.filter((event) => event.t === "phase.end" && event.phase === "build").map((event) => event.t === "phase.end" ? event.outcome : ""),
  };
}

describe("build crash matrix", () => {
  test("every durable boundary 0-11 resumes to one canonical pass without rerunning the builder", async () => {
    const baseline = setupLoop(); expect(await runBuild(baseline.deps)).toEqual({ outcome: "ok" });
    const expected = canonical(baseline);
    for (let target = 0; target <= 11; target += 1) {
      const s = setupLoop(); let crashed = false;
      s.deps.stepHook = (index) => {
        if (index === target && !crashed) { crashed = true; throw new Error(`crash-${target}`); }
      };
      let error: unknown;
      try { await runBuild(s.deps); } catch (value) { error = value; }
      expect(error).toBeInstanceOf(BuildStepCrash);
      expect((error as BuildStepCrash).index).toBe(target);
      expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
      expect(canonical(s)).toEqual(expected);
      expect(s.builderCalls).toEqual(["f01"]);
      expect(s.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);
      const passed = s.record.read().filter((event) => event.t === "feature.state" && event.to === "passed");
      const commits = s.record.read().filter((event) => event.t === "commit");
      const voided = s.record.read().filter((event) => event.t === "audit.disposition" && event.checkVoided);
      expect(passed.length === 0 || commits.length > 0 || voided.length > 0).toBe(true);
    }
  });

  test("a crash after an in-flight session that follows a failed attempt never restores that session's work", async () => {
    for (const target of [3, 4]) {
      const s = setupLoop(); s.checkOutcomes.push(false, true); s.git.diffText = " work.ts | 5 +++++"; let crashed = false;
      const base = s.deps.runBuilder!;
      s.deps.runBuilder = async (...args) => { const result = await base(...args); s.git.status = " M work.ts"; return result; };
      s.deps.stepHook = (index) => {
        if (index === target && !crashed && s.record.read().some((event) => event.t === "builder.session" && event.attempt === 2)) { crashed = true; throw new Error(`crash-${target}`); }
      };
      let error: unknown;
      try { await runBuild(s.deps); } catch (value) { error = value; }
      expect(error).toBeInstanceOf(BuildStepCrash); expect((error as BuildStepCrash).index).toBe(target);
      expect(s.builderCalls).toEqual(["f01", "f01"]);
      expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toHaveLength(1);
      expect(s.git.status).toBe(" M work.ts");

      expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
      expect(s.builderCalls).toEqual(["f01", "f01"]);
      expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toHaveLength(1);
      expect(s.record.read().flatMap((event) => event.t === "attempt" ? [event.disposition] : [])).toEqual(["verify_failed", "passed"]);
      expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 2 });
      expect(s.git.commits).toHaveLength(1); expect(s.git.commits[0]?.options.allowEmpty).toBe(true);
      expect(s.record.read().find((event) => event.t === "commit")).toMatchObject({ attempt: 2, empty: false });
    }
  });

  /** A final `attempt` reached record.jsonl, its transition reached state.jsonl, then the process died before the record copy. */
  async function stateWrittenRecordMissing(transitionAttempt: number | undefined) {
    const s = setupLoop();
    s.record.append({ t: "feature.pick", featureId: "f01", attempt: 1, phaseBudgetUsd: 10, featureBudgetUsd: 5 });
    s.record.append({ t: "attempt", featureId: "f01", attempt: 1, arm: "fresh", builderStopped: "done", builderSelfVerified: false, builderCommitted: false, contextPressure: false, declaredUnsatisfiable: false, declarationReasons: [], declarationOverruled: false, builderCostUsd: 0.2, auditorCostUsd: 0.1, costUsd: 0.3, counted: true, disposition: "verify_failed" });
    const transition = { t: "feature.state", featureId: "f01", from: "pending", to: "failed", attempt: transitionAttempt, attempts: 1, repairs: 0, reason: "verify_failed" } as const;
    expect(() => appendRecordedState(s.deps.run, s.record, transition, { afterState: () => { throw new Error("kill"); } })).toThrow("kill");
    expect(s.record.read().some((event) => event.t === "feature.state")).toBe(false);
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.record.read().filter((event) => event.t === "feature.state").map((event) => event.t === "feature.state" && event.to)).toEqual(["failed", "passed"]);
    expect(s.record.read().filter((event) => event.t === "attempt").map((event) => event.t === "attempt" && event.attempt)).toEqual([1, 2]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 2 });
  }

  test("build entry repairs a state-written record-missing internal crash before resuming", async () => {
    await stateWrittenRecordMissing(undefined);
  });

  test("build entry repairs the same crash when the transition names its attempt", async () => {
    await stateWrittenRecordMissing(1);
  });

  test("a crash between the feature commit and its attempt recovers one pass, one attempt, one progress entry and no second commit", async () => {
    const s = setupLoop(); crashAfterCommit(s);
    expect(await crash(runBuild(s.deps))).toBeInstanceOf(BuildStepCrash);
    expect(s.git.commits).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "attempt")).toHaveLength(0);

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    const sha = s.git.commits[0]!.sha;
    expect(s.git.commits).toHaveLength(1);
    expect(s.builderCalls).toEqual(["f01"]);
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([expect.objectContaining({ attempt: 1, arm: "fresh", disposition: "passed", counted: true, builderCostUsd: 0.2, auditorCostUsd: 0.1 })]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1, passSource: "executed", passCommitShas: [sha] });
    const progress = parseProgress(readFileSync(s.project.progress, "utf8"));
    expect(progress.map((entry) => entry.key)).toEqual(["f01:1:attempt:attempt-1"]);
    expect(progress[0]?.text).toContain(`commit: ${sha}`);
    expect(s.git.calls.some((call) => call.method === "checkoutAndClean")).toBe(false);

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.record.read().filter((event) => event.t === "attempt")).toHaveLength(1);
    expect(parseProgress(readFileSync(s.project.progress, "utf8"))).toHaveLength(1);
    expect(s.git.commits).toHaveLength(1);
  });

  test("a crash after the latest passed transition and before its sweep event reruns exactly that sweep at entry", async () => {
    const s = setupLoop([feature("f01"), feature("f02")]); const base = s.deps.runSweep!; let crashed = false;
    s.deps.runSweep = async (deps, passed, options) => {
      if (options.triggerFeatureId === "f02" && !crashed) { crashed = true; throw new BuildStepCrash(9, "state_and_sweep", new Error("crash before the sweep event")); }
      return base(deps, passed, options);
    };
    const sweeps = () => s.record.read().flatMap((event) => event.t === "sweep" ? [{ trigger: event.featureId, planned: event.planned }] : []);
    const passed = () => s.record.read().flatMap((event) => event.t === "feature.state" && event.to === "passed" ? [event.featureId] : []);
    expect(await crash(runBuild(s.deps))).toBeInstanceOf(BuildStepCrash);
    expect(sweeps()).toEqual([{ trigger: "f01", planned: 0 }]); expect(passed()).toEqual(["f01", "f02"]);

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(sweeps()).toEqual([{ trigger: "f01", planned: 0 }, { trigger: "f02", planned: 1 }]);
    expect(passed()).toEqual(["f01", "f02"]); expect(s.git.commits).toHaveLength(2); expect(s.builderCalls).toEqual(["f01", "f02"]);
    expect(s.record.read().filter((event) => event.t === "attempt")).toHaveLength(2);

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(sweeps()).toHaveLength(2); expect(s.git.commits).toHaveLength(2);
  });

  test("the pass path adopts the feature commit an earlier resume already made instead of committing the same attempt twice", async () => {
    // The first auditor call disagreed and died after its audit event; the rerun agreed. Entry-time authentication rejects
    // the trailer (its audit records disagree) while the loop's durable disposition still passes the attempt.
    const s = setupLoop(); s.auditVerdicts.push("disagree", "agree"); crashInsideAuditPersist(s, "after_audit_event");
    expect(await crash(runBuild(s.deps))).toBeInstanceOf(BuildStepCrash);
    crashAfterCommit(s);
    expect(await crash(runBuild(s.deps))).toBeInstanceOf(BuildStepCrash);
    expect(s.git.commits).toHaveLength(1);
    expect(s.record.read().flatMap((event) => event.t === "audit" ? [event.verdict] : [])).toEqual(["disagree", "agree"]);

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    const sha = s.git.commits[0]!.sha;
    expect(s.git.calls.filter((call) => call.method === "commit")).toHaveLength(1); expect(s.git.commits).toHaveLength(1);
    expect(s.builderCalls).toEqual(["f01"]); expect(s.auditCalls).toEqual(["f01", "f01"]);
    expect(s.record.read().filter((event) => event.t === "commit")).toEqual([expect.objectContaining({ featureId: "f01", attempt: 1, sha })]);
    expect(s.record.read().filter((event) => event.t === "note" && event.text.includes(sha))).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([expect.objectContaining({ attempt: 1, disposition: "passed", counted: true })]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1, passCommitShas: [sha] });

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.git.commits).toHaveLength(1); expect(s.record.read().filter((event) => event.t === "commit")).toHaveLength(1);
  });

  test("a double crash, inside the auditor's persist and again between the commit and the passed transition, converges to one commit", async () => {
    for (const first of ["after_audit_event", "before_disposition"] as const) for (const second of ["commit", 8] as const) {
      const s = setupLoop(); crashInsideAuditPersist(s, first);
      expect(await crash(runBuild(s.deps))).toBeInstanceOf(BuildStepCrash);
      if (second === "commit") crashAfterCommit(s);
      else { let crashed = false; s.deps.stepHook = (index) => { if (index === second && !crashed) { crashed = true; throw new Error(`crash-${second}`); } }; }
      expect(await crash(runBuild(s.deps))).toBeInstanceOf(BuildStepCrash);
      expect(s.git.commits).toHaveLength(1);
      const persisted = () => ({ first, second, audits: s.record.read().filter((event) => event.t === "audit").length, stored: readAudits(s.deps.run).length });
      expect(persisted()).toEqual({ first, second, audits: 2, stored: first === "before_disposition" ? 2 : 1 });

      expect({ first, second, result: await runBuild(s.deps) }).toEqual({ first, second, result: { outcome: "ok" } });
      const sha = s.git.commits[0]!.sha;
      expect({ first, second, commits: s.git.commits.length, builders: s.builderCalls }).toEqual({ first, second, commits: 1, builders: ["f01"] });
      expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([expect.objectContaining({ attempt: 1, disposition: "passed", counted: true })]);
      expect(s.record.read().filter((event) => event.t === "feature.state" && event.to === "passed")).toEqual([expect.objectContaining({ featureId: "f01", attempt: 1, commitSha: sha })]);
      expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1, passCommitShas: [sha] });
      expect(s.record.read().filter((event) => event.t === "sweep")).toHaveLength(1);

      expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
      expect(s.git.commits).toHaveLength(1); expect(s.record.read().filter((event) => event.t === "sweep")).toHaveLength(1);
    }
  });
});
