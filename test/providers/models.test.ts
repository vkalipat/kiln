import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog";
import { defaultConfig } from "../../src/core/config";
import type { AuthStore } from "../../src/providers/auth";
import { NoModelError, availableProviders, clampEffort, effortFor, modelFamily, otherProvider, parseModelRef, resolveRole, resolveRoleOn } from "../../src/providers/models";

describe("models", () => {
  test("parseModelRef", () => {
    expect(parseModelRef("anthropic/claude-opus-4-8")).toEqual({ provider: "anthropic", modelId: "claude-opus-4-8" });
    expect(() => parseModelRef("nope")).toThrow();
  });
  test("resolveRole picks the first available provider", () => {
    const cfg = defaultConfig();
    const r = resolveRole("brain", cfg, new Set(["openai-codex"]));
    expect(r.ref).toBe("openai-codex/gpt-5.5");
    expect(r.model.provider).toBe("openai-codex");
  });
  test("resolveRole throws when nothing is available", () => {
    expect(() => resolveRole("brain", defaultConfig(), new Set())).toThrow(/no model available/i);
  });
  test("otherProvider prefers a different one", () => {
    expect(otherProvider("anthropic", new Set(["anthropic", "openai-codex"]))).toBe("openai-codex");
    expect(otherProvider("anthropic", new Set(["anthropic"]))).toBe("anthropic");
    expect(otherProvider("anthropic", new Set())).toBeUndefined();
  });
  test("clampEffort respects the model's supported levels", () => {
    const { model } = resolveRole("brain", defaultConfig(), new Set(["anthropic"]));
    const e = clampEffort(model, "medium");
    expect(e === undefined || ["minimal", "low", "medium", "high", "xhigh", "max"].includes(e)).toBe(true);
  });
  test("clampEffort falls back to the lowest supported level when the request is below every supported level", () => {
    const model = { thinking: { efforts: ["medium", "high"] } } as unknown as Model;
    expect(clampEffort(model, "low")).toBe("medium");
    expect(clampEffort(model, "xhigh")).toBe("high");
  });
  test("clampEffort returns undefined only when the model lists no efforts", () => {
    const model = { thinking: { efforts: [] } } as unknown as Model;
    expect(clampEffort(model, "medium")).toBeUndefined();
    const noThinking = {} as unknown as Model;
    expect(clampEffort(noThinking, "medium")).toBeUndefined();
  });
  test("effortFor applies role defaults, explicit overrides, and model clamping", () => {
    const cfg = defaultConfig();
    const model = { id: "m", thinking: { efforts: ["low", "medium", "high"] } } as unknown as Model;
    const expected = {
      brain: "high", builder: "high", critic: "high",
      generator: "medium", judge: "medium", auditor: "medium", reflector: "medium",
      scout: "low", arbiter: "low", prober: "low",
    } as const;
    for (const [role, effort] of Object.entries(expected)) {
      expect(effortFor(cfg, role as keyof typeof expected, model)).toBe(effort);
    }
    cfg.effortByRole = { brain: "xhigh" };
    expect(effortFor(cfg, "brain", model)).toBe("high");
    expect(effortFor(cfg, "judge", model)).toBe("medium");
    cfg.effortByRole = undefined;
    cfg.effort = "low";
    expect(effortFor(cfg, "brain", model)).toBe("low");
    expect(effortFor(cfg, "brain", {} as Model)).toBeUndefined();
  });
  test("modelFamily recognizes every governed prefix", () => {
    for (const id of ["claude-fable-5", "claude-fable-5-1", "claude-opus-5", "claude-opus-5-1", "claude-mythos-preview"]) {
      expect(modelFamily(id)).toBe("fable");
    }
    expect(modelFamily("gpt-6")).toBe("astra");
    expect(modelFamily("gpt-6-astra")).toBe("astra");
    expect(modelFamily("gpt-5.6")).toBe("other");
    expect(modelFamily({ id: "claude-opus-4-8" } as Model)).toBe("other");
  });
  test("availableProviders treats a throwing apiKeyFor as unavailable, not a crash", async () => {
    const cfg = defaultConfig();
    const fakeAuth = {
      apiKeyFor: async (provider: string) => {
        if (provider === "anthropic") throw new Error("boom");
        return `key-for-${provider}`;
      },
    } as unknown as AuthStore;
    const available = await availableProviders(fakeAuth, cfg);
    expect(available.has("anthropic")).toBe(false);
    expect(available.has("openai-codex")).toBe(true);
    expect(available.has("openai")).toBe(true);
  });
});

describe("resolveRoleOn", () => {
  test("picks the first ref in the role's list on that provider", () => {
    const cfg = defaultConfig();
    const r = resolveRoleOn("brain", "openai", cfg, new Set(["anthropic", "openai", "openai-codex"]));
    expect(r.ref).toBe("openai/gpt-5.5");
    expect(r.model.provider).toBe("openai");
    const codex = resolveRoleOn("brain", "openai-codex", cfg, new Set(["anthropic", "openai", "openai-codex"]));
    expect(codex.ref).toBe("openai-codex/gpt-5.5");
  });
  test("resolves the new ideation roles", () => {
    const cfg = defaultConfig();
    expect(resolveRoleOn("generator", "anthropic", cfg, new Set(["anthropic"])).ref).toBe("anthropic/claude-opus-4-8");
    expect(resolveRoleOn("prober", "anthropic", cfg, new Set(["anthropic"])).ref).toBe("anthropic/claude-haiku-4-5");
    expect(resolveRoleOn("arbiter", "anthropic", cfg, new Set(["anthropic"])).ref).toBe("anthropic/claude-haiku-4-5");
  });
  test("the default judge and generator are different tiers on every single-provider path", () => {
    const cfg = defaultConfig();
    for (const provider of ["anthropic", "openai-codex", "openai"]) {
      const available = new Set([provider]);
      const generator = resolveRoleOn("generator", provider, cfg, available);
      const judge = resolveRoleOn("judge", provider, cfg, available);
      expect(judge.ref).not.toBe(generator.ref);
      expect(judge.model.provider).toBe(generator.model.provider);
    }
  });
  test("throws NoModelError when the provider is not available", () => {
    const cfg = defaultConfig();
    expect(() => resolveRoleOn("brain", "openai", cfg, new Set(["anthropic"]))).toThrow(NoModelError);
    expect(() => resolveRoleOn("brain", "openai", cfg, new Set(["anthropic"]))).toThrow(/openai/);
  });
  test("throws NoModelError when the role's list names no model on that provider", () => {
    const cfg = defaultConfig();
    cfg.roles.judge = ["anthropic/claude-opus-4-8"];
    expect(() => resolveRoleOn("judge", "openai", cfg, new Set(["anthropic", "openai"]))).toThrow(NoModelError);
  });
  test("throws NoModelError when the ref names a model the catalog does not have", () => {
    const cfg = defaultConfig();
    cfg.roles.judge = ["anthropic/not-a-real-model"];
    expect(() => resolveRoleOn("judge", "anthropic", cfg, new Set(["anthropic"]))).toThrow(NoModelError);
  });
  test("resolves a critic on another provider when one is admitted", () => {
    const cfg = defaultConfig();
    const available = new Set(["anthropic", "openai-codex"]);
    const provider = otherProvider("anthropic", available)!;
    const critic = resolveRoleOn("critic", provider, cfg, available);
    expect(critic.model.provider).toBe("openai-codex");
  });
  test("excludes the producer ref and finds an admitted same-provider alternative", () => {
    const cfg = defaultConfig();
    const available = new Set(["anthropic"]);
    const first = resolveRoleOn("critic", "anthropic", cfg, available);
    const alternative = resolveRoleOn("critic", "anthropic", cfg, available, first.ref);
    expect(alternative.ref).not.toBe(first.ref);
    expect(alternative.model.provider).toBe(first.model.provider);
  });
  test("fails typed when exclusion leaves no admitted alternative", () => {
    const cfg = defaultConfig();
    cfg.roles.critic = ["anthropic/claude-opus-4-8"];
    expect(() => resolveRoleOn("critic", "anthropic", cfg, new Set(["anthropic"]), cfg.roles.critic[0])).toThrow(NoModelError);
  });
});
