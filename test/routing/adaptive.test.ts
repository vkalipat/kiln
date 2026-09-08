import { describe, expect, test } from "bun:test";
import { defaultConfig, ROLES } from "../../src/core/config";
import { resolveRoleOn, otherProvider } from "../../src/providers/models";
import { DEFAULT_EVIDENCE_SNAPSHOT, planAdaptiveRouting, validateEvidenceSnapshot } from "../../src/routing/adaptive";

const now = new Date("2026-09-08T12:00:00Z");
const providers = new Set(["anthropic", "openai-codex"]);
const snapshot = () => structuredClone(DEFAULT_EVIDENCE_SNAPSHOT) as any;

describe("adaptive routing planner", () => {
  test("selects category leaders, independent review, and a feasible whole-round plan without mutation", () => {
    const cfg = defaultConfig(); const before = JSON.stringify(cfg);
    const { config, report } = planAdaptiveRouting(cfg, providers, "Find a business idea", now);
    expect(report.domain).toBe("business");
    expect(config.roles.generator[0]).toBe("anthropic/claude-fable-5-1");
    expect(config.roles.builder[0]).toBe("openai-codex/gpt-6-astra");
    expect(config.roles.judge[0]).toBe("openai-codex/gpt-6-astra");
    expect(report.budget.affordableRounds).toBe(1);
    expect(report.budget.projectedRoundUsd).toBeLessThanOrEqual(report.budget.ideateUsd);
    expect(Object.values(config.budgets.share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(config.budgets.usd).toBe(cfg.budgets.usd); expect(config.budgets.wallSeconds).toBe(cfg.budgets.wallSeconds);
    expect(config.build).toEqual(cfg.build); expect(config.budgets.turns).toEqual(cfg.budgets.turns);
    expect(JSON.stringify(cfg)).toBe(before);
    for (const role of ROLES) expect(config.seating.default[role]).toEqual(config.roles[role]);
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
      { modelRef: "openai-codex/gpt-6-astra", score: 2000 },
      { modelRef: "anthropic/claude-fable-5-1", score: 1600 },
    ];
    const business = planAdaptiveRouting(defaultConfig(), providers, "A startup business idea", now, evidence);
    const science = planAdaptiveRouting(defaultConfig(), providers, "A scientific research idea", now, evidence);
    expect(business.config.roles.generator[0]).toContain("gpt-6-astra");
    expect(science.config.roles.generator[0]).toContain("claude-fable-5-1");
    expect(business.config.roles.generator[0]).not.toBe(business.config.roles.judge[0]);
  });

  test("unavailable future model entries are skipped without fabricating catalog support", () => {
    const evidence = snapshot();
    evidence.rankings.find((r: any) => r.category === "business").entries.unshift({ modelRef: "anthropic/not-a-real-model", score: 9999 });
    expect(planAdaptiveRouting(defaultConfig(), providers, "A business", now, evidence).config.roles.generator[0]).toBe("anthropic/claude-fable-5-1");
  });

  test("fails before execution when budget or provider constraints cannot be met", () => {
    const cfg = defaultConfig(); cfg.budgets.usd = 0.01;
    expect(() => planAdaptiveRouting(cfg, providers, "idea", now)).toThrow("one ideation round");
    expect(() => planAdaptiveRouting(defaultConfig(), new Set(), "idea", now)).toThrow("no supported available model");
    cfg.budgets.usd = 5;
    expect(() => planAdaptiveRouting(cfg, new Set(["openai"]), "general idea", now)).toThrow("configured minimum");
  });
});

describe("benchmark evidence validation", () => {
  test("accepts reviewed source-linked evidence", () => {
    expect(validateEvidenceSnapshot(snapshot(), now).rankings).toHaveLength(6);
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
