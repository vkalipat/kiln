import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KilnConfig } from "../../src/core/config";
import { loadConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import type { RunSummary, RunExecutorSpec } from "../../src/evals/executor";
import type { CollapsedJudgedPair } from "../../src/evals/wilson";
import { runM1 } from "../../src/evals/m1";
import { effortKey, writeEffortFile, type EffortEntry } from "../../src/evals/effort";
import type { Role } from "../../src/core/config";

const AT = "2026-09-05T00:00:00.000Z";
const FABLE = "anthropic/claude-fable-5-1";

type Arm = "A0" | "B0" | "A1" | "A2";

interface FixtureJudgeRequest {
  evalDir: string;
  seed: { id: string; text: string; shape: "research" | "product" | "creative" };
  a: { name: Arm; summary: RunSummary; home: string };
  b: { name: Arm; summary: RunSummary; home: string };
  pairsPerSeed: number;
}

interface ComparisonView {
  a: Arm;
  b: Arm;
  rows: Array<{
    seed: string;
    pairCensored: boolean;
    pairCensoredBy: string[];
    note?: string;
  }>;
  summary: {
    n: number;
    seeds: number;
    seedWins: number;
    pairCensored: number;
    honestExits: Partial<Record<Arm, number>>;
    failed: Partial<Record<string, number>>;
  };
}

interface M1View {
  evalId: string;
  status: "complete" | "incomplete";
  stoppedReason?: "budget" | "deadline";
  runs: RunSummary[];
  comparisons: ComparisonView[];
  costUsd: number;
  effortSwept: boolean;
  projection: {
    perArm: Partial<Record<Arm, { expectedUsd: number; ceilingUsd: number }>>;
    perSeedCell: { expectedUsd: number; ceilingUsd: number };
    total: { expectedUsd: number; ceilingUsd: number };
  };
  frozen: {
    k: number;
    rounds: number;
    seating: Record<Arm, string>;
    effort: Record<Arm, unknown>;
  };
}

interface FixtureOptions {
  alter?: (spec: RunExecutorSpec, summary: RunSummary) => RunSummary;
  failExecutorAt?: number;
  failJudgeAt?: number;
  runCostUsd?: number;
  projection?: { expectedUsd: number; ceilingUsd: number };
}

function fixture(options: FixtureOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-m1-"));
  initHome(home);
  const cfg = loadConfig(home);
  const calls: RunExecutorSpec[] = [];
  const judged: FixtureJudgeRequest[] = [];
  let executorAttempts = 0;
  let judgeAttempts = 0;

  const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
    executorAttempts += 1;
    if (options.failExecutorAt === executorAttempts) throw new Error("fixture process killed");
    calls.push(structuredClone(spec));
    const bare = spec.arm === "B0";
    const status = {
      id: spec.runId,
      phase: "ideate" as const,
      state: "stopped" as const,
      outcome: { kind: "stopped" as const, stopKind: "rounds" as const },
      usdSpent: options.runCostUsd ?? 0.25,
      turns: {},
      shape: spec.seedIdentity.id.includes("research") ? "research" as const
        : spec.seedIdentity.id.includes("creative") ? "creative" as const : "product" as const,
      seed: spec.seedIdentity,
      createdAt: AT,
      updatedAt: AT,
    };
    const shown = bare ? 10 : 4;
    const frontier = {
      mode: bare ? "bare" : "loop",
      shown: bare ? undefined : Array.from({ length: shown }, (_, i) => `${spec.runId}-shown-${i}`),
      rawFront: bare ? undefined : Array.from({ length: 6 }, (_, i) => `${spec.runId}-raw-${i}`),
      ideas: Array.from({ length: bare ? 10 : 6 }, (_, i) => ({ id: `${spec.runId}-idea-${i}`, backfill: !bare && i === 3 })),
    };
    const summary: RunSummary = {
      runId: spec.runId,
      seedId: spec.seedIdentity.id,
      split: "heldout",
      shape: status.shape,
      arm: spec.arm,
      status,
      outcome: status.outcome,
      costUsd: options.runCostUsd ?? 0.25,
      metrics: {
        frontier: { raw: bare ? 10 : 6, shown },
        collisionRate: bare ? 0.2 : 0.1,
        probes: { pass: 3, fail: 1, timeout: 0, error: 0, notRun: bare ? 6 : 2, passRate: 0.75 },
        honestExits: {
          total: 0,
          declaredNoIdea: 0,
          mechanicalNoIdea: 0,
          cannot_be_satisfied: { declared: 0 },
          not_formable: { mechanical: 0, declared: 0 },
        },
      },
      frontier,
    };
    return options.alter?.(spec, summary) ?? summary;
  };

  const judge = async (request: FixtureJudgeRequest): Promise<{ pairs: CollapsedJudgedPair[]; costUsd: number }> => {
    judgeAttempts += 1;
    if (options.failJudgeAt === judgeAttempts) throw new Error("fixture judge killed");
    judged.push(request);
    const pairs = Array.from({ length: request.pairsPerSeed }, (_, index) => ({
      seedId: request.seed.id,
      score: index === request.pairsPerSeed - 1 ? 0.5 : 1,
    }));
    return { pairs, costUsd: 0.02 };
  };

  const deps = {
    executor,
    judge,
    now: () => new Date(AT),
    ...(options.projection ? { projection: (_cfg: KilnConfig, _arm: Arm, _rounds: number) => ({ ...options.projection! }) } : {}),
  };
  return { home, cfg, calls, judged, deps, attempts: () => ({ executorAttempts, judgeAttempts }) };
}

async function run(f: ReturnType<typeof fixture>, options: Record<string, unknown> = {}): Promise<M1View> {
  return await runM1(f.home, f.cfg, {
    budgetUsd: 1_000,
    rounds: 1,
    evalId: "m1-fixture",
    ...options,
  }, f.deps as never) as unknown as M1View;
}

function byArm(calls: readonly RunExecutorSpec[], arm: Arm): RunExecutorSpec[] {
  return calls.filter((call) => call.arm === arm);
}

function stopped(summary: RunSummary, stopKind: "budget" | "deadline" | "transient" | "stalled"): RunSummary {
  return {
    ...summary,
    status: { ...summary.status, state: "stopped", outcome: { kind: "stopped", stopKind } },
    outcome: { kind: "stopped", stopKind },
  };
}

function sweptEntry(evalId: string): EffortEntry {
  return { winner: "medium", sweptLevels: ["low", "medium", "high"], metric: "pairWinRate", quality: 0.5, usdPerSuccess: 1, n: 96, at: AT, evalId };
}
describe("M1 runner", () => {
  test("runs A0, explicit bare B0, Fable-low A1, and frontier A2 in binding order", async () => {
    const f = fixture();
    const report = await run(f);

    expect(report.status).toBe("complete");
    expect(f.calls).toHaveLength(48);
    expect(f.calls.slice(0, 4).map((call) => call.arm)).toEqual(["A0", "B0", "A1", "A2"]);
    for (const arm of ["A0", "B0", "A1", "A2"] as const) {
      expect(byArm(f.calls, arm)).toHaveLength(12);
      expect(byArm(f.calls, arm).every((call) => call.through === "ideate" && call.cloneAfter === "none" && call.rounds === 1)).toBe(true);
    }
    expect(byArm(f.calls, "B0").every((call) => call.mode === "bare")).toBe(true);
    expect(byArm(f.calls, "A0").every((call) => call.mode !== "bare")).toBe(true);
    expect(f.calls.every((call) => call.runId === `m1-fixture-${call.seedIdentity.id}-${call.arm}`)).toBe(true);
    expect(new Set(f.calls.map((call) => call.seedIdentity.id)).size).toBe(12);

    const configs = Object.fromEntries((["A0", "B0", "A1", "A2"] as const).map((arm) => [arm, loadConfig(byArm(f.calls, arm)[0]!.home)])) as Record<Arm, KilnConfig>;
    expect(configs.B0.roles).toEqual(configs.A0.roles);
    for (const role of ["brain", "builder", "reflector", "generator"] as const) {
      expect(configs.A1.roles[role]).toEqual([FABLE]);
      expect(byArm(f.calls, "A1")[0]!.effort[role]).toMatchObject({ level: "low", source: "profile" });
    }
    expect(configs.A1.roles.scout).toEqual(configs.A0.roles.scout);
    expect(configs.A1.roles.judge).toEqual(configs.A0.roles.judge);
    expect(configs.A2.roles).toEqual({ ...configs.A0.roles, ...f.cfg.seating.frontier.roles });
    expect(configs.A2.build).toMatchObject(f.cfg.seating.frontier.caps);
    expect(report.frozen).toMatchObject({ k: 4, rounds: 1, seating: { A0: "default", B0: "default", A1: "fable-low", A2: "frontier" } });
  });

  test("builds exactly the three pre-registered paired tables with four pairs per seed", async () => {
    const f = fixture();
    const report = await run(f);

    expect(report.comparisons.map(({ a, b }) => [a, b])).toEqual([
      ["A0", "B0"],
      ["A1", "A0"],
      ["A2", "A0"],
    ]);
    expect(f.judged).toHaveLength(36);
    expect(f.judged.slice(0, 3).map(({ a, b }) => [a.name, b.name])).toEqual([
      ["A0", "B0"],
      ["A1", "A0"],
      ["A2", "A0"],
    ]);
    expect(f.judged.every((call) => call.pairsPerSeed === 4)).toBe(true);
    for (const table of report.comparisons) {
      expect(table.rows).toHaveLength(12);
      expect(table.summary).toMatchObject({ n: 48, seeds: 12, pairCensored: 0 });
      expect(table.rows[0]).toMatchObject({
        aMetrics: { frontier: { raw: expect.any(Number), shown: expect.any(Number), backfilled: expect.any(Number) }, collisionRate: expect.any(Number), probePassRate: 0.75, costUsd: 0.25 },
        bMetrics: { frontier: { raw: expect.any(Number), shown: expect.any(Number), backfilled: expect.any(Number) }, collisionRate: expect.any(Number), probePassRate: 0.75, costUsd: 0.25 },
      });
    }
    expect(report).toMatchObject({ judgeCalibration: { status: "absent" }, effortSwept: false });
    expect(report.comparisons[0]!.summary).toMatchObject({ seedRate: 1, prediction: "met", kill: "not met", perShape: { research: 0.875, product: 0.875, creative: 0.875 } });
  });

  test("requires sweep coverage only for M1's scored brain, generator, and judge seats", async () => {
    const f = fixture();
    const roles = Object.keys(f.cfg.roles) as Role[];
    const models = Object.fromEntries(roles.map((role) => [role, createMockModel({ id: role, provider: "mock" })])) as never;
    writeEffortFile(f.home, { version: 1, entries: Object.fromEntries(
      (["brain", "generator", "judge"] as const).map((role) => [effortKey(role, `mock/${role}`, "default"), sweptEntry(`sweep-${role}`)]),
    ) });
    const report = await runM1(f.home, f.cfg, {
      budgetUsd: 1_000, rounds: 1, evalId: "m1-scored-effort", fableLow: false, frontier: false,
    }, { ...f.deps, cli: { models, apiKeyFor: async () => "key" } } as never);
    expect(report.effortSweptByArm).toEqual({ A0: true, B0: true });
    expect(report.effortSwept).toBe(true);
  });

  test("skips A1 and A2 independently without changing A0/B0", async () => {
    const onlyBaseline = fixture();
    const baseline = await run(onlyBaseline, { fableLow: false, frontier: false });
    expect(new Set(onlyBaseline.calls.map((call) => call.arm))).toEqual(new Set(["A0", "B0"]));
    expect(baseline.comparisons.map(({ a, b }) => [a, b])).toEqual([["A0", "B0"]]);

    const noFrontier = fixture();
    const fable = await run(noFrontier, { frontier: false });
    expect(new Set(noFrontier.calls.map((call) => call.arm))).toEqual(new Set(["A0", "B0", "A1"]));
    expect(fable.comparisons.map(({ a, b }) => [a, b])).toEqual([["A0", "B0"], ["A1", "A0"]]);

    const noFable = fixture();
    const frontier = await run(noFable, { fableLow: false });
    expect(new Set(noFable.calls.map((call) => call.arm))).toEqual(new Set(["A0", "B0", "A2"]));
    expect(frontier.comparisons.map(({ a, b }) => [a, b])).toEqual([["A0", "B0"], ["A2", "A0"]]);
  });

  test("honest exits lose at seed level, leave pair n, and are never censored", async () => {
    const f = fixture({ alter: (spec, summary) => {
      if (spec.arm !== "A0" || spec.seedIdentity.id !== "heldout-research-01") return summary;
      const outcome = { kind: "honest_exit" as const, exitKind: "no_idea_clears_bar", reasons: ["fixture"] };
      return { ...summary, status: { ...summary.status, state: "done", outcome }, outcome };
    } });
    const report = await run(f);

    expect(f.judged).toHaveLength(33);
    for (const table of report.comparisons) {
      expect(table.summary.n).toBe(44);
      expect(table.summary.seeds).toBe(12);
      expect(table.summary.pairCensored).toBe(0);
      expect(table.summary.honestExits.A0).toBe(1);
      const row = table.rows.find((held) => held.seed === "heldout-research-01");
      expect(row).toMatchObject({ pairCensored: false });
      expect(row?.note).toContain("honest_exit");
    }
    expect(report.comparisons[0]!.summary.seedWins).toBe(11);
    expect(report.comparisons[1]!.summary.seedWins).toBe(12);
    expect(report.comparisons[2]!.summary.seedWins).toBe(12);
  });

  for (const stopKind of ["budget", "deadline", "transient", "stalled"] as const) {
    test(`censors a whole seed pair for ${stopKind} without manufacturing judged pairs`, async () => {
      const f = fixture({ alter: (spec, summary) => spec.arm === "B0" && spec.seedIdentity.id === "heldout-research-01"
        ? stopped(summary, stopKind) : summary });
      const report = await run(f, { fableLow: false, frontier: false });

      expect(f.judged).toHaveLength(11);
      expect(report.comparisons[0]!.summary).toMatchObject({ n: 44, seeds: 12, pairCensored: 1 });
      const row = report.comparisons[0]!.rows.find((held) => held.seed === "heldout-research-01");
      expect(row).toMatchObject({ pairCensored: true, pairCensoredBy: [stopKind] });
      expect(row?.note).toContain("pairCensored");
    });
  }

  test("excludes failed arms by class without treating them as censoring stops", async () => {
    const f = fixture({ alter: (spec, summary) => {
      if (spec.arm !== "B0" || spec.seedIdentity.id !== "heldout-research-01") return summary;
      const outcome = { kind: "failure" as const, failureClass: "verify" as const, message: "fixture" };
      return { ...summary, status: { ...summary.status, state: "failed", outcome }, outcome };
    } });
    const report = await run(f, { fableLow: false, frontier: false });

    expect(f.judged).toHaveLength(11);
    expect(report.comparisons[0]!.summary).toMatchObject({ n: 44, pairCensored: 0, failed: { verify: 1 } });
    const row = report.comparisons[0]!.rows.find((held) => held.seed === "heldout-research-01");
    expect(row).toMatchObject({ pairCensored: false });
    expect(row?.note).toContain("failed:verify");
  });

  test("uses the live seated model prices for loop-arm expected cost when a runtime is available", async () => {
    const projected = async (rate: number) => {
      const f = fixture(); const roles = Object.keys(f.cfg.roles) as Role[];
      const models = Object.fromEntries(roles.map((role) => [role, createMockModel({
        id: role, provider: "mock", cost: { input: rate, output: rate, cacheRead: 0, cacheWrite: 0 },
      } as never)])) as never;
      return runM1(f.home, f.cfg, { budgetUsd: 1_000, rounds: 1, evalId: `m1-live-${rate}`, fableLow: false, frontier: false }, {
        ...f.deps, cli: { models, apiKeyFor: async () => "key" },
      } as never);
    };
    const cheap = await projected(1); const expensive = await projected(10);
    expect(expensive.projection.perArm.A0!.expectedUsd).toBeGreaterThan(cheap.projection.perArm.A0!.expectedUsd);
    expect(expensive.projection.perArm.B0!.expectedUsd).toBeGreaterThan(cheap.projection.perArm.B0!.expectedUsd);
  });
  test("checks the per-seed-pair ceiling before the first paid call", async () => {
    const f = fixture({ projection: { expectedUsd: 2, ceilingUsd: 5 } });
    await expect(run(f, { budgetUsd: 4.99, fableLow: false, frontier: false })).rejects.toThrow(/budget.*ceiling|ceiling.*budget/i);
    expect(f.attempts()).toEqual({ executorAttempts: 0, judgeAttempts: 0 });
  });

  test("finishes an in-flight seed and skips the next whole cell when the remaining budget is below its ceiling", async () => {
    const f = fixture({ projection: { expectedUsd: 4, ceilingUsd: 5 }, runCostUsd: 4.9 });
    const report = await run(f, { budgetUsd: 15, fableLow: false, frontier: false });

    expect(report).toMatchObject({ status: "incomplete", stoppedReason: "budget" });
    expect(f.calls).toHaveLength(2);
    expect(f.judged).toHaveLength(1);
    expect(report.runs).toHaveLength(2);
    expect(report.costUsd).toBeCloseTo(9.82, 10);
  });

  test("freezes the config and refuses a changed live value before repeating work", async () => {
    const f = fixture();
    await run(f);
    const before = f.attempts();
    const changed = loadConfig(f.home);
    changed.evals.pairsPerSeed = 3;
    await expect(runM1(f.home, changed, { budgetUsd: 1_000, rounds: 1, evalId: "m1-fixture" }, f.deps as never)).rejects.toThrow(/pairsPerSeed|frozen|config/i);
    expect(f.attempts()).toEqual(before);
  });

  test("a completed rerun reuses every run and judged seed", async () => {
    const f = fixture();
    const first = await run(f);
    const before = f.attempts();
    const second = await run(f);

    expect(f.attempts()).toEqual(before);
    expect(second.runs).toEqual(first.runs);
    expect(second.comparisons).toEqual(first.comparisons);
    expect(readFileSync(join(f.home, "evolution", "reports", "m1-fixture", "eval.json"), "utf8")).toContain('"evalId": "m1-fixture"');
  });

  test("resumes after an executor interruption without repeating completed runs", async () => {
    const f = fixture({ failExecutorAt: 7 });
    await expect(run(f)).rejects.toThrow("fixture process killed");
    const finishedBefore = new Set(f.calls.map((call) => call.runId));
    expect(finishedBefore.size).toBe(6);
    expect(existsSync(join(f.home, "evolution", "reports", "m1-fixture", "eval.json"))).toBe(true);

    await run(f);
    const successfulIds = f.calls.map((call) => call.runId);
    expect(new Set(successfulIds).size).toBe(48);
    expect(successfulIds).toHaveLength(48);
  });

  test("resumes after a judge interruption without repeating persisted comparisons", async () => {
    const f = fixture({ failJudgeAt: 5 });
    await expect(run(f)).rejects.toThrow("fixture judge killed");
    const judgedBefore = f.judged.map((call) => `${call.seed.id}:${call.a.name}:${call.b.name}`);
    expect(judgedBefore).toHaveLength(4);

    await run(f);
    const judgedKeys = f.judged.map((call) => `${call.seed.id}:${call.a.name}:${call.b.name}`);
    expect(new Set(judgedKeys).size).toBe(36);
    expect(judgedKeys).toHaveLength(36);
  });
});
