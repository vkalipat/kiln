import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCommand } from "../../src/cli/commands/project";
import { defaultConfig, loadConfig, saveConfig, type KilnConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { createRun, writeStatus, type RunPaths } from "../../src/core/run";
import type { FeaturesFile } from "../../src/formation/features";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { projectPaths } from "../../src/formation/paths";
import { freezeRouting } from "../../src/workflow/routing";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const FEATURES: FeaturesFile = {
  version: 1,
  init: { needs: [] },
  features: [{ id: "f01", title: "One", description: "deliver one", acceptance: { type: "file", path: "one.txt" } }],
};

function output() {
  const out: string[] = []; const err: string[] = [];
  return { out, err, io: { write: (text: string) => out.push(text), error: (text: string) => err.push(text) } };
}

function setup(phase: "form" | "build") {
  const home = mkdtempSync(join(tmpdir(), "kiln-adaptive-reentry-")); homes.push(home); initHome(home);
  const run = createRun(home, "Find a business idea", { id: `${phase}-run`, routingRequired: true });
  const project = projectPaths(run.project); mkdirSync(project.dir); mkdirSync(project.repo);
  writeFileSync(project.spec, "# Spec\n");
  writeFileSync(run.features, `${JSON.stringify(FEATURES, null, 2)}\n`);
  writeFileSync(run.acceptanceLock, `${JSON.stringify(writeAcceptanceLock(FEATURES, "spec-hash"))}\n`);
  writeStatus(run, { phase, state: "running", projectDir: project.dir, chosenIdeaId: "idea-a" });

  const frozen = defaultConfig();
  frozen.routing = { mode: "adaptive" };
  frozen.roles.brain = ["anthropic/claude-fable-5-1"];
  frozen.roles.builder = ["openai-codex/gpt-5.5"];
  frozen.roles.reflector = ["openai-codex/gpt-5.5"];
  frozen.effort = "high";
  frozen.effortByRole = { ...frozen.effortByRole, brain: "xhigh", builder: "high", reflector: "xhigh" };
  frozen.budgets.share.ideate = 0.5;
  frozen.budgets.share.build = 0.395;
  frozen.ideation.rounds = 2;
  frozen.provider.strictDecisionTools = true;
  freezeRouting(run, frozen, { category: "business" });

  const live = loadConfig(home);
  for (const role of Object.keys(live.roles) as Role[]) live.roles[role] = ["anthropic/claude-haiku-4-5"];
  live.routing = { mode: "manual" };
  live.effort = "low";
  live.effortByRole = Object.fromEntries((Object.keys(live.roles) as Role[]).map((role) => [role, "low"]));
  live.budgets.usd = 40;
  live.ideation.rounds = 1;
  live.provider.strictDecisionTools = false;
  saveConfig(home, live);
  return { home, run, frozen };
}

function expectFrozen(actual: KilnConfig, frozen: KilnConfig): void {
  expect(actual.routing?.mode).toBe("adaptive");
  expect(actual.roles).toEqual(frozen.roles);
  expect(actual.effort).toBe(frozen.effort);
  expect(actual.effortByRole).toEqual(frozen.effortByRole);
  expect(actual.budgets.share).toEqual(frozen.budgets.share);
  expect(actual.budgets.usd).toBe(40);
  expect(actual.budgets.phaseBudgetUsd("ideate")).toBe(20);
  expect(actual.ideation.rounds).toBe(2);
  expect(actual.provider.strictDecisionTools).toBe(true);
}

describe("adaptive routing project re-entry", () => {
  test("project form reapplies frozen routing and effort after live config drift", async () => {
    const { home, run, frozen } = setup("form");
    const captured = output(); let providerCalls = 0; let phaseCalls = 0;
    const code = await projectCommand(["form", run.id], { home, json: true }, captured.io, {
      apiKeyFor: async () => "offline-key",
      streamFn: (async () => { providerCalls += 1; throw new Error("provider request was not expected"); }) as never,
      runForm: async (deps) => {
        phaseCalls += 1;
        expectFrozen(deps.cfg, frozen);
        expect(deps.models("brain").ref).toBe("anthropic/claude-fable-5-1");
        writeStatus(deps.run, { phase: "build", state: "running" });
        return { outcome: "ok" };
      },
    });
    expect(code).toBe(0);
    expect(phaseCalls).toBe(1);
    expect(providerCalls).toBe(0);
    expect(captured.err).toEqual([]);
  });

  test("project build and reflection share the frozen plan after live config drift", async () => {
    const { home, run, frozen } = setup("build");
    const captured = output(); let providerCalls = 0; const phases: string[] = [];
    const code = await projectCommand(["build", run.id], { home, yes: true, json: true }, captured.io, {
      apiKeyFor: async () => "offline-key",
      streamFn: (async () => { providerCalls += 1; throw new Error("provider request was not expected"); }) as never,
      runBuild: async (deps) => {
        phases.push("build");
        expectFrozen(deps.cfg, frozen);
        expect(deps.models("builder").ref).toBe("openai-codex/gpt-5.5");
        writeStatus(deps.run, { phase: "reflect", state: "running" });
        return { outcome: "ok" };
      },
      runReflect: async (deps) => {
        phases.push("reflect");
        expectFrozen(deps.cfg, frozen);
        expect(deps.models("reflector").ref).toBe("openai-codex/gpt-5.5");
        writeStatus(deps.run, { state: "done", outcome: { kind: "success" } });
        return { outcome: "ok" };
      },
    });
    expect(code).toBe(0);
    expect(phases).toEqual(["build", "reflect"]);
    expect(providerCalls).toBe(0);
    expect(captured.err).toEqual([]);
  });
});
