import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { initHome } from "../../src/core/home";
import { loadConfig } from "../../src/core/config";
import { runtimeFor, stageHome } from "../../src/evolution/stage";

describe("staged eval homes", () => {
  test("copies only effective config, prompts, playbook and an empty runs tree", async () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    writeFileSync(join(real, "auth.json"), "{}");
    const staged = stageHome(real, "eval-1", "candidate", {
      prompts: { builder: "candidate builder" },
      seating: {
        roles: { brain: ["anthropic/claude-opus-4-8"] }, caps: { maxFeatures: 4 },
        runBudgetUsd: 9, runWallSeconds: 600,
      },
    });
    expect(readFileSync(join(staged.home, "playbook", "playbook.md"), "utf8")).toBe(readFileSync(join(real, "playbook", "playbook.md"), "utf8"));
    expect(readFileSync(join(staged.home, "prompts", "builder.md"), "utf8")).toBe("candidate builder");
    expect(readFileSync(join(staged.home, "prompts", "kernel.md"), "utf8")).toBe(readFileSync(join(real, "prompts", "kernel.md"), "utf8"));
    expect(existsSync(join(staged.home, "auth.json"))).toBe(false);
    expect(existsSync(join(staged.home, "evals"))).toBe(false);
    expect(existsSync(join(staged.home, "evolution"))).toBe(false);
    const config = loadConfig(staged.home);
    const original = loadConfig(real);
    expect(config.roles.brain).toEqual(["anthropic/claude-opus-4-8"]);
    expect(config.build.maxFeatures).toBe(4);
    expect(config.evals).toMatchObject({ runBudgetUsd: 9, runWallSeconds: 600 });
    expect(config.budgets.usd).toBe(original.budgets.usd);
    expect(config.budgets.wallSeconds).toBe(original.budgets.wallSeconds);
    expect(config.budgets.share).toEqual(original.budgets.share);
    expect(config.budgets.turns).toEqual(original.budgets.turns);
    expect(readdirSync(join(staged.home, "runs"))).toEqual([]);

    const model = createMockModel({ id: "claude-opus-4-8", provider: "anthropic" });
    const runtime = await runtimeFor(real, staged, { models: { brain: model as never }, apiKeyFor: async () => "fixture" });
    expect(runtime.auth.path).toBe(join(real, "auth.json"));
    expect(runtime.models("brain").ref).toBe("anthropic/claude-opus-4-8");

    const expected = loadConfig(staged.home).roles.brain[0]!;
    staged.config.roles.brain = ["missing/not-the-durable-seat"];
    const durable = await runtimeFor(real, staged, { apiKeyFor: async () => "fixture" });
    expect(durable.models("brain").ref).toBe(expected);
  });

  test("refuses unsafe identifiers and unexpected pre-existing state", () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    expect(() => stageHome(real, "../escape", "a")).toThrow(/safe path segment/);
    const dirty = join(real, "evolution", "work", "eval-1", "a");
    mkdirSync(dirty, { recursive: true }); writeFileSync(join(dirty, "foreign"), "x");
    expect(() => stageHome(real, "eval-1", "a")).toThrow(/unexpected entries/);
  });

  test("champion and candidate homes differ only in the requested playbook delta", () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    const playbook = readFileSync(join(real, "playbook", "playbook.md"), "utf8");
    const champion = stageHome(real, "eval-diff", "champion", { playbook });
    const candidate = stageHome(real, "eval-diff", "candidate", { playbook: playbook.replace("Invert a shared assumption", "Challenge a shared assumption") });
    expect(readFileSync(join(champion.home, "config.json"), "utf8")).toBe(readFileSync(join(candidate.home, "config.json"), "utf8"));
    for (const name of ["kernel", "brain", "scout", "judge", "generator", "prober", "arbiter", "critic", "builder", "auditor", "reflector"]) {
      expect(readFileSync(join(champion.home, "prompts", `${name}.md`), "utf8")).toBe(readFileSync(join(candidate.home, "prompts", `${name}.md`), "utf8"));
    }
    expect(readFileSync(join(champion.home, "playbook", "playbook.md"), "utf8")).not.toBe(readFileSync(join(candidate.home, "playbook", "playbook.md"), "utf8"));
  });

  test("prompt candidate homes differ only in the requested prompt", () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    const champion = stageHome(real, "prompt-diff", "champion");
    const candidate = stageHome(real, "prompt-diff", "candidate", {
      playbook: readFileSync(join(real, "playbook", "playbook.md"), "utf8"), prompts: { builder: "candidate builder\n" },
    });
    expect(readFileSync(join(champion.home, "config.json"), "utf8")).toBe(readFileSync(join(candidate.home, "config.json"), "utf8"));
    expect(readFileSync(join(champion.home, "playbook", "playbook.md"), "utf8")).toBe(readFileSync(join(candidate.home, "playbook", "playbook.md"), "utf8"));
    for (const name of ["kernel", "brain", "scout", "judge", "generator", "prober", "arbiter", "critic", "auditor", "reflector"]) {
      expect(readFileSync(join(champion.home, "prompts", `${name}.md`), "utf8")).toBe(readFileSync(join(candidate.home, "prompts", `${name}.md`), "utf8"));
    }
    expect(readFileSync(join(champion.home, "prompts", "builder.md"), "utf8")).not.toBe(readFileSync(join(candidate.home, "prompts", "builder.md"), "utf8"));
  });

  test("refuses staged directory and ancestor symlinks without changing their targets", () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    const builder = join(real, "prompts", "builder.md"); const before = readFileSync(builder, "utf8");
    const promptArm = join(real, "evolution", "work", "links", "prompt-arm"); mkdirSync(promptArm, { recursive: true });
    symlinkSync(join(real, "prompts"), join(promptArm, "prompts"), "dir");
    expect(() => stageHome(real, "links", "prompt-arm", { prompts: { builder: "must not land" } })).toThrow(/real directory/);
    expect(readFileSync(builder, "utf8")).toBe(before);

    const runsArm = join(real, "evolution", "work", "links", "runs-arm"); mkdirSync(runsArm, { recursive: true });
    symlinkSync(join(real, "runs"), join(runsArm, "runs"), "dir");
    expect(() => stageHome(real, "links", "runs-arm")).toThrow(/real directory/);

    const external = mkdtempSync(join(tmpdir(), "kiln-stage-external-"));
    symlinkSync(external, join(real, "evolution", "work", "escaped"), "dir");
    expect(() => stageHome(real, "escaped", "arm")).toThrow(/real directory/);
    expect(existsSync(join(external, "arm"))).toBe(false);
  });

  test("restages identical frozen inputs but refuses drift while runs exist", () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    const playbook = "## build\n- B1 [helpful:0 harmful:0] First.\n";
    const options = { playbook, seating: { runBudgetUsd: 9, runWallSeconds: 600 } };
    const staged = stageHome(real, "resume", "candidate", options);
    const held = join(staged.home, "runs", "held"); mkdirSync(held); writeFileSync(join(held, "state"), "evidence");
    expect(stageHome(real, "resume", "candidate", options).home).toBe(staged.home);
    expect(readFileSync(join(held, "state"), "utf8")).toBe("evidence");
    expect(() => stageHome(real, "resume", "candidate", { ...options, playbook: playbook.replace("First", "Second") })).toThrow(/playbook\/playbook\.md/);
    expect(() => stageHome(real, "resume", "candidate", { ...options, seating: { ...options.seating, runBudgetUsd: 10 } })).toThrow(/config\.json/);
    expect(readFileSync(join(staged.home, "playbook", "playbook.md"), "utf8")).toBe(playbook);
    expect(readFileSync(join(held, "state"), "utf8")).toBe("evidence");
  });

  test("allows only one candidate input mutation", () => {
    const real = mkdtempSync(join(tmpdir(), "kiln-stage-")); initHome(real);
    expect(() => stageHome(real, "combined", "arm", { playbook: "changed", prompts: { builder: "changed" } })).toThrow(/one playbook or one prompt/);
    expect(() => stageHome(real, "multiple", "arm", { prompts: { builder: "one", auditor: "two" } })).toThrow(/one playbook or one prompt/);
  });
});
