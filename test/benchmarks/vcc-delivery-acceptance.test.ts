import { describe, expect, test } from "bun:test";
import { planWorkflow, compileWorkflow } from "../../src/workflow/plan";
import { mentionsController, nativeDeliveryComplete, oraclePass, vccOracles, vccWireReservation, VCC_LIMITS, VCC_SEED } from "../../scripts/benchmarks/vcc-delivery-acceptance";

describe("VCC native delivery qualification protocol", () => {
  test("native completion requires successful final status and every required phase", () => {
    const status = { state: "done", outcome: { kind: "success" } };
    const phases = ["frame", "form", "build", "reflect"].map(phase => ({ phase, outcome: "ok" }));
    expect(nativeDeliveryComplete(status, phases)).toBe(true);
    expect(nativeDeliveryComplete({ state: "blocked", outcome: { kind: "success" } }, phases)).toBe(false);
    expect(nativeDeliveryComplete({ state: "done", outcome: { kind: "honest_exit" } }, phases)).toBe(false);
    expect(nativeDeliveryComplete(status, phases.filter(x => x.phase !== "build"))).toBe(false);
    expect(nativeDeliveryComplete(status, [...phases, { phase: "build", outcome: "failed" }])).toBe(false);
  });
  test("supplied local utility routes directly through native delivery and reflection", () => {
    const plan = planWorkflow(VCC_SEED, { adaptive: true });
    expect(plan.strategy).toEqual({ mode: "direct", research: "none" });
    const execution = compileWorkflow(plan, { through: "reflect", autonomous: true });
    expect(execution.phases).toContain("form"); expect(execution.phases).toContain("build"); expect(execution.phases).toContain("reflect");
    expect(execution.phases).not.toContain("ideate"); expect(execution.phases).not.toContain("discover");
    expect(VCC_SEED).toContain("not official .vcc packaging");
  });
  test("external table covers public contract edges and remains stable", () => {
    const rows = vccOracles();
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map(x => x.id)).size).toBe(rows.length);
    expect(rows).toEqual(vccOracles());
    for (const id of ["boolean", "fractional", "negative", "length", "duplicate-gene", "empty-gene", "unknown-target", "missing-target", "non-targeting", "total", "nonfinite-NaN", "nonfinite-Infinity", "nonfinite--Infinity"]) {
      expect(rows.some(x => x.id === id)).toBe(true);
    }
  });
  test("valid summary requires exact output; rejection requires no stdout and genuine process exit", () => {
    const good = vccOracles()[0]!, bad = vccOracles().find(x => x.id === "negative")!;
    expect(oraclePass(good, 0, '{"cells":2,"genes":2,"targets":2}\n')).toBe(true);
    expect(oraclePass(good, 0, '{"cells":2,"genes":2,"targets":2,"ok":true}')).toBe(false);
    expect(oraclePass(good, 0, '{"cells":1,"genes":2,"targets":2}')).toBe(false);
    expect(oraclePass(bad, 1, "")).toBe(true); expect(oraclePass(bad, 200, "")).toBe(true);
    expect(oraclePass(bad, 1, "partial")).toBe(false); expect(oraclePass(bad, 0, "")).toBe(false);
    expect(oraclePass(bad, 137, "", "SIGKILL")).toBe(false); expect(oraclePass(bad, null, "")).toBe(false);
  });
  test("controller guard covers literal native args and Code Mode cells without claiming encoded-path isolation", () => {
    const path = "/private/tmp/vcc-controller-123";
    expect(mentionsController({ path: `${path}/oracles.json` }, path)).toBe(true);
    expect(mentionsController({ code: 'await tools.read({path:"../vcc-controller-123/oracles.json"})' }, path)).toBe(true);
    expect(mentionsController({ path: "validate_counts.py" }, path)).toBe(false);
  });
  test("Codex reserves catalog maximum; Anthropic enforces output cap; shared prior retained", () => {
    const cost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 };
    const codex = vccWireReservation("openai-codex", "gpt-6-astra", 128000, cost, '{"model":"gpt-6-astra"}', 16384);
    expect(codex.reservedOutputTokens).toBe(128000); expect(codex.enforcedOutputTokens).toBeNull(); expect(codex.reserveUsd).toBeGreaterThan(6.4);
    expect(vccWireReservation("anthropic", "reviewer", 128000, cost, '{"model":"reviewer","max_tokens":32768}', 32768).enforcedOutputTokens).toBe(32768);
    expect(() => vccWireReservation("anthropic", "reviewer", 128000, cost, '{"model":"reviewer","max_tokens":2048}', 32768)).toThrow();
    expect(() => vccWireReservation("openai", "other", 128000, cost, '{"model":"other"}', 16384)).toThrow();
    expect(VCC_LIMITS.totalExposureUsd - VCC_LIMITS.priorCanaryUsd).toBeCloseTo(24.9802);
    expect(VCC_LIMITS.maxRequests).toBe(40); expect(VCC_LIMITS.wallMs).toBe(1500000);
  });
});
