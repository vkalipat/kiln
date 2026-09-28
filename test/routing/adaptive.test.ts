import { describe, expect, test } from "bun:test";
import { getBundledModel, type GeneratedProvider } from "@oh-my-pi/pi-catalog";
import { defaultConfig, ROLES } from "../../src/core/config";
import { isKilnToolModelSupported, resolveRoleOn, otherProvider } from "../../src/providers/models";
import { registerRuntimeEffort } from "../../src/providers/effort-runtime";
import { DEFAULT_EVIDENCE_SNAPSHOT, planAdaptiveRouting as planCurrentRouting, validateEvidenceSnapshot } from "../../src/routing/adaptive";
import { workloadPreferenceFor } from "../../src/routing/workloads";
import { applyWorkflowProfile } from "../../src/workflow/profile";
import { compileWorkflow, planWorkflow } from "../../src/workflow/plan";

import historicalSnapshot from "../../src/routing/evidence-2026-09-09.json";

const now = new Date("2026-09-09T12:00:00Z");
const providers = new Set(["anthropic", "openai-codex"]);
const snapshot = () => structuredClone(historicalSnapshot) as any;

const planAdaptiveRouting: typeof planCurrentRouting = (cfg, available, seed, clock = now, evidence = snapshot(), options) =>
  planCurrentRouting(cfg, available, seed, clock, evidence, options);

describe("adaptive routing planner", () => {
  test("equal producer scores disclose deterministic order without inventing a winner margin", () => {
    const { report } = planAdaptiveRouting(defaultConfig(), providers, "Write a clear essay", now);
    expect(report.selectedRoleRefs.generator).toBe("anthropic/claude-fable-5-1");
    expect(report.roleReasons.generator.reason).toContain("Published point-score tie");
    expect(report.roleReasons.generator.reason).toContain("deterministic evidence order");
    expect(report.roleReasons.generator.reason).not.toContain("reviewer vendor preference");
  });

  test("records role-specific selection evidence and independence rather than opaque model names", () => {
    const { report } = planAdaptiveRouting(defaultConfig(), providers, "Find a business idea", now);
    for (const role of ROLES) {
      const why = report.roleReasons[role];
      expect(why.reason).toContain("Effort follows");
      expect(report.evidence.sources.some((source) => source.id === why.sourceId)).toBe(true);
      expect(why.selection === "ranked" ? Number.isFinite(why.score) : why.score === null).toBe(true);
    }
    expect(report.roleReasons.generator.category).toBe("business");
    expect(report.roleReasons.auditor.reviewAgainst).toBe(report.selectedRoleRefs.builder);
    expect(report.roleReasons.judge.reviewAgainst).toBe(report.selectedRoleRefs.generator);
    expect(report.roleReasons.scout.reviewAgainst).toBe(report.selectedRoleRefs.brain);
  });

  test("uses the prospective Astra preference for a computational-biology workload without calling it benchmark leadership", () => {
    const cfg = defaultConfig();
    const before = JSON.stringify(cfg);
    const { config, report } = planAdaptiveRouting(
      cfg,
      providers,
      "Build a virtual-cell Perturb-seq model for single-cell GFP protein binding",
      now,
    );
    const producers = ["brain", "generator", "builder", "prober", "reflector"] as const;
    expect(report.workloadPreference).toMatchObject({
      policy: "prospective_user_workload_preference_v1",
      workload: "computational_biology_vcc",
      requestedModelRef: "openai-codex/gpt-6-astra",
      status: "applied",
      producingRoles: producers,
    });
    expect(report.domain).toBe("science");
    expect(report.selectionPolicy).toBe("quality_first_with_workload_preference");
    expect(report.workloadPreference.reason).toContain("user/workload preference");
    expect(report.workloadPreference.reason).toContain("not biology benchmark evidence");
    for (const role of producers) {
      expect(report.selectedRoleRefs[role]).toBe("openai-codex/gpt-6-astra");
      expect(report.roleReasons[role].selection).toBe("workload_preference");
    }
    expect(report.selectedRoleRefs.critic).not.toBe(report.selectedRoleRefs.brain);
    expect(report.selectedRoleRefs.judge).not.toBe(report.selectedRoleRefs.generator);
    expect(report.selectedRoleRefs.auditor).not.toBe(report.selectedRoleRefs.builder);
    expect(report.selectedRoleRefs.scout).not.toBe(report.selectedRoleRefs.brain);
    expect(report.selectedRoleRefs.arbiter).not.toBe(report.selectedRoleRefs.generator);
    expect(config.budgets.usd).toBe(cfg.budgets.usd);
    expect(config.budgets.wallSeconds).toBe(cfg.budgets.wallSeconds);
    expect(config.ideation.minComparisons).toBe(cfg.ideation.minComparisons);
    expect(report.portfolio.candidates).toBeGreaterThanOrEqual(cfg.ideation.minComparisons + 1);
    expect(report.budget.projectedRoundUsd).toBeLessThanOrEqual(report.budget.ideateUsd);
    expect(report.warnings.some((warning) => warning.includes("not automatic retries"))).toBe(true);
    expect(JSON.stringify(cfg)).toBe(before);
  });

  test("reports an unavailable workload preference and the actually selected fallbacks without claiming Astra use", () => {
    const { report } = planAdaptiveRouting(
      defaultConfig(),
      new Set(["anthropic"]),
      "Use bioinformatics to design a GFP minibinder",
      now,
    );
    expect(report.workloadPreference.status).toBe("unavailable");
    expect(report.workloadPreference.reason).toContain("provider openai-codex is not connected");
    expect(report.workloadPreference.reason).toContain("Normal evidence-ranked/configured fallbacks were selected");
    expect(report.workloadPreference.reason).toContain("Astra was not used");
    for (const role of report.workloadPreference.producingRoles) {
      expect(report.selectedRoleRefs[role]).not.toBe("openai-codex/gpt-6-astra");
      expect(report.workloadPreference.reason).toContain(role + "=" + report.selectedRoleRefs[role]);
    }
    expect(report.warnings).toContain(report.workloadPreference.reason);
  });

  test.each([
    "Train a VirtualCell model",
    "Model Perturb-seq responses",
    "Analyze a single-cell transcriptomics dataset",
    "Create a bioinformatics pipeline",
    "Design a GFP protein binder",
  ])("recognizes high-signal computational-biology workload %j", (seed) => {
    expect(workloadPreferenceFor(seed)?.workload).toBe("computational_biology_vcc");
  });

  test.each([
    "Format the cell column in a business spreadsheet",
    "Update a single cell in the business spreadsheet",
    "Simulate a unit cell in condensed-matter physics",
    "Build a cell-phone pricing business",
    "Find a general startup idea",
  ])("does not apply the biology preference to unrelated workload %j", (seed) => {
    expect(workloadPreferenceFor(seed)).toBeUndefined();
    const { report } = planAdaptiveRouting(defaultConfig(), providers, seed, now);
    expect(report.workloadPreference.status).toBe("not_applicable");
    expect(report.workloadPreference.requestedModelRef).toBeNull();
    expect(Object.values(report.roleReasons).every(({ selection }) => selection !== "workload_preference")).toBe(true);
  });
  test("selects category leaders, independent review, and a feasible whole-round plan without mutation", () => {
    const cfg = defaultConfig(); const before = JSON.stringify(cfg);
    const { config, report } = planAdaptiveRouting(cfg, providers, "Find a business idea", now);
    expect(report.domain).toBe("business");
    expect(config.roles.generator[0]).toBe("anthropic/claude-fable-5-1");
    expect(config.roles.builder[0]).toBe("openai-codex/gpt-6-astra");
    expect(config.roles.judge[0]).toBe("openai-codex/gpt-6-astra");
    expect(report.workloadPreference.status).toBe("not_applicable");
    expect(report.budget.affordableRounds).toBeGreaterThanOrEqual(1);
    expect(report.budget.affordableRounds).toBeLessThanOrEqual(report.budget.requestedRounds);
    expect(config.ideation.rounds).toBe(report.budget.affordableRounds);
    expect(report.budget.projectedRoundUsd).toBeLessThanOrEqual(report.budget.ideateUsd);
    expect(Object.values(config.budgets.share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(config.budgets.usd).toBe(cfg.budgets.usd); expect(config.budgets.wallSeconds).toBe(cfg.budgets.wallSeconds);
    expect(config.build).toEqual(cfg.build); expect(config.budgets.turns).toEqual(cfg.budgets.turns);
    expect(JSON.stringify(cfg)).toBe(before);
    for (const role of ROLES) expect(config.seating.default[role]).toEqual(config.roles[role]);
    expect(config.roles.builder).toContain("openai-codex/gpt-6-astra");
    expect(report.roleRefs).toEqual(config.roles);
    for (const ref of Object.values(report.selectedRoleRefs)) {
      const [provider, id] = ref.split("/");
      const model = getBundledModel(provider as GeneratedProvider, id!);
      expect(isKilnToolModelSupported(model)).toBe(true);
    }
  });

  test("fits a complete small portfolio to the native 25-minute plan without reducing verification", () => {
    const seed = "Find a new business idea and ship it";
    const workflow = planWorkflow(seed);
    const cfg = applyWorkflowProfile(defaultConfig(), workflow);
    cfg.budgets.usd = 25;
    cfg.budgets.wallSeconds = 1500;
    cfg.effort = "xhigh";
    cfg.effortByRole = Object.fromEntries(ROLES.map((role) => [role, "xhigh"]));
    const phases = compileWorkflow(workflow, {}).phases;
    const { config, report } = planAdaptiveRouting(cfg, new Set(["anthropic"]), seed, now, snapshot(), { phases });
    expect(report.selectedRoleRefs).toMatchObject({
      generator: "anthropic/claude-fable-5-1",
      prober: "anthropic/claude-fable-5-1",
      scout: "anthropic/claude-opus-5",
      judge: "anthropic/claude-opus-5",
    });
    expect(report.portfolio).toMatchObject({
      originalCandidates: 30,
      candidates: 8,
      islands: 2,
      ideasPerBatch: 2,
      entrants: 8,
      pairs: 12,
      planningCallsWithRetryReserve: 157,
      estimatedRoundWallSeconds: 560,
    });
    expect(config.ideation).toMatchObject({ minComparisons: 3, pairCap: 12, checkpointMin: 5, checkpointMax: 8 });
    expect(config.ideation.rounds).toBe(1);
    expect(report.budget.projectedRoundUsd).toBeCloseTo(7.8275, 8);
    expect(report.budget.projectedRoundWallSeconds).toBe(560);
    expect(report.budget.ideateUsd).toBe(10);
    expect(report.budget.buildUsd).toBe(7.5);
    expect(report.warnings.some((warning) => warning.includes("not a completion guarantee"))).toBe(true);
  });

  test("a checkpoint-only ten-dollar plan uses its unplanned build share for the minimum portfolio", () => {
    const cfg = applyWorkflowProfile(defaultConfig(), planWorkflow("Find a business idea"));
    cfg.budgets.usd = 10;
    cfg.budgets.wallSeconds = 1500;
    const { config, report } = planAdaptiveRouting(cfg, new Set(["anthropic"]), "Find a business idea", now, snapshot(), {
      phases: ["frame", "discover", "ideate", "checkpoint"],
    });
    expect(report.portfolio.candidates).toBe(cfg.ideation.minComparisons + 1);
    expect(report.portfolio.islands).toBe(2);
    expect(config.ideation.rounds).toBe(1);
    expect(report.budget.ideateUsd).toBeGreaterThan(4);
    expect(report.budget.buildUsd).toBeLessThan(3);
  });

  test("a ten-dollar mixed-provider plan refuses before dispatch rather than silently lowering its selected models", () => {
    const cfg = applyWorkflowProfile(defaultConfig(), planWorkflow("Find a business idea"));
    cfg.budgets.usd = 10;
    cfg.budgets.wallSeconds = 1500;
    expect(() => planAdaptiveRouting(cfg, providers, "Find a business idea", now, snapshot(), {
      phases: ["frame", "discover", "ideate", "checkpoint"],
    })).toThrow("smallest valid 4-candidate portfolio");
  });

  test.each([["anthropic"], ["openai-codex"], ["openai"], ["openai", "openai-codex"]])("single-vendor transport combination %j preserves distinct model identities", (...items) => {
    const available = new Set(items as string[]);
    const { config } = planAdaptiveRouting(defaultConfig(), available, "Research a science idea", now);
    const id = (role: keyof typeof config.roles) => config.roles[role][0]!.split("/")[1];
    expect(id("generator")).not.toBe(id("judge")); expect(id("prober")).not.toBe(id("judge"));
    expect(id("builder")).not.toBe(id("auditor")); expect(id("brain")).not.toBe(id("critic"));
    for (const [producer, reviewer] of [["brain", "critic"], ["builder", "auditor"]] as const) {
      const provider = config.roles[producer][0]!.split("/")[0]!;
      const other = otherProvider(provider, available)!;
      expect(resolveRoleOn(reviewer, other, config, available, config.roles[producer][0]).model.id).not.toBe(id(producer));
    }
  });

  test("updated reviewed rankings affect the relevant domain instead of hardcoding Fable", () => {
    const evidence = snapshot();
    evidence.rankings.find((r: any) => r.category === "business").entries = [
      { modelRef: "anthropic/claude-opus-5", score: 2000 },
      { modelRef: "anthropic/claude-fable-5-1", score: 1600 },
    ];
    const business = planAdaptiveRouting(defaultConfig(), providers, "A startup business idea", now, evidence);
    const science = planAdaptiveRouting(defaultConfig(), providers, "A scientific research idea", now, evidence);
    expect(business.config.roles.generator[0]).toContain("claude-opus-5");
    expect(science.config.roles.generator[0]).toContain("claude-fable-5-1");
    expect(business.config.roles.generator[0]).not.toBe(business.config.roles.judge[0]);
  });

  test("unavailable future model entries are skipped without fabricating catalog support", () => {
    const evidence = snapshot();
    evidence.rankings.find((r: any) => r.category === "business").entries.unshift({ modelRef: "anthropic/not-a-real-model", score: 9999 });
    expect(planAdaptiveRouting(defaultConfig(), providers, "A business", now, evidence).config.roles.generator[0]).toBe("anthropic/claude-fable-5-1");
  });

  test("quality outranks vendor diversity and adapter-eligible leaders are explicitly selected", () => {
    const { report } = planAdaptiveRouting(defaultConfig(), providers, "A business idea", now);
    expect(report.selectedRoleRefs.judge).toBe("openai-codex/gpt-6-astra");
    expect(report.selectedRoleRefs.critic).toBe("openai-codex/gpt-6-astra");
    expect(report.selectedRoleRefs.auditor).toBe("anthropic/claude-fable-5-1");
    expect(report.roleReasons.judge.benchmarkEffort).toBe("high");
    expect(report.roleReasons.builder.benchmarkConditions).toContain("Codex");
    expect(report.unavailableRankedModels.some(({ modelRef }) => modelRef === "openai-codex/gpt-6-astra")).toBe(false);
    expect(report.selectedRoleRefs.judge).not.toBe(report.selectedRoleRefs.generator);
    expect(report.selectedRoleRefs.critic).not.toBe(report.selectedRoleRefs.brain);
    expect(report.selectedRoleRefs.auditor).not.toBe(report.selectedRoleRefs.builder);
    expect(report.warnings.some((warning) => warning.includes("benchmark effort"))).toBe(true);
  });

  test("cross-vendor candidates win score ties but not over higher quality", () => {
    const evidence = snapshot();
    const entries = evidence.rankings.find((ranking: any) => ranking.category === "knowledge_calibration").entries;
    const opus = entries.find((entry: any) => entry.modelRef === "anthropic/claude-opus-5");
    entries.find((entry: any) => entry.modelRef === "openai-codex/gpt-6-astra").score = 0;
    entries.find((entry: any) => entry.modelRef === "openai-codex/gpt-5.5").score = opus.score;
    const { report } = planAdaptiveRouting(defaultConfig(), providers, "business", now, evidence);
    expect(report.selectedRoleRefs.judge).toBe("openai-codex/gpt-5.5");
    expect(report.roleReasons.judge.reason).toContain("Published point-score tie");
    expect(report.roleReasons.judge.reason).toContain("reviewer vendor preference");
  });

  test("fails before execution when budget or provider constraints cannot be met", () => {
    const cfg = defaultConfig(); cfg.budgets.usd = 0.01;
    expect(() => planAdaptiveRouting(cfg, providers, "idea", now)).toThrow("one ideation round");
    expect(() => planAdaptiveRouting(defaultConfig(), new Set(), "idea", now)).toThrow("no supported available model");
    cfg.budgets.usd = 5;
    expect(() => planAdaptiveRouting(cfg, new Set(["openai"]), "general idea", now)).toThrow("one ideation round");
    expect(() => planAdaptiveRouting(cfg, new Set(["openai"]), "implement supplied work", now, snapshot(), {
      phases: ["frame", "form", "build", "reflect"],
    })).toThrow("configured minimum");
  });

  test("an exploration-only workflow does not reserve or validate an unplanned build", () => {
    const cfg = defaultConfig();
    cfg.build.minFeatures = 100;
    const before = cfg.budgets.phaseBudgetUsd("build");
    const { config, report } = planAdaptiveRouting(
      cfg,
      providers,
      "Explore research directions",
      now,
      snapshot(),
      { phases: ["frame", "discover", "ideate", "checkpoint"] },
    );
    expect(report.workflow.phases).toEqual(["frame", "discover", "ideate", "checkpoint"]);
    expect(report.workflow.buildPlanned).toBe(false);
    expect(report.budget.maxBuildFeatures).toBe(0);
    expect(report.budget.affordableRounds).toBeGreaterThanOrEqual(1);
    expect(report.budget.ideateUsd).toBeGreaterThan(cfg.budgets.phaseBudgetUsd("ideate"));
    expect(report.budget.buildUsd).toBeLessThan(before);
    expect(config.build).toEqual(cfg.build);
  });

  test("a direct build workflow does not require, price, or reserve ideation", () => {
    const cfg = defaultConfig();
    cfg.ideation.rounds = 0;
    cfg.ideation.islands = 0;
    const initialBuild = cfg.budgets.phaseBudgetUsd("build");
    const initialIdeate = cfg.budgets.phaseBudgetUsd("ideate");
    const { config, report } = planAdaptiveRouting(
      cfg,
      providers,
      "Implement the supplied specification",
      now,
      snapshot(),
      { phases: ["frame", "form", "build", "reflect"] },
    );
    expect(report.workflow.ideationPlanned).toBe(false);
    expect(report.workflow.buildPlanned).toBe(true);
    expect(report.budget.projectedRoundUsd).toBe(0);
    expect(report.budget.affordableRounds).toBe(0);
    expect(report.budget.ideateUsd).toBe(0);
    expect(report.budget.buildUsd).toBeCloseTo(initialBuild + initialIdeate, 12);
    expect(config.ideation.rounds).toBe(0);
  });

  test("rejects malformed adaptive phase options before producing a misleading report", () => {
    expect(() => planAdaptiveRouting(defaultConfig(), providers, "idea", now, snapshot(), { phases: [] })).toThrow("workflow phases");
    expect(() => planAdaptiveRouting(defaultConfig(), providers, "idea", now, snapshot(), { phases: ["made-up" as any] })).toThrow("workflow phases");
  });

  test("reports the runtime measured effort that requests will actually use", () => {
    const cfg = defaultConfig();
    registerRuntimeEffort(cfg, (role) => role === "generator" ? "max" : undefined);
    try {
      expect(planAdaptiveRouting(cfg, providers, "business idea", now).report.effectiveEffort.generator).toBe("max");
    } finally {
      registerRuntimeEffort(cfg);
    }
  });
});

describe("benchmark evidence validation", () => {
  test("accepts reviewed source-linked evidence", () => {
    expect(validateEvidenceSnapshot(snapshot(), now).rankings).toHaveLength(6);
    expect(validateEvidenceSnapshot(snapshot(), now).rankings[0]!.entries[0]!.conditions).toContain("fallback");
  });
  test("rejects stale, future, unverified, nonfinite, and unsupported-category data", () => {
    expect(() => validateEvidenceSnapshot(snapshot(), new Date("2027-01-01"))).toThrow("stale");
    const future = snapshot(); future.asOf = "2027-01-01";
    expect(() => validateEvidenceSnapshot(future, now)).toThrow("future");
    const unverified = snapshot(); unverified.verification.status = "unverified";
    expect(() => validateEvidenceSnapshot(unverified, now)).toThrow("unverified");
    const nonfinite = snapshot(); nonfinite.rankings[0].entries[0].score = Infinity;
    expect(() => validateEvidenceSnapshot(nonfinite, now)).toThrow("non-finite");
    const category = snapshot(); category.rankings[0].category = "made-up";
    expect(() => validateEvidenceSnapshot(category, now)).toThrow("category");
  });
  test("rejects credential-bearing and non-HTTPS source URLs", () => {
    for (const url of ["http://example.com", "https://user:secret@example.com/"]) {
      const evidence = snapshot(); evidence.sources[0].url = url;
      expect(() => validateEvidenceSnapshot(evidence, now)).toThrow("credential-free HTTPS");
    }
  });
});

describe("current reviewed benchmark bundle", () => {
  test("refreshes all six categories together and routes from the September 28 evidence", () => {
    const clock = new Date("2026-09-28T12:00:00Z");
    const evidence = validateEvidenceSnapshot(DEFAULT_EVIDENCE_SNAPSHOT, clock);
    expect(evidence.asOf).toBe("2026-09-28");
    expect(evidence.rankings).toHaveLength(6);
    for (const ranking of evidence.rankings) {
      const leaders = [...ranking.entries].sort((a, b) => ranking.higherIsBetter ? b.score - a.score : a.score - b.score);
      const leader = ranking.category === "tool_execution" || ranking.category === "knowledge_calibration"
        ? "openai-codex/gpt-6-astra" : ranking.category === "expert_knowledge"
        ? "anthropic/claude-fable-5-1" : "anthropic/claude-opus-5-5";
      expect(leaders[0]!.modelRef).toBe(leader);
      expect(evidence.sources.some((source) => source.id === ranking.sourceId)).toBe(true);
    }
    for (const seed of ["Write a clear essay", "Investigate physics research", "Find a business idea"]) {
      const { report } = planCurrentRouting(defaultConfig(), providers, seed, clock);
      expect(report.evidence.asOf).toBe(evidence.asOf);
      expect(report.selectedRoleRefs.generator).toBe(seed.includes("physics") ? "anthropic/claude-fable-5-1" : "anthropic/claude-opus-5-5");
      expect(report.selectedRoleRefs.builder).toBe("openai-codex/gpt-6-astra");
      expect(report.selectedRoleRefs.auditor).toBe("anthropic/claude-opus-5-5");
      expect(report.selectedRoleRefs.reflector).toBe("openai-codex/gpt-6-astra");
      expect(report.roleReasons.builder.reason).toContain("Published point-score tie");
      expect(report.roleReasons.builder.reason).toContain("deterministic evidence order");
      expect(report.selectedRoleRefs.judge).not.toBe(report.selectedRoleRefs.generator);
    }
  });
});
