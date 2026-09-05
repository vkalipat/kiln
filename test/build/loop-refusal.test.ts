import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BuildStepCrash, runBuild } from "../../src/build/loop";
import { builderSession, recordBuilderRefusal } from "../../src/build/loop-support";
import { AuditorRunError } from "../../src/build/auditor";
import { foldState } from "../../src/build/state";
import { parseProgress } from "../../src/build/progress";
import { builderResult, setupLoop } from "./loop-fixture";

const refusal = (category: string) => builderResult({
  stopped: "refused",
  stopDetails: { type: "refusal", category },
  error: `Refusal (${category})`,
});

describe("builder refusals", () => {
  test("recovers the category if a process dies between the session and refusal failure appends", () => {
    const s = setupLoop();
    s.record.append({ t: "feature.pick", featureId: "f01", attempt: 1, phaseBudgetUsd: 10 });
    s.record.append({ t: "model.call", role: "builder", provider: "p", model: "m", inputHash: "h", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, stopReason: "error", excerpt: "", stopDetails: { type: "refusal", category: "safety" } });
    s.record.append({ t: "builder.session", featureId: "f01", attempt: 1, arm: "fresh", builderModelRef: "p/m", beforeHead: "a", afterHead: "a", stopped: "refused", turns: 1, costUsd: 0, selfVerified: false, headMoved: false, contextPressure: false, pinnedTruncated: false, exitReasons: [] });
    const recovered = builderSession(s.record.read(), "f01", 1)!;
    expect(recovered.stopDetails).toBeUndefined();
    expect(recordBuilderRefusal(s.deps, "f01", 1, recovered)).toBe("safety");
    expect(s.record.read().at(-1)).toMatchObject({ t: "failure", class: "refusal", category: "safety" });
  });

  test("checks and audits the first refusal, records it uncounted, restores, and picks the feature again", async () => {
    const s = setupLoop();
    s.git.diffText = " refused.ts | 1 +";
    s.builderResults.push(refusal("safety"), builderResult());

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });

    expect(s.builderCalls).toEqual(["f01", "f01"]);
    expect(s.checkCalls.map((call) => call.featureId)).toEqual(["f01", "f01"]);
    expect(s.auditCalls).toEqual(["f01", "f01"]);
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([
      expect.objectContaining({ attempt: 1, builderStopped: "refused", disposition: "refused", counted: false }),
      expect.objectContaining({ attempt: 2, disposition: "passed", counted: true }),
    ]);
    expect(s.record.read().filter((event) => event.t === "failure" && event.class === "refusal")).toEqual([
      expect.objectContaining({ category: "safety", message: "builder refused f01 attempt 1: safety" }),
    ]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1 });
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toContainEqual({
      method: "checkoutAndClean", dir: s.project.repo, restoreRef: "a".repeat(40),
    });
    expect(parseProgress(readFileSync(s.project.progress, "utf8")).map((entry) => entry.key)).toEqual([
      "f01:1:attempt:attempt-1", "f01:2:attempt:attempt-2",
    ]);
  });

  test("blocks and archives a feature after its second refusal using the second category", async () => {
    const s = setupLoop();
    s.builderResults.push(refusal("safety"), refusal("policy"));

    expect(await runBuild(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "blocked" });

    expect(s.builderCalls).toEqual(["f01", "f01"]);
    expect(s.checkCalls).toHaveLength(2);
    expect(s.auditCalls).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([
      expect.objectContaining({ attempt: 1, disposition: "refused", counted: false }),
      expect.objectContaining({ attempt: 2, disposition: "refused", counted: false }),
    ]);
    expect(foldState(s.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "refused:policy", attempts: 0 });
    expect(existsSync(join(s.project.blockedDir, "f01", "manifest.json"))).toBe(true);
    expect(s.git.commits).toHaveLength(0);
  });

  test("does not duplicate refusal accounting when a crash lands before restore", async () => {
    const s = setupLoop();
    s.builderResults.push(refusal("safety"), builderResult());
    s.deps.stepHook = (index) => { if (index === 7) throw new Error("crash"); };

    await expect(runBuild(s.deps)).rejects.toBeInstanceOf(BuildStepCrash);
    s.deps.stepHook = undefined;
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });

    expect(s.record.read().filter((event) => event.t === "failure" && event.class === "refusal")).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "attempt" && event.disposition === "refused")).toHaveLength(1);
    expect(s.builderCalls).toEqual(["f01", "f01"]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1 });
  });

  test("retains the refusal category when resuming from the durable builder boundary", async () => {
    const s = setupLoop();
    s.builderResults.push(refusal("safety"), builderResult());
    s.deps.stepHook = (index) => { if (index === 3) throw new Error("crash"); };

    await expect(runBuild(s.deps)).rejects.toBeInstanceOf(BuildStepCrash);
    s.deps.stepHook = undefined;
    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });

    expect(s.builderCalls).toEqual(["f01", "f01"]);
    expect(s.record.read().filter((event) => event.t === "failure" && event.class === "refusal")).toEqual([
      expect.objectContaining({ category: "safety", message: "builder refused f01 attempt 1: safety" }),
    ]);
    expect(s.record.read().filter((event) => event.t === "attempt" && event.disposition === "refused")).toEqual([
      expect.objectContaining({ attempt: 1, counted: false }),
    ]);
  });

  test("keeps the builder refusal disposition when the auditor also errors", async () => {
    const s = setupLoop();
    const baseAudit = s.deps.runAuditor!;
    let first = true;
    s.builderResults.push(refusal("safety"), builderResult());
    s.deps.runAuditor = async (...args) => {
      if (!first) return baseAudit(...args);
      first = false;
      throw new AuditorRunError("auditor server", { text: "", turns: 1, stopped: "error", costUsd: 0.4, error: "auditor server", errorStatus: 500 }, 0.4, true, "audit");
    };

    expect(await runBuild(s.deps)).toEqual({ outcome: "ok" });
    expect(s.record.read().filter((event) => event.t === "attempt")).toEqual([
      expect.objectContaining({ attempt: 1, disposition: "refused", counted: false, auditorCostUsd: 0.4 }),
      expect.objectContaining({ attempt: 2, disposition: "passed", counted: true }),
    ]);
    expect(foldState(s.deps.run).f01).toMatchObject({ passes: true, attempts: 1 });
  });
});
