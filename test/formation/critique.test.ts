import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { bindingItems, CritiqueRunError, runCritique } from "../../src/formation/critique";
import type { FeaturesFile } from "../../src/formation/features";
import { NoModelError } from "../../src/providers/models";
import type { PhaseDeps } from "../../src/phases/frame";

const verdict = (value: "ok" | "revise" = "ok") => ({
  content: [{ type: "toolCall", name: "critique", arguments: { scopeCreep: [], unverifiable: [], missing: [], verdict: value } }],
});

function setup(model: unknown, patch: Partial<PhaseDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-critic-")); initHome(home);
  const run = createRun(home, "seed"); const record = new RunRecord(run.record);
  const unused = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
  const deps: PhaseDeps = {
    home, run, record, cfg: defaultConfig(), models: () => ({ model: unused as never, ref: "producer/brain" }),
    availableProviders: new Set(["producer", "other"]), modelsOn: () => ({ model: model as never, ref: "other/critic" }),
    apiKeyFor: async () => "key", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(1), ...patch,
  };
  return { deps, record };
}

const options = (onResult: (result: any) => void = () => {}, spentUsd: () => number = () => 0) => ({
  spec: "SPEC-ONLY", features: "FEATURES-ONLY", dossier: "DOSSIER-ONLY", brief: "BRIEF-ONLY",
  brainRef: "producer/brain", formationCeilingUsd: 10, spentUsd, onResult,
});

describe("runCritique", () => {
  test("prefers another provider and exposes only the critique tool and four artifacts", async () => {
    let seen: any; const calls: unknown[] = [];
    const model = createMockModel({ id: "critic", handler: (ctx: unknown) => { seen = ctx; return verdict(); } } as never);
    const s = setup(model, { modelsOn: (role, provider, exclude) => { calls.push({ role, provider, exclude }); return { model: model as never, ref: `${provider}/critic` }; } });
    const result = await runCritique(s.deps, options());
    expect(result).toMatchObject({ verdict: "ok", crossProvider: true });
    expect(calls).toEqual([{ role: "critic", provider: "other", exclude: undefined }]);
    expect((seen.tools ?? []).map((tool: { name: string }) => tool.name)).toEqual(["critique"]);
    const system = (seen.systemPrompt ?? []).join("\n");
    for (const text of ["SPEC-ONLY", "FEATURES-ONLY", "DOSSIER-ONLY", "BRIEF-ONLY"]) expect(system).toContain(text);
    expect(system.toLowerCase()).not.toContain("transcript");
  });

  test("falls back to a distinct admitted same-provider ref and never reuses the producer", async () => {
    const model = createMockModel({ id: "critic", responses: [verdict()] as never }); const calls: string[] = [];
    const s = setup(model, {
      availableProviders: new Set(["producer"]),
      modelsOn: (_role, provider, exclude) => { calls.push(`${provider}:${exclude ?? ""}`); return { model: model as never, ref: "producer/critic" }; },
    });
    expect((await runCritique(s.deps, options())).crossProvider).toBe(false);
    expect(calls).toEqual(["producer:producer/brain"]);
  });

  test("tries only the one otherProvider policy choice before same-provider fallback", async () => {
    const model = createMockModel({ id: "critic", responses: [verdict()] as never }); const calls: string[] = [];
    const s = setup(model, {
      availableProviders: new Set(["producer", "other-one", "other-two"]),
      modelsOn: (_role, provider, exclude) => {
        calls.push(`${provider}:${exclude ?? ""}`);
        if (provider === "other-one") throw new NoModelError("first other unavailable");
        if (provider === "other-two") throw new Error("the second alternative must not be scanned");
        return { model: model as never, ref: "producer/critic" };
      },
    });
    expect((await runCritique(s.deps, options())).crossProvider).toBe(false);
    expect(calls).toEqual(["other-one:", "producer:producer/brain"]);
  });

  test("fails typed when no independent admitted critic exists", async () => {
    const model = createMockModel({ id: "critic", responses: [verdict()] as never });
    const s = setup(model, { availableProviders: new Set(["producer"]), modelsOn: () => { throw new NoModelError("none"); } });
    await expect(runCritique(s.deps, options())).rejects.toBeInstanceOf(NoModelError);
  });

  test("rejects a broken resolver that returns the producer ref despite exclusion", async () => {
    const model = createMockModel({ id: "critic", responses: [verdict()] as never });
    const s = setup(model, { availableProviders: new Set(["producer"]), modelsOn: () => ({ model: model as never, ref: "producer/brain" }) });
    await expect(runCritique(s.deps, options())).rejects.toBeInstanceOf(NoModelError);
    expect(model.calls).toHaveLength(0);
  });

  test("retries a malformed or missing call once and charges every brain.run", async () => {
    const model = createMockModel({ id: "critic", responses: [{ content: ["no call"] }, verdict("revise")] as never });
    const s = setup(model); const observed: string[] = [];
    const result = await runCritique(s.deps, options((value) => observed.push(value.stopped)));
    expect(result.verdict).toBe("revise");
    expect(observed).toEqual(["done", "done"]);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(1);
  });

  test("records a degenerate revise after the one retry while unrelated journal cost never enters its ledger", async () => {
    const model = createMockModel({ id: "critic", responses: [{ content: ["none"] }, { content: ["still none"] }] as never });
    const s = setup(model); let spent = 0;
    const result = await runCritique(s.deps, options((value) => {
      spent += value.costUsd;
      s.record.append({ t: "model.call", role: "judge", provider: "other", model: "unrelated", inputHash: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 999, stopReason: "stop", excerpt: "" });
    }, () => spent));
    expect(result.verdict).toBe("revise");
    expect(result.missing[0]?.text).toContain("degenerate critique");
    expect(model.calls).toHaveLength(2);
  });

  test("records a refusal as a category-named degenerate revise without retrying", async () => {
    const model = createMockModel({ id: "critic-refusal", provider: "other", responses: [{
      stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" },
    }] as never });
    const s = setup(model); const observed: string[] = [];
    const result = await runCritique(s.deps, options((value) => observed.push(value.stopped)));
    expect(result).toMatchObject({ verdict: "revise", missing: [{ text: "degenerate critique: refused:safety" }] });
    expect(observed).toEqual(["refused"]);
    expect(model.calls).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "critique")).toEqual([
      expect.objectContaining({ verdict: "revise", stopped: "refused", missing: [{ text: "degenerate critique: refused:safety" }] }),
    ]);
  });

  test("records exactly one typed critique event with provider, cost and stop evidence before throwing", async () => {
    const model = createMockModel({ id: "critic-error", provider: "other", responses: [{ throw: "policy: critic failed" }] as never });
    const s = setup(model); let thrown: unknown;
    try { await runCritique(s.deps, options()); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(CritiqueRunError);
    const events = s.record.read().filter((event) => event.t === "critique");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: "revise", provider: "other", model: "other/critic", stopped: "error", usdCapHit: false, costUsd: 0 });
  });
});

describe("bindingItems", () => {
  test("binds only named manual or mechanically trivial checks", () => {
    const file: FeaturesFile = { version: 1, init: { needs: [] }, features: [
      { id: "f01", title: "a", description: "a", acceptance: { type: "manual", instructions: "look" } },
      { id: "f02", title: "b", description: "b", acceptance: { type: "shell", command: "echo yes" } },
      { id: "f03", title: "c", description: "c", acceptance: { type: "shell", command: "echo yes", expect: { type: "substring", value: "yes" } } },
    ] };
    expect(bindingItems({ unverifiable: [
      { featureId: "f01", text: "manual" }, { featureId: "f02", text: "trivial" },
      { featureId: "f03", text: "has oracle" }, { text: "unnamed" }, { featureId: "missing", text: "unknown" },
    ] }, file)).toEqual(["manual", "trivial"]);
  });
});
