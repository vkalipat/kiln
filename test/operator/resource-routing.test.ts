import { describe, expect, test } from "bun:test";
import { buildResourceCatalog, chooseResourceRoute, type ResourceModel, type ResourceRouteInput } from "../../src/operator/resource-routing";
import type { JevWorkflowDecision } from "../../src/operator/jev-service";
const benchmark = (score: number) => ({ category: "general_reasoning", metric: "reviewed test", score, higherIsBetter: true, effort: "high", conditions: "test conditions", sourceUrl: "https://example.org/benchmark", observedAt: "2026-09-28" });
const catalog: ResourceModel[] = [
  { modelRef: "openai-codex/large", provider: "openai-codex", contextWindow: 100000, efforts: ["low", "high"], supportsReasoning: true, cost: { input: 4, output: 20 }, benchmarks: [benchmark(90)], evidenceSnapshotId: "reviewed" },
  { modelRef: "anthropic/small", provider: "anthropic", contextWindow: 50000, efforts: ["low", "medium"], supportsReasoning: true, cost: { input: 1, output: 2 }, benchmarks: [benchmark(80)], evidenceSnapshotId: "reviewed" },
];
const input: ResourceRouteInput = { task: "Classify the supplied documents", sessionId: "test", roles: [{ id: "classifier", description: "Classify supplied evidence" }, { id: "researcher", description: "Investigate missing evidence" }], qualityDemand: "simple" };
const accepted = (role = "classifier", route = "model_1"): JevWorkflowDecision => ({ source: "jev", reason: "accepted", requestedModel: "jev-1.13.0", stateHash: "test", dispatched: true, latencyMs: 1,
  answers: { role: { choice: role, accepted: true, confidence: 0.95, probabilities: {} }, model: { choice: route, accepted: true, confidence: 0.95, probabilities: {} }, effort: { choice: "light", accepted: true, confidence: 0.95, probabilities: {} } } });
describe("resource routing", () => {
  test("admits smaller installed models independently of role presets and preserves actual provenance", () => {
    const models = buildResourceCatalog(new Set(["anthropic"]));
    expect(models.length).toBeLessThanOrEqual(32);
    expect(models.some(model => model.modelRef === "anthropic/claude-sonnet-5-5")).toBe(true);
    expect(models.every(model => model.provider === "anthropic")).toBe(true);
    const evidence = models.find(model => model.modelRef === "anthropic/claude-opus-5-5")!.benchmarks[0]!;
    expect(evidence.sourceUrl).toStartWith("https://"); expect(evidence.effort).toBe("xhigh");
  });
  test("one Jev call selects role and cheap low-effort pair", async () => {
    let calls = 0;
    const result = await chooseResourceRoute(input, catalog, { evaluate: async request => {
      calls++; expect(request.operation).toBe("routing"); expect(Object.keys(request.questions)).toEqual(["role", "model", "effort"]);
      expect(request.questions.model!.instructions).toContain("test conditions");
      expect(JSON.stringify(request.state).length).toBeLessThan(16000); return accepted();
    } });
    expect(calls).toBe(1); expect(result.modelRef).toBe("anthropic/small"); expect(result.effort).toBe("low"); expect(result.source).toBe("jev");
  });
  test("preserves model pin while Jev chooses effort and role", async () => {
    const result = await chooseResourceRoute({ ...input, exactModelRef: "openai-codex/large" }, catalog, { evaluate: async request => {
      expect(Object.values(request.questions.model!.criteria).every(value => value.startsWith("openai-codex/large"))).toBe(true);
      return accepted("researcher", "model_0");
    } });
    expect(result.role).toBe("researcher"); expect(result.effort).toBe("low");
  });
  test("full explicit pin bypasses Jev", async () => {
    const result = await chooseResourceRoute({ ...input, exactModelRef: "anthropic/small", exactEffort: "low", exactRole: "classifier" }, catalog, { evaluate: async () => { throw Error("must not dispatch"); } });
    expect(result.source).toBe("explicit"); expect(result.effort).toBe("low");
  });
  test("low confidence falls back to strongest reviewed quality at measured effort", async () => {
    const result = await chooseResourceRoute(input, [...catalog, { ...catalog[1]!, modelRef: "anthropic/unknown", benchmarks: [], cost: { input: 0, output: 0 } }], { evaluate: async () => ({ ...accepted(), source: "fallback", reason: "low_confidence" }) });
    expect(result.modelRef).toBe("openai-codex/large"); expect(result.effort).toBe("high"); expect(result.source).toBe("fallback");
  });
  test("context, explicit effort and reviewer alias exclusion are hard admission constraints", async () => {
    await expect(chooseResourceRoute({ ...input, requiredContextTokens: 60000, producerRef: "openai/large" }, catalog, { evaluate: async () => accepted() })).rejects.toThrow("No compatible");
    await expect(chooseResourceRoute({ ...input, exactModelRef: "anthropic/small", exactEffort: "max" }, catalog, { evaluate: async () => accepted() })).rejects.toThrow("No compatible");
  });
  test("out of enum or partial acceptance cannot invent routes", async () => {
    const result = await chooseResourceRoute(input, catalog, { evaluate: async () => accepted("injected", "model_999") });
    expect(result.source).toBe("fallback"); expect(result.modelRef).toBe("openai-codex/large");
  });
  test("sole role skips a redundant classification head", async () => {
    const result = await chooseResourceRoute({ ...input, roles: [input.roles[0]!] }, catalog, { evaluate: async request => {
      expect(Object.keys(request.questions)).toEqual(["model", "effort"]);
      const decision = accepted(); delete decision.answers!.role; return decision;
    } });
    expect(result.source).toBe("jev"); expect(result.role).toBe("classifier"); expect(result.effort).toBe("low");
  });
  test("uncertain continuing route retains compatible pair and uses the new sole role", async () => {
    const result = await chooseResourceRoute({ ...input, roles: [input.roles[1]!], currentRoute: { modelRef: "anthropic/small", effort: "low", role: "classifier" } }, catalog,
      { evaluate: async request => {
        expect(JSON.stringify(request.state)).toContain("currentRoute");
        expect(request.questions.model!.instructions).toContain("lose prompt cache");
        return { ...accepted(), source: "fallback", reason: "low_confidence" };
      } });
    expect(result.source).toBe("fallback"); expect(result.modelRef).toBe("anthropic/small"); expect(result.effort).toBe("low");
    expect(result.role).toBe("researcher"); expect(result.reason).toContain("Retained compatible current");
  });
  test("explicit effort, context and reviewer constraints override current route retention", async () => {
    const currentRoute = { modelRef: "anthropic/small", effort: "low" as const };
    for (const constraint of [{ exactEffort: "high" as const }, { requiredContextTokens: 60000 }, { producerRef: "anthropic/small" }, { exactModelRef: "openai-codex/large" }]) {
      const result = await chooseResourceRoute({ ...input, currentRoute, ...constraint }, catalog, { evaluate: async () => ({ ...accepted(), source: "fallback", reason: "disabled" }) });
      expect(result.modelRef).toBe("openai-codex/large"); expect(result.reason).not.toContain("Retained");
    }
  });

  test("unspecified category supplies scientific evidence as well as general reasoning", async () => {
    const enriched = [{ ...catalog[0]!, benchmarks: [...catalog[0]!.benchmarks, { ...benchmark(70), category: "scientific_coding", metric: "scientific fixture" }] }, catalog[1]!];
    await chooseResourceRoute(input, enriched, { evaluate: async request => {
      expect(request.questions.model!.instructions).toContain("scientific fixture");
      expect(JSON.stringify(request.state)).toContain("general_reasoning for conservative fallback only");
      return accepted();
    } });
  });

  test("profile selection maps to legal measured effort and keeps exact effort out of classification", async () => {
    const result = await chooseResourceRoute(input, catalog, { evaluate: async request => {
      expect(request.questions.effort!.criteria.deep).toContain("benchmark-recorded");
      const decision = accepted("classifier", "model_0"); decision.answers!.effort!.choice = "deep"; return decision;
    } });
    expect(result.effort).toBe("high"); expect(result.reason).toContain("profile mapped");
    await chooseResourceRoute({ ...input, exactEffort: "low" }, catalog, { evaluate: async request => {
      expect(request.questions.effort).toBeUndefined(); const decision = accepted(); delete decision.answers!.effort; return decision;
    } });
  });
  test("aliases are deduplicated while a current credential route survives", async () => {
    const aliases = [...catalog, { ...catalog[0]!, modelRef: "openai/large", provider: "openai" }];
    await chooseResourceRoute({ ...input, currentRoute: { modelRef: "openai/large", effort: "low" } }, aliases, { evaluate: async request => {
      const refs = Object.values(request.questions.model!.criteria);
      expect(refs).toContain("openai/large"); expect(refs).not.toContain("openai-codex/large");
      return accepted("classifier", "model_0");
    } });
  });

  test("first-party retired revisions and aliases are excluded while current inexpensive models remain", () => {
    const refs = buildResourceCatalog(new Set(["anthropic"])).map(model => model.modelRef);
    for (const id of ["claude-3-haiku-20240307", "claude-3-5-sonnet-20240620", "claude-3-5-sonnet-20241022", "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-1-20250805", "claude-sonnet-4-0", "claude-sonnet-4-20250514"])
      expect(refs).not.toContain(`anthropic/${id}`);
    expect(refs).toContain("anthropic/claude-haiku-4-5");
    expect(refs).toContain("anthropic/claude-haiku-4-5-20251001");
  });

});
