import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/core/config";
import { sha256Bytes } from "../../src/evals/seeds";
import { prepareStepRouting, resolveStep } from "../../src/operator/routing";

const providers = new Set(["anthropic", "openai-codex"]);

describe("operator step routing", () => {
  test("routes each VCC step from one prepared admitted plan with task-appropriate effort and a stable context record", () => {
    const cfg = defaultConfig();
    const seed = "Develop a VirtualCell Perturb-seq model for single-cell transcriptomics";
    const prepared = prepareStepRouting(cfg, providers, seed, new Date("2026-09-28T12:00:00Z"));
    const research = resolveStep("research", cfg, providers, seed, { prepared });
    const ideate = resolveStep("ideate", cfg, providers, seed, { prepared });
    const implement = resolveStep("implement", cfg, providers, seed, { prepared });
    const synthesize = resolveStep("synthesize", cfg, providers, seed, { prepared });
    const review = resolveStep("review", cfg, providers, seed, {
      prepared, currentStep: "implement", producerRef: implement.modelRef,
    });
    expect(research).toMatchObject({ role: "scout", effort: "low" });
    expect(ideate).toMatchObject({ role: "generator", modelRef: "openai-codex/gpt-6-astra", effort: "medium" });
    expect(implement).toMatchObject({ role: "builder", modelRef: "openai-codex/gpt-6-astra", effort: "high" });
    expect(synthesize).toMatchObject({ role: "brain", modelRef: "openai-codex/gpt-6-astra", effort: "high" });
    expect(review.role).toBe("auditor");
    expect(review.modelRef).not.toBe(implement.modelRef);
    expect(review.reason).toContain("not proof of task correctness");
    expect(review.contextEntry.status).toBe("unaltered_report");
    expect(review.contextEntry.sourceHash).toBe(sha256Bytes(review.contextEntry.text));
    expect(resolveStep("ideate", cfg, providers, seed, { prepared }).contextEntry).toEqual(ideate.contextEntry);
    expect(resolveStep("synthesize", cfg, providers, seed, { prepared, producerRef: synthesize.modelRef }).modelRef).toBe(synthesize.modelRef);
  });

  test("review routing excludes the actual producer inside an explicit admitted model pool", () => {
    const cfg = defaultConfig();
    const seed = "Find a business idea";
    const prepared = prepareStepRouting(cfg, providers, seed, new Date("2026-09-28T12:00:00Z"));
    const producer = resolveStep("ideate", cfg, providers, seed, { prepared });
    const ordinary = resolveStep("review", cfg, providers, seed, {
      prepared, currentStep: "ideate", producerRef: producer.modelRef,
    });
    expect(ordinary.role).toBe("judge");
    expect(ordinary.modelRef).not.toBe(producer.modelRef);
    const pooled = resolveStep("review", cfg, providers, seed, {
      prepared, currentStep: "ideate", producerRef: producer.modelRef,
      modelPool: [producer.modelRef, ordinary.modelRef],
    });
    expect(pooled.modelRef).toBe(ordinary.modelRef);
    expect(() => resolveStep("review", cfg, providers, seed, {
      prepared, currentStep: "ideate", producerRef: producer.modelRef,
      modelPool: [producer.modelRef],
    })).toThrow("distinct from");
  });

  test("rejects unsupported pools and stale or tampered prepared routing instead of inventing a fallback", () => {
    const cfg = defaultConfig();
    const seed = "Implement a parser";
    const prepared = prepareStepRouting(cfg, providers, seed, new Date("2026-09-28T12:00:00Z"));
    expect(() => resolveStep("implement", cfg, providers, seed, {
      prepared, modelPool: ["anthropic/not-a-real-model"],
    })).toThrow("unsupported");
    expect(() => resolveStep("implement", cfg, providers, seed + " changed", { prepared })).toThrow("does not match");
    const tampered = structuredClone(prepared);
    tampered.admittedRoleRefs.builder[0]!.ref = "anthropic/claude-haiku-4-5";
    expect(() => resolveStep("implement", cfg, providers, seed, { prepared: tampered })).toThrow("fingerprint mismatch");
  });
});
