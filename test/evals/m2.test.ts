import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { createRun, writeStatus, type RunOutcome, type RunStatus } from "../../src/core/run";
import { hashInput, RunRecord } from "../../src/core/record";
import type { Metrics } from "../../src/build/metrics";
import type { CostBlock } from "../../src/core/cost";
import type { RunExecutorSpec, RunSummary } from "../../src/evals/executor";
import { defaultM2Projection, runM2, type M2Projection, type M2Report } from "../../src/evals/m2";
import { cloneRunAcrossHomes } from "../../src/evals/clone";
import { effortKey, writeEffortFile, type EffortEntry } from "../../src/evals/effort";
import { loadSeeds } from "../../src/evals/seeds";
import { stageHome } from "../../src/evolution/stage";
import type { FeaturesFile } from "../../src/formation/features";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { projectPaths, writeProjectMarker } from "../../src/formation/paths";

const AT = "2026-09-05T12:00:00.000Z";

function status(
  id: string,
  phase: RunStatus["phase"],
  state: RunStatus["state"],
  outcome?: RunOutcome,
): RunStatus {
  return { id, phase, state, outcome, usdSpent: 0, turns: {}, createdAt: AT, updatedAt: AT };
}

function cost(usd: number, successes: number): CostBlock {
  return {
    usd,
    tokens: 1_000,
    turns: 4,
    successes,
    usdPerSuccess: successes === 0 ? null : usd / successes,
    tokensPerSuccess: successes === 0 ? null : 1_000 / successes,
    turnsPerSuccess: successes === 0 ? null : 4 / successes,
    cacheReadRatio: 0.5,
    cacheWrite: 100,
    reasoningTokens: 50,
  };
}

function honestExits(kind?: "cannot_be_satisfied" | "not_formable"): Metrics["honestExits"] {
  return {
    total: kind === undefined ? 0 : 1,
    declaredNoIdea: 0,
    mechanicalNoIdea: 0,
    cannot_be_satisfied: { declared: kind === "cannot_be_satisfied" ? 1 : 0 },
    not_formable: {
      mechanical: 0,
      declared: kind === "not_formable" ? 1 : 0,
    },
  };
}

interface BuildSummaryOptions {
  passed?: number;
  usd?: number;
  stopKind?: "budget" | "deadline" | "transient" | "stalled";
  honestExit?: "cannot_be_satisfied" | "not_formable";
  censored?: boolean;
  contextPressure?: number;
}

function summary(spec: RunExecutorSpec, options: BuildSummaryOptions = {}): RunSummary {
  const passed = options.passed ?? 0;
  const usd = options.usd ?? 0;
  const outcome: RunOutcome | undefined = options.honestExit
    ? { kind: "honest_exit", exitKind: options.honestExit, reasons: [options.honestExit] }
    : options.stopKind
      ? { kind: "stopped", stopKind: options.stopKind }
      : spec.through === "form"
        ? undefined
        : { kind: "success" };
  const state: RunStatus["state"] = spec.through === "form" ? "running" : options.stopKind ? "stopped" : "done";
  const arm = spec.buildArm ?? "fresh";
  return {
    runId: spec.runId,
    seedId: spec.seedIdentity.id,
    split: spec.seedIdentity.split,
    shape: spec.seedIdentity.id.includes("research") ? "research" : spec.seedIdentity.id.includes("creative") ? "creative" : "product",
    arm: spec.arm,
    status: status(spec.runId, "build", state, outcome),
    outcome,
    costUsd: usd,
    metrics: spec.through === "form" ? {} : {
      featuresPassed: { executed: passed, humanVerified: 0 },
      cost: { build: cost(usd, passed) },
      censored: options.censored ?? false,
      contextPressureByArm: {
        fresh: arm === "fresh" ? options.contextPressure ?? 0 : 0,
        single_session: arm === "single_session" ? options.contextPressure ?? 0 : 0,
      },
      honestExits: honestExits(options.honestExit),
    } as Partial<Metrics>,
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-m2-"));
  initHome(home);
  const cfg = defaultConfig();
  cfg.evals.runBudgetUsd = 8;
  cfg.evals.runWallSeconds = 90;
  cfg.budgets.turns.build = 17;
  saveConfig(home, cfg);
  const seeds = loadSeeds(home, "dev");
  return { home, cfg, seeds };
}

function reportPath(home: string, evalId: string): string {
  return join(home, "evolution", "reports", evalId, "eval.json");
}

function readReport(home: string, evalId: string): M2Report {
  return JSON.parse(readFileSync(reportPath(home, evalId), "utf8")) as M2Report;
}

function materializeFreeze(spec: RunExecutorSpec): void {
  const run = createRun(spec.home, spec.seedText, { id: spec.runId }); const project = projectPaths(run.project);
  for (const dir of [project.dir, project.repo, project.checksDir, project.blockedDir]) mkdirSync(dir, { recursive: true });
  writeProjectMarker(run.project, { runId: run.id, ideaId: "idea-1", kilnVersion: "test", createdAt: AT });
  const projectSpec = "# Spec\n\n## First milestone\nWorks.\n";
  const features: FeaturesFile = { version: 1, init: { needs: [] }, features: [
    { id: "f01", title: "one", description: "one", acceptance: { type: "file", path: "out.txt" } },
  ] };
  const specHash = hashInput(projectSpec); const lock = writeAcceptanceLock(features, specHash);
  const featureText = `${JSON.stringify(features, null, 2)}\n`; const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  writeFileSync(project.spec, projectSpec); writeFileSync(project.initSh, "#!/bin/sh\n");
  writeFileSync(run.features, featureText); writeFileSync(project.featuresMirror, featureText);
  writeFileSync(run.acceptanceLock, lockText); writeFileSync(project.lockMirror, lockText); writeFileSync(run.featureState, "");
  new RunRecord(run.record).append({ t: "freeze", featureCount: 1, lockIdsHash: lock.ids, lockHash: hashInput(lock), manualCount: 0, executableCount: 1, needsUnion: [], specHash });
  writeStatus(run, { phase: "build", state: "running", projectDir: realpathSync(run.project), specHash });
}

function sweptEntry(evalId: string): EffortEntry {
  return { winner: "medium", sweptLevels: ["low", "medium", "high"], metric: "featuresPassed.executed", quality: 0.5, usdPerSuccess: 1, n: 35, at: AT, evalId };
}

const PAIR_PROJECTION: M2Projection = { expectedUsd: 10, ceilingUsd: 20 };

describe("M2 runner", () => {
  test("forms each dev project once, clones the freeze, then builds both explicit arms at equal budgets", async () => {
    const f = setup();
    const calls: Array<{ kind: "execute"; spec: RunExecutorSpec } | { kind: "clone"; from: string; to: string }> = [];
    const seenBudgets: Array<{ usd: number; wall: number; turns: number }> = [];
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      calls.push({ kind: "execute", spec });
      const staged = loadConfig(spec.home);
      seenBudgets.push({
        usd: staged.evals.runBudgetUsd ?? staged.budgets.usd,
        wall: staged.evals.runWallSeconds ?? staged.budgets.wallSeconds,
        turns: staged.budgets.turns.build,
      });
      if (spec.through === "form") return summary(spec, { usd: 1 });
      if (spec.buildArm === "fresh") return summary(spec, { passed: 3, usd: 4, contextPressure: 1 });
      return summary(spec, { passed: 2, usd: 5, contextPressure: 2 });
    };

    const report = await runM2(f.home, f.cfg, { projects: 2, budgetUsd: 100, evalId: "m2-order" }, {
      executor,
      stage: stageHome,
      cloneRunAcrossHomes: ({ fromId, toId }: { fromId: string; toId: string }) => {
        calls.push({ kind: "clone", from: fromId, to: toId });
        return { id: toId } as never;
      },
      projection: () => PAIR_PROJECTION,
      now: () => new Date(AT),
    });

    expect(calls.map((call) => call.kind === "clone"
      ? `clone:${call.from}->${call.to}`
      : `${call.spec.seedIdentity.id}:${call.spec.through}:${call.spec.buildArm ?? "-"}`)).toEqual(f.seeds.slice(0, 2).flatMap((seed) => [
      `${seed.id}:form:-`,
      `clone:m2-order-${seed.id}-fresh->m2-order-${seed.id}-single_session`,
      `${seed.id}:build:fresh`,
      `${seed.id}:build:single_session`,
    ]));

    const executions = calls.flatMap((call) => call.kind === "execute" ? [call.spec] : []);
    expect(executions).toHaveLength(6);
    expect(executions.every((spec) => spec.seedIdentity.split === "dev")).toBe(true);
    expect(executions.filter((spec) => spec.through === "form")).toHaveLength(2);
    expect(executions.filter((spec) => spec.buildArm === "fresh")).toHaveLength(2);
    expect(executions.filter((spec) => spec.buildArm === "single_session")).toHaveLength(2);
    expect(executions.filter((spec) => spec.through === "form").every((spec) => spec.cloneAfter === "none")).toBe(true);
    expect(executions.filter((spec) => spec.through === "build").every((spec) => spec.cloneAfter === "freeze")).toBe(true);
    expect(new Set(executions.map((spec) => spec.home)).size).toBe(2);
    expect(seenBudgets.every((value) => value.usd === 8 && value.wall === 90 && value.turns === 17)).toBe(true);

    expect(report).toMatchObject({
      version: 1,
      evalId: "m2-order",
      status: "complete",
      projectsRequested: 2,
      projection: {
        perSeedPair: PAIR_PROJECTION,
        expectedUsd: 20,
        ceilingUsd: 40,
      },
      judgeCalibration: { status: "absent" },
    });
    expect(report.projects.map((project: { seedId: string }) => project.seedId)).toEqual(f.seeds.slice(0, 2).map((seed) => seed.id));
    expect(report.projects[0]).toMatchObject({
      pairCensored: false,
      pairCensoredBy: [],
      fresh: {
        metrics: {
          featuresPassed: { executed: 3 },
          cost: { build: { usdPerSuccess: 4 / 3 } },
          censored: false,
          contextPressureByArm: { fresh: 1, single_session: 0 },
          honestExits: { total: 0 },
        },
      },
      singleSession: {
        metrics: {
          featuresPassed: { executed: 2 },
          cost: { build: { usdPerSuccess: 2.5 } },
          censored: false,
          contextPressureByArm: { fresh: 0, single_session: 2 },
          honestExits: { total: 0 },
        },
      },
    });
    expect(readReport(f.home, "m2-order")).toEqual(report);
  });

  test("requires sweep coverage only for M2's scored builder and auditor seats", async () => {
    const f = setup();
    const roles = Object.keys(f.cfg.roles) as Role[];
    const models = Object.fromEntries(roles.map((role) => [role, createMockModel({ id: role, provider: "mock" })])) as never;
    writeEffortFile(f.home, { version: 1, entries: Object.fromEntries(
      (["builder", "auditor"] as const).map((role) => [effortKey(role, `mock/${role}`, "default"), sweptEntry(`sweep-${role}`)]),
    ) });
    const report = await runM2(f.home, f.cfg, { projects: 1, budgetUsd: 100, evalId: "m2-scored-effort" }, {
      executor: async (spec) => summary(spec), stage: stageHome,
      cloneRunAcrossHomes: ({ toId }) => ({ id: toId }) as never,
      projection: () => PAIR_PROJECTION, now: () => new Date(AT), cli: { models, apiKeyFor: async () => "key" },
    });

    expect(report.effortSweptByArm).toEqual({ fresh: true, single_session: true });
    expect(report.effortSwept).toBe(true);
  });

  test("uses the per-pair ceiling as the start floor and scales both projections by N", async () => {
    const f = setup();
    let calls = 0;
    const executor = async (spec: RunExecutorSpec) => { calls += 1; return summary(spec); };
    const deps = {
      executor,
      stage: stageHome,
      cloneRunAcrossHomes: () => ({ id: "unused" }) as never,
      projection: () => PAIR_PROJECTION,
      now: () => new Date(AT),
    };

    await expect(runM2(f.home, f.cfg, { projects: 3, budgetUsd: 19.99, evalId: "m2-floor" }, deps))
      .rejects.toThrow(/budget.*20\.00|20\.00.*budget/i);
    expect(calls).toBe(0);
    expect(existsSync(reportPath(f.home, "m2-floor"))).toBe(false);

    const report = await runM2(f.home, f.cfg, { projects: 3, budgetUsd: 100, evalId: "m2-projection" }, deps);
    expect(report.projection).toEqual({
      perSeedPair: PAIR_PROJECTION,
      expectedUsd: 30,
      ceilingUsd: 60,
    });
  });

  test("derives the default expected projection from the live build configuration", () => {
    const cfg = defaultConfig(); cfg.build.maxFeatures = 1; const oneFeature = defaultM2Projection(cfg);
    cfg.build.maxFeatures = 2; const twoFeatures = defaultM2Projection(cfg);
    expect(twoFeatures.expectedUsd - oneFeature.expectedUsd).toBeCloseTo(2 * cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd, 10);
    expect(twoFeatures.ceilingUsd).toBe(oneFeature.ceilingUsd);
  });

  test("keeps run censoring separate and reports both M2 honest exits per arm", async () => {
    const f = setup();
    let build = 0;
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      if (spec.through === "form") return summary(spec, { usd: 1 });
      build += 1;
      if (build === 1) return summary(spec, { usd: 2, honestExit: "cannot_be_satisfied" });
      if (build === 2) return summary(spec, { usd: 2, honestExit: "not_formable" });
      if (build === 3) return summary(spec, { passed: 1, usd: 2, censored: true });
      return summary(spec, { usd: 2, stopKind: "transient", censored: false });
    };
    const report = await runM2(f.home, f.cfg, { projects: 2, budgetUsd: 100, evalId: "m2-outcomes" }, {
      executor,
      stage: stageHome,
      cloneRunAcrossHomes: ({ toId }: { toId: string }) => ({ id: toId }) as never,
      projection: () => PAIR_PROJECTION,
      now: () => new Date(AT),
    });

    expect(report.projects[0]).toMatchObject({
      pairCensored: false,
      pairCensoredBy: [],
      fresh: {
        outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied" },
        metrics: { honestExits: { cannot_be_satisfied: { declared: 1 } } },
      },
      singleSession: {
        outcome: { kind: "honest_exit", exitKind: "not_formable" },
        metrics: { honestExits: { not_formable: { declared: 1 } } },
      },
    });
    expect(report.projects[1]).toMatchObject({
      pairCensored: true,
      pairCensoredBy: ["transient"],
      fresh: { metrics: { censored: true } },
      singleSession: { metrics: { censored: false } },
    });
  });

  test("records a terminal form outcome and continues without cloning or building it", async () => {
    const f = setup(); let clones = 0; const builds: string[] = [];
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      if (spec.through === "form" && spec.seedIdentity.id === f.seeds[0]!.id) {
        const value = summary(spec, { honestExit: "not_formable", usd: 1 });
        return { ...value, status: { ...value.status, phase: "form", state: "done" } };
      }
      if (spec.through === "form") return summary(spec, { usd: 1 });
      builds.push(spec.seedIdentity.id); return summary(spec, { passed: 1, usd: 3 });
    };
    const report = await runM2(f.home, f.cfg, { projects: 2, budgetUsd: 100, evalId: "m2-form-exit" }, {
      executor, stage: stageHome, projection: () => PAIR_PROJECTION, now: () => new Date(AT),
      cloneRunAcrossHomes: ({ toId }: { toId: string }) => { clones += 1; return { id: toId } as never; },
    });
    expect(report.status).toBe("complete");
    expect(report.arms).toEqual({ A: "fresh", B: "single_session" });
    expect(report.projects[0]).toMatchObject({ source: { outcome: { kind: "honest_exit", exitKind: "not_formable" } } });
    expect(report.projects[0]!.fresh).toBeUndefined();
    expect(report.projects[0]!.singleSession).toBeUndefined();
    expect(clones).toBe(1);
    expect(builds).toEqual([f.seeds[1]!.id, f.seeds[1]!.id]);
  });

  test("persists after every run and resumes without repeating completed work or clone calls", async () => {
    const f = setup();
    const evalId = "m2-resume";
    const executed: string[] = [];
    const cloned: string[] = [];
    let firstSeedCalls = 0;
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      executed.push(`${spec.seedIdentity.id}:${spec.through}:${spec.buildArm ?? "-"}`);
      if (spec.seedIdentity.id === f.seeds[0]!.id) {
        if (firstSeedCalls === 1) expect(readReport(f.home, evalId).projects[0]?.source).toBeDefined();
        if (firstSeedCalls === 2) expect(readReport(f.home, evalId).projects[0]?.fresh).toBeDefined();
        firstSeedCalls += 1;
      }
      if (spec.through === "form") return summary(spec, { usd: 1 });
      return summary(spec, { passed: 1, usd: 5 });
    };
    const deps = {
      executor,
      stage: stageHome,
      cloneRunAcrossHomes: ({ fromId, toId }: { fromId: string; toId: string }) => {
        const key = `${fromId}->${toId}`;
        if (cloned.includes(key)) throw new Error(`duplicate clone ${key}`);
        cloned.push(key);
        return { id: toId } as never;
      },
      projection: () => PAIR_PROJECTION,
      now: () => new Date(AT),
    };

    const partial = await runM2(f.home, f.cfg, { projects: 2, budgetUsd: 27, evalId }, deps);
    expect(partial).toMatchObject({ status: "incomplete", stoppedReason: "budget", costUsd: 9 });
    expect(partial.projects).toHaveLength(1);
    expect(executed).toHaveLength(3);
    expect(cloned).toHaveLength(1);

    const complete = await runM2(f.home, f.cfg, { projects: 2, budgetUsd: 60, evalId }, deps);
    expect(complete).toMatchObject({ status: "complete", costUsd: 18 });
    expect(complete.projects).toHaveLength(2);
    expect(executed).toHaveLength(6);
    expect(cloned).toHaveLength(2);
    expect(executed.filter((entry) => entry.startsWith(`${f.seeds[0]!.id}:`))).toHaveLength(3);
    expect(readReport(f.home, evalId)).toEqual(complete);
  });

  test("resumes an interrupted pair from its last persisted arm", async () => {
    const f = setup();
    const evalId = "m2-interrupted";
    const executed: string[] = [];
    let cloneCalls = 0;
    let interrupted = false;
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      const key = `${spec.through}:${spec.buildArm ?? "-"}`;
      executed.push(key);
      if (spec.buildArm === "single_session" && !interrupted) {
        interrupted = true;
        throw new Error("fixture process killed");
      }
      if (spec.through === "form") return summary(spec, { usd: 1 });
      return summary(spec, { passed: 1, usd: spec.buildArm === "fresh" ? 4 : 5 });
    };
    const deps = {
      executor,
      stage: stageHome,
      cloneRunAcrossHomes: ({ toId }: { toId: string }) => {
        cloneCalls += 1;
        return { id: toId } as never;
      },
      projection: () => PAIR_PROJECTION,
      now: () => new Date(AT),
    };

    await expect(runM2(f.home, f.cfg, { projects: 1, budgetUsd: 100, evalId }, deps)).rejects.toThrow("fixture process killed");
    expect(readReport(f.home, evalId).projects[0]).toMatchObject({ source: { costUsd: 1 }, fresh: { costUsd: 4 } });

    const report = await runM2(f.home, f.cfg, { projects: 1, budgetUsd: 100, evalId }, deps);
    expect(executed).toEqual(["form:-", "build:fresh", "build:single_session", "build:single_session"]);
    expect(cloneCalls).toBe(1);
    expect(report).toMatchObject({ status: "complete", costUsd: 8 });
  });

  test("adopts a valid clone published immediately before a crash and persists the adoption", async () => {
    const f = setup(); const evalId = "m2-clone-publish-crash";
    let cloneCalls = 0; let crash = true; let sawPersistedClone = false;
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      if (spec.through === "form") { materializeFreeze(spec); return summary(spec, { usd: 1 }); }
      sawPersistedClone ||= readReport(f.home, evalId).projects[0]?.cloned === true;
      return summary(spec, { passed: 1, usd: spec.buildArm === "fresh" ? 4 : 5 });
    };
    const clone = (options: Parameters<typeof cloneRunAcrossHomes>[0]) => {
      cloneCalls += 1; const target = cloneRunAcrossHomes(options);
      if (crash) { crash = false; throw new Error("fixture process killed after clone publication"); }
      return target;
    };
    const deps = { executor, stage: stageHome, cloneRunAcrossHomes: clone, projection: () => PAIR_PROJECTION, now: () => new Date(AT) };
    await expect(runM2(f.home, f.cfg, { projects: 1, budgetUsd: 100, evalId }, deps)).rejects.toThrow("after clone publication");
    expect(readReport(f.home, evalId).projects[0]?.cloned).toBeUndefined();
    const report = await runM2(f.home, f.cfg, { projects: 1, budgetUsd: 100, evalId }, deps);
    expect(cloneCalls).toBe(1); expect(sawPersistedClone).toBe(true);
    expect(report.projects[0]?.cloned).toBe(true); expect(readReport(f.home, evalId).projects[0]?.cloned).toBe(true);
  });

});
