import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES, defaultConfig, loadConfig, saveConfig } from "../../src/core/config";

describe("config", () => {
  test("defaults name every role and phase", () => {
    const c = defaultConfig();
    for (const r of ["brain","scout","judge","builder","auditor","critic","reflector"]) expect(c.roles[r as keyof typeof c.roles].length).toBeGreaterThan(0);
    expect(c.budgets.turns.frame).toBe(10);
    expect(c.budgets.turns.discover).toBe(20);
    expect(Object.values(c.budgets.share).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12);
    expect(c.budgets.share.ideate).toBe(0.42);
    expect(c.budgets.phaseBudgetUsd("ideate")).toBe(10.5);
    expect(c.budgets.phaseBudgetWallSeconds("build")).toBe(6840);
    expect(c.budgets.reflectReserveUsd).toBe(0.25);
  });
  test("round trips and fills missing keys", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    saveConfig(home, { ...defaultConfig(), autonomous: true });
    expect(loadConfig(home).autonomous).toBe(true);
    expect(loadConfig(home).budgets.turns.build).toBe(40);
    expect(loadConfig(home).budgets.phaseBudgetUsd("ideate")).toBe(10.5);
  });

  test("defaults and deep-merges evaluation and seating profiles", () => {
    const defaults = defaultConfig();
    expect(defaults.evals).toMatchObject({
      wallSeconds: 172800, pairsPerSeed: 4, sweepPairsPerSeed: 8, minPairs: 32,
      level: 0.95, minUncensoredSeeds: 8, noninferiorityMargin: 0.10,
      costRatioCap: 1.5, judgeGate: "calibrated",
    });
    expect(defaults.evals.sectionPhases.form).toEqual({ through: "build", cloneAfter: "checkpoint" });
    expect(defaults.evals.sectionPhases.build).toEqual({ through: "build", cloneAfter: "freeze" });
    expect(defaults.evals.rolePhases.critic).toEqual({ through: "build", cloneAfter: "checkpoint" });
    expect(defaults.seating.default.brain).toEqual(defaults.roles.brain);
    expect(defaults.seating.frontier.caps).toEqual({ builderUsdCap: 2.512, auditorUsdCap: 0.6654, expectedAttemptUsd: 2.069, maxFeatures: 4 });

    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      evals: { pairsPerSeed: 6, sectionPhases: { form: { cloneAfter: "freeze" } }, rolePhases: { critic: { through: "ideate" } } },
      seating: { default: { brain: ["test/brain"] }, frontier: { caps: { maxFeatures: 3 } } },
    }));
    const loaded = loadConfig(home);
    expect(loaded.evals.pairsPerSeed).toBe(6);
    expect(loaded.evals.sectionPhases.form).toEqual({ through: "build", cloneAfter: "freeze" });
    expect(loaded.evals.rolePhases.critic).toEqual({ through: "ideate", cloneAfter: "checkpoint" });
    expect(loaded.evals.sectionPhases.build).toEqual(defaults.evals.sectionPhases.build);
    expect(loaded.seating.default.brain).toEqual(["test/brain"]);
    expect(loaded.seating.frontier.caps).toEqual({ ...defaults.seating.frontier.caps, maxFeatures: 3 });
  });

  test("deep-merges balanced budget-share overrides and derives an allocation from the loaded dollar target", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ budgets: { usd: 10, share: { ideate: 0.5, build: 0.395 } } }));
    const c = loadConfig(home);
    expect(c.budgets.share.ideate).toBe(0.5);
    expect(c.budgets.share.build).toBe(0.395);
    expect(c.budgets.phaseBudgetUsd("ideate")).toBe(5);
  });

  test("rejects an effective share that is negative, non-finite, or does not sum to one", () => {
    for (const share of [{ ideate: 0.5 }, { ideate: -1, build: 1.895 }, { ideate: "nope", build: 0.895 }]) {
      const home = mkdtempSync(join(tmpdir(), "kiln-"));
      writeFileSync(join(home, "config.json"), JSON.stringify({ budgets: { share } }));
      expect(() => loadConfig(home)).toThrow(/budgets\.share/);
    }
  });
});

describe("config build section", () => {
  test("defaults include the binding model-practices repricing", () => {
    expect(defaultConfig().build).toEqual({
      maxAttempts: 3,
      sessionTurnCap: 40,
      auditorTurnCap: 15,
      auditorFailTurnCap: 8,
      builderUsdCap: 1.256,
      auditorUsdCap: 0.6948,
      checkTimeoutSeconds: 300,
      checkOutputBytes: 8_388_608,
      maxRegressionRepairs: 2,
      expectedAttempts: 1.3,
      expectedAttemptUsd: 1.240,
      expectedCheckSeconds: 30,
      expectedInitSeconds: 120,
      minFeatures: 3,
      maxFeatures: 12,
    });
  });

  test("defaults role effort and provider mechanics from the supervisor rulings", () => {
    const cfg = defaultConfig();
    expect(cfg.effort).toBe("medium");
    expect(cfg.effortByRole).toEqual({
      brain: "high", builder: "high", critic: "high",
      generator: "medium", judge: "medium", auditor: "medium", reflector: "medium",
      scout: "low", arbiter: "low", prober: "low",
    });
    expect(cfg.provider).toEqual({
      fallbacks: "opus",
      cacheRetention: {},
      thinkingDisplay: "summarized",
      batchNudge: true,
      reminders: "auto",
      promptCache: true,
      strictDecisionTools: true,
    });
  });

  test("deep-merges partial role effort and provider configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      effortByRole: { scout: "medium" },
      provider: { fallbacks: "off", cacheRetention: { builder: "long" } },
    }));
    const cfg = loadConfig(home);
    expect(cfg.effortByRole?.scout).toBe("medium");
    expect(cfg.effortByRole?.builder).toBe("high");
    expect(cfg.provider.fallbacks).toBe("off");
    expect(cfg.provider.cacheRetention).toEqual({ builder: "long" });
    expect(cfg.provider.strictDecisionTools).toBe(true);
  });

  test("deep-merges old and partial build/budget configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ build: { maxAttempts: 5 }, budgets: { reflectReserveUsd: 0.1 } }));
    const cfg = loadConfig(home);
    expect(cfg.build.maxAttempts).toBe(5);
    expect(cfg.build.sessionTurnCap).toBe(40);
    expect(cfg.budgets.reflectReserveUsd).toBe(0.1);
    expect(cfg.budgets.phaseBudgetWallSeconds("form")).toBe(792);
  });
});

describe("config ideation section", () => {
  test("defaults match the plan's global constraints exactly", () => {
    const c = defaultConfig();
    expect(c.ideation).toEqual({
      rounds: 3,
      islands: 3,
      ideasPerBatch: 5,
      cheapIsland: true,
      jaccardThreshold: 0.45,
      entrantsCap: 16,
      anchorsCap: 4,
      pairCap: 24,
      minComparisons: 3,
      arbiterCaps: { novelty: 30, collision: 22 },
      probe: { timeoutSeconds: 120, roundWallSeconds: 600 },
      scoutTurnCap: 6,
      mmrK: 4,
      checkpointMax: 8,
      checkpointMin: 5,
      webTimeoutMs: 30000,
      mailto: "kiln@example.invalid",
      searchHealthFloor: 0.8,
      concurrency: 4,
      searchConcurrency: 2,
      btLambda: 0.1,
      bootstrapSamples: 1000,
      dominanceLevel: 0.5,
      humanWeight: 3,
    });
  });
  test("the three new roles default to the strong / cheap lists", () => {
    const c = defaultConfig();
    expect(ROLES).toContain("generator");
    expect(ROLES).toContain("prober");
    expect(ROLES).toContain("arbiter");
    expect(c.roles.generator).toEqual(c.roles.brain);
    expect(c.roles.prober).toEqual(c.roles.scout);
    expect(c.roles.arbiter).toEqual(c.roles.scout);
  });
  test("an old config.json with no ideation section and no new roles still loads", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const old = {
      roles: { brain: ["anthropic/claude-opus-4-8"], scout: ["anthropic/claude-haiku-4-5"], judge: [], builder: [], auditor: [], critic: [], reflector: [] },
      effort: "high",
      budgets: { usd: 9, wallSeconds: 100, turns: { frame: 1 } },
      autonomous: true,
      preferApiKeys: true,
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(old));
    const c = loadConfig(home);
    expect(c.effort).toBe("high");
    expect(c.roles.brain).toEqual(["anthropic/claude-opus-4-8"]);
    expect(c.roles.generator).toEqual(defaultConfig().roles.generator);
    expect(c.roles.prober).toEqual(defaultConfig().roles.prober);
    expect(c.roles.arbiter).toEqual(defaultConfig().roles.arbiter);
    expect(c.ideation).toEqual(defaultConfig().ideation);
    expect(c.budgets.turns.build).toBe(40);
  });
  test("loadConfig deep-merges a partial ideation section, nested objects included", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ ideation: { rounds: 5, arbiterCaps: { novelty: 3 }, probe: { timeoutSeconds: 9 } } }),
    );
    const c = loadConfig(home);
    expect(c.ideation.rounds).toBe(5);
    expect(c.ideation.islands).toBe(3);
    expect(c.ideation.arbiterCaps).toEqual({ novelty: 3, collision: 22 });
    expect(c.ideation.probe).toEqual({ timeoutSeconds: 9, roundWallSeconds: 600 });
  });
  test("save then load round trips the ideation section", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const cfg = defaultConfig();
    cfg.ideation.pairCap = 12;
    cfg.ideation.probe.roundWallSeconds = 30;
    saveConfig(home, cfg);
    const back = loadConfig(home);
    expect(back.ideation.pairCap).toBe(12);
    expect(back.ideation.probe.roundWallSeconds).toBe(30);
    expect(back.ideation.probe.timeoutSeconds).toBe(120);
  });
});
