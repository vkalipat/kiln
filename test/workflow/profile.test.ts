import { expect, test } from "bun:test";
import { defaultConfig } from "../../src/core/config";
import { planWorkflow } from "../../src/workflow/plan";
import { schedulePairs } from "../../src/ideation/pairing";
import { adaptivePortfolioCandidates, applyWorkflowProfile } from "../../src/workflow/profile";

test("research workflows get usable upstream allocation while protecting downstream work", () => {
  const cfg = defaultConfig(); const before = JSON.stringify(cfg);
  for (const seed of ["Find a business idea", "Evaluate a repair shop scheduling concept"]) {
    const adjusted = applyWorkflowProfile(cfg, planWorkflow(seed));
    expect(adjusted.budgets.share.discover).toBe(0.15);
    expect(adjusted.budgets.share.ideate).toBe(0.40);
    expect(Object.values(adjusted.budgets.share).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(adjusted.budgets.usd).toBe(cfg.budgets.usd);
    expect(adjusted.budgets.wallSeconds).toBe(cfg.budgets.wallSeconds);
  }
  expect(JSON.stringify(cfg)).toBe(before);
});

test("historical strategies and direct task allocations remain unchanged", () => {
  const cfg = defaultConfig();
  expect(applyWorkflowProfile(cfg, planWorkflow("Find an idea", { adaptive: false }))).toBe(cfg);
  const direct = applyWorkflowProfile(cfg, planWorkflow("Build a JSON formatter CLI"));
  expect(direct.budgets.share.discover).toBe(0);
  expect(direct.budgets.share.form).toBe(0.2);
  expect(direct.budgets.share.build).toBe(0.7);
  expect(direct.build.minFeatures).toBe(1);
  expect(direct.build.maxFeatures).toBe(cfg.build.maxFeatures);
});

test("adaptive portfolio alternatives reduce breadth while preserving comparison coverage", () => {
  const cfg = applyWorkflowProfile(defaultConfig(), planWorkflow("Find a business idea"));
  const choices = adaptivePortfolioCandidates(cfg);
  expect(choices[0]?.candidates).toBe(30);
  const eight = choices.find((choice) => choice.candidates === 8 && choice.config.ideation.islands === 2);
  expect(eight).toBeDefined();
  expect(eight?.config.ideation).toMatchObject({ ideasPerBatch: 2, entrantsCap: 8, pairCap: 12, minComparisons: 3 });
  const ids = Array.from({ length: eight!.entrants }, (_, index) => `i${index}`);
  const pairs = schedulePairs({ entrants: ids, pairCap: eight!.pairs, minComparisons: cfg.ideation.minComparisons });
  const counts = Object.fromEntries(ids.map((id) => [id, pairs.filter(([a, b]) => a === id || b === id).length]));
  expect(pairs).toHaveLength(12);
  expect(Object.values(counts).every((count) => count >= cfg.ideation.minComparisons)).toBe(true);
  expect(eight?.config.ideation.checkpointMin).toBeLessThanOrEqual(eight!.entrants);
  expect(cfg.ideation.ideasPerBatch).toBe(5);
});
