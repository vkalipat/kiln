import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { initHome } from "../../src/core/home";
import { loadConfig, saveConfig } from "../../src/core/config";
import { createRun, writeStatus } from "../../src/core/run";
import { createRunExecutor, pairCensoredBy, type RunSummary } from "../../src/evals/executor";

const seed = { id: "dev-product-01", split: "dev" as const, sha256: "a".repeat(64) };

function summary(stop?: "budget" | "deadline" | "transient" | "stalled" | "rounds" | "blocked", state: "stopped" | "paused" = "stopped"): RunSummary {
  const outcome = stop ? { kind: "stopped" as const, stopKind: stop } : undefined;
  return {
    runId: "r", seedId: seed.id, split: seed.split, shape: "product", arm: "a",
    status: { id: "r", phase: "ideate", state, outcome, usdSpent: 0, turns: {}, createdAt: "x", updatedAt: "x" },
    outcome, costUsd: 0, metrics: {},
  };
}

describe("eval run executor", () => {
  test("classifies only pair-level censoring stops", () => {
    expect(pairCensoredBy([summary("budget"), summary("rounds"), summary("blocked"), summary("stalled")])).toEqual(["budget", "stalled"]);
    expect(pairCensoredBy([summary(undefined, "paused")])).toEqual(["deadline"]);
  });

  test("drives the direct phase chain through build without reflect", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const calls: string[] = [];
    const model = createMockModel({ id: "fixture", provider: "fixture" });
    const ok = { outcome: "ok" as const };
    const executor = createRunExecutor(real, {
      models: Object.fromEntries(["brain", "scout", "judge", "builder", "auditor", "critic", "reflector", "generator", "prober", "arbiter"].map((role) => [role, model])) as never,
      apiKeyFor: async () => "fixture",
      runFrame: async (d) => { calls.push("frame"); writeStatus(d.run, { phase: "discover" }); return ok; },
      runDiscover: async (d) => { calls.push("discover"); writeStatus(d.run, { phase: "ideate" }); return ok; },
      runIdeate: async (d) => {
        calls.push("ideate"); writeFileSync(d.run.frontier, JSON.stringify({ shown: ["idea-1"] }));
        writeStatus(d.run, { state: "stopped", cursor: { step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
        return { outcome: "stopped", stopKind: "rounds" };
      },
      runCheckpoint: async (d) => { calls.push("checkpoint"); writeStatus(d.run, { phase: "form", state: "running", chosenIdeaId: "idea-1", outcome: undefined }); return ok; },
      runForm: async (d) => { calls.push("form"); writeStatus(d.run, { phase: "build", state: "running" }); return ok; },
      runBuild: async (d) => { calls.push("build"); writeStatus(d.run, { state: "done", outcome: { kind: "success" } }); return ok; },
      runReflect: async () => { throw new Error("reflect must not run"); },
    });
    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "champion", through: "build", cloneAfter: "none", rounds: 1, runId: "eval-seed-a", effort: {} });
    expect(calls).toEqual(["frame", "discover", "ideate", "checkpoint", "form", "build"]);
    expect(result.status).toMatchObject({ state: "done", seed });
    expect(result.outcome).toEqual({ kind: "success" });
  });

  test("stops at ideate and requires callers to materialize clone boundaries", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const model = createMockModel({ id: "fixture", provider: "fixture" });
    const executor = createRunExecutor(real, {
      models: { brain: model as never }, apiKeyFor: async () => "fixture",
      runFrame: async (d) => { writeStatus(d.run, { state: "done", outcome: { kind: "honest_exit", exitKind: "underspecified", reasons: ["thin"] } }); return { outcome: "honest_exit", kind: "underspecified", reasons: ["thin"] }; },
    });
    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "champion", through: "ideate", cloneAfter: "none", rounds: 1, runId: "eval-seed-a", effort: {} });
    expect(result.outcome).toMatchObject({ kind: "honest_exit" });
    await expect(executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "candidate", through: "build", cloneAfter: "freeze", rounds: 1, runId: "missing-clone", effort: {} })).rejects.toThrow(/cloned eval run/);
  });

  test("enforces eval budget overrides, B0 bare semantics, and the removed judge gate", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const cfg = loadConfig(staged); cfg.evals.runBudgetUsd = 3; cfg.evals.runWallSeconds = 7; saveConfig(staged, cfg);
    const model = createMockModel({ id: "fixture", provider: "fixture" }); let observed: [number, number] | undefined;
    const executor = createRunExecutor(real, {
      models: { brain: model as never }, apiKeyFor: async () => "fixture",
      runFrame: async (d) => { observed = [d.cfg.budgets.usd, d.cfg.budgets.wallSeconds]; writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
      runDiscover: async (d) => { writeStatus(d.run, { phase: "ideate" }); return { outcome: "ok" }; },
      runBare: async (d) => { writeStatus(d.run, { state: "stopped", outcome: { kind: "stopped", stopKind: "rounds" } }); return { outcome: "stopped", stopKind: "rounds" }; },
      runIdeate: async () => { throw new Error("B0 must select bare"); },
    });
    await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "B0", through: "ideate", cloneAfter: "none", rounds: 1, runId: "budgeted", effort: {} });
    expect(observed).toEqual([3, 7]);

    const removed = loadConfig(staged); removed.evals.judgeGate = "removed"; saveConfig(staged, removed);
    await expect(executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "A0", through: "ideate", cloneAfter: "none", rounds: 1, runId: "refused", effort: {} })).rejects.toThrow(/judge_removed/);
  });

  test("allows an existing freeze to build when the judge gate is removed", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const cfg = loadConfig(staged); cfg.evals.judgeGate = "removed"; saveConfig(staged, cfg);
    const run = createRun(staged, "seed", { id: "frozen" });
    writeStatus(run, { phase: "build", state: "running", seed });
    const model = createMockModel({ id: "fixture", provider: "fixture" }); let builds = 0;
    const executor = createRunExecutor(real, {
      models: { builder: model as never }, apiKeyFor: async () => "fixture",
      runBuild: async (d) => { builds += 1; writeStatus(d.run, { state: "done", outcome: { kind: "success" } }); return { outcome: "ok" }; },
    });

    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "candidate", through: "build", cloneAfter: "freeze", rounds: 1, runId: run.id, effort: {} });
    expect(builds).toBe(1);
    expect(result.status.state).toBe("done");
  });

  test("does not dispatch a paused phase whose wake lies beyond the eval wall bound", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const cfg = loadConfig(staged); cfg.evals.runWallSeconds = 1; saveConfig(staged, cfg);
    const run = createRun(staged, "seed", { id: "paused" });
    writeStatus(run, { state: "paused", wakeAt: "1970-01-01T00:00:02.000Z", pausedReason: "usage" });
    let frameCalls = 0;
    const model = createMockModel({ id: "fixture", provider: "fixture" });
    const executor = createRunExecutor(real, {
      models: { brain: model as never }, apiKeyFor: async () => "fixture", now: () => 0,
      runFrame: async () => { frameCalls += 1; return { outcome: "ok" }; },
    });
    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "A0", through: "ideate", cloneAfter: "none", rounds: 1, runId: "paused", effort: {} });
    expect(frameCalls).toBe(0);
    expect(result.status.state).toBe("paused");
  });

  test("uses the ordinary run wall when no eval run-wall override exists", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const run = createRun(staged, "seed", { id: "paused-default-wall" });
    writeStatus(run, { state: "paused", wakeAt: "1970-01-01T05:00:00.000Z", pausedReason: "usage" });
    let sleeps = 0; let frameCalls = 0;
    const model = createMockModel({ id: "fixture", provider: "fixture" });
    const executor = createRunExecutor(real, {
      models: { brain: model as never }, apiKeyFor: async () => "fixture", now: () => 0,
      sleep: async () => { sleeps += 1; }, runFrame: async () => { frameCalls += 1; return { outcome: "ok" }; },
    });

    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "A0", through: "ideate", cloneAfter: "none", rounds: 1, runId: run.id, effort: {} });
    expect(sleeps).toBe(0);
    expect(frameCalls).toBe(0);
    expect(result.status.state).toBe("paused");
  });

  test("retains an earlier durable censor stop after later phases clear the status outcome", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const model = createMockModel({ id: "fixture", provider: "fixture" });
    const executor = createRunExecutor(real, {
      models: Object.fromEntries(["brain", "scout", "judge", "builder", "auditor", "critic", "generator", "prober", "arbiter"].map((role) => [role, model])) as never,
      apiKeyFor: async () => "fixture",
      runFrame: async (d) => { writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
      runDiscover: async (d) => { writeStatus(d.run, { phase: "ideate" }); return { outcome: "ok" }; },
      runIdeate: async (d) => {
        writeFileSync(d.run.frontier, JSON.stringify({ shown: ["idea-1"] }));
        d.record.append({ t: "stop", stopKind: "budget", round: 1 });
        writeStatus(d.run, { state: "stopped", cursor: { step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "budget" } });
        return { outcome: "stopped", stopKind: "budget" };
      },
      runCheckpoint: async (d) => { writeStatus(d.run, { phase: "form", state: "running", chosenIdeaId: "idea-1", outcome: undefined }); return { outcome: "ok" }; },
      runForm: async (d) => { writeStatus(d.run, { phase: "build", state: "running", outcome: undefined }); return { outcome: "ok" }; },
      runBuild: async (d) => { writeStatus(d.run, { state: "done", outcome: { kind: "success" } }); return { outcome: "ok" }; },
    });

    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "champion", through: "build", cloneAfter: "none", rounds: 1, runId: "durable-budget-stop", effort: {} });
    expect(result.outcome).toEqual({ kind: "success" });
    expect(result.censorStops).toEqual(["budget"]);
    expect(pairCensoredBy([result])).toEqual(["budget"]);
  });

  test("through form reaches the clone boundary without starting a build", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-executor-real-")); initHome(real);
    const staged = mkdtempSync(join(tmpdir(), "kiln-executor-stage-")); initHome(staged);
    const run = createRun(staged, "seed", { id: "formed" });
    writeFileSync(run.frontier, JSON.stringify({ shown: ["idea-1"] }));
    writeStatus(run, { phase: "form", state: "running", chosenIdeaId: "idea-1", seed });
    let builds = 0;
    const model = createMockModel({ id: "fixture", provider: "fixture" });
    const executor = createRunExecutor(real, {
      models: { brain: model as never }, apiKeyFor: async () => "fixture",
      runForm: async (d) => { writeStatus(d.run, { phase: "build", state: "running" }); return { outcome: "ok" }; },
      runBuild: async () => { builds += 1; return { outcome: "ok" }; },
    });
    const result = await executor({ home: staged, seedText: "seed", seedIdentity: seed, arm: "formed", through: "form", cloneAfter: "none", rounds: 1, runId: "formed", effort: {} });
    expect(result.status.phase).toBe("build");
    expect(builds).toBe(0);
  });
});
