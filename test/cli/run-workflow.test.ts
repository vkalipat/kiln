import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { main } from "../../src/cli/main";
import { writeStatus } from "../../src/core/run";
import type { WorkflowPlan } from "../../src/workflow/plan";
import { initHome } from "../../src/core/home";
import { parseBrief } from "../../src/phases/frame";
import { validateBrief } from "../../src/phases/contracts";

test("new adaptive direct tasks use a deterministic frame without embedding or changing the original request", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-direct-frame-"));
  initHome(home, { plugAndPlay: true });
  const seed = "Build a dependency-free JSON formatter CLI.\n\n## User heading\n\n```text\nkeep this fence exact\n```\n\nNo external research.\n";
  const output: string[] = [];
  const model = createMockModel({ id: "brain", responses: [{ content: ["provider must not frame"] }] as never });
  let formed = 0;
  const code = await main(["run", "new", seed, "--home", home, "--through", "form", "--json"], { write: (text) => output.push(text) }, {
    adaptiveWorkflow: true,
    models: { brain: model as never },
    apiKeyFor: async (provider) => provider === "anthropic" ? "key" : undefined,
    runFrame: async () => { throw new Error("direct deterministic frame called the model phase"); },
    runForm: async (deps) => {
      formed += 1;
      expect(validateBrief(parseBrief(readFileSync(deps.run.brief, "utf8")))).toEqual([]);
      expect(readFileSync(deps.run.seed, "utf8")).toBe(seed);
      expect(readFileSync(deps.run.brief, "utf8")).not.toContain("## User heading");
      writeStatus(deps.run, { phase: "build", state: "running" });
      return { outcome: "ok" };
    },
  });
  expect(code).toBe(0);
  expect(formed).toBe(1);
  const summary = JSON.parse(output.join(""));
  expect(summary.workflow.directFrame).toBe("deterministic-v1");
  expect(summary.status.shape).toBe("product");
  expect(summary.lastEvents).toBeUndefined();
  expect(model.calls).toHaveLength(0);
});

test("manual direct requests retain model framing and do not gain the adaptive marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-manual-frame-"));
  initHome(home);
  const output: string[] = []; let framed = 0;
  const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never });
  const code = await main(["run", "new", "Build a dependency-free JSON formatter CLI", "--home", home, "--through", "frame", "--json"], { write: (text) => output.push(text) }, {
    models: { brain: model as never }, apiKeyFor: async () => "key",
    runFrame: async (deps) => { framed += 1; writeStatus(deps.run, { phase: "discover" }); return { outcome: "ok" }; },
  });
  expect(code).toBe(0);
  expect(framed).toBe(1);
  expect(JSON.parse(output.join("")).workflow.directFrame).toBeUndefined();
});

test("run new freezes and delivers the adaptive plan to the frame phase", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-cli-"));
  const output: string[] = [];
  let observed: WorkflowPlan | undefined;
  const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never });

  const code = await main([
    "run", "new", "Find an idea that will make me a billionaire and ship it.",
    "--home", home, "--through", "frame", "--json",
  ], { write: (text) => output.push(text) }, {
    models: { brain: model as never },
    apiKeyFor: async () => "key",
    runFrame: async (deps) => {
      observed = deps.workflow;
      writeStatus(deps.run, { phase: "discover" });
      return { outcome: "ok" };
    },
  });

  expect(code).toBe(0);
  expect(observed).toMatchObject({
    intent: "open_ended_ideation",
    defaultThrough: "reflect",
    assumptionPolicy: "bounded",
  });
  const summary = JSON.parse(output.join(""));
  expect(summary.workflow).toEqual(observed);
  expect(summary.workflowExecution).toMatchObject({ through: "frame", throughSource: "explicit" });
  expect(summary.files).toBeUndefined();
  expect(existsSync(join(summary.dir, "workflow.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(summary.dir, "workflow.json"), "utf8"))).toEqual(observed);
});

test("a delivery seed runs the complete autonomous route without routine confirmation prompts", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-deliver-"));
  const output: string[] = [];
  const calls: string[] = [];
  const model = createMockModel({ id: "seat", responses: [{ content: ["unused"] }] as never });
  const roles = ["brain", "scout", "judge", "builder", "auditor", "critic", "reflector", "generator", "prober", "arbiter"] as const;

  const code = await main(["run", "new", "Find a defensible business idea and ship it", "--home", home], {
    write: (text) => output.push(text),
    ask: async () => { throw new Error("routine confirmation should not be requested"); },
  }, {
    models: Object.fromEntries(roles.map((role) => [role, model])) as never,
    apiKeyFor: async () => "key",
    runFrame: async (d) => { calls.push("frame"); writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
    runDiscover: async (d) => { calls.push("discover"); writeStatus(d.run, { phase: "ideate" }); return { outcome: "ok" }; },
    runIdeate: async (d) => {
      calls.push("ideate");
      writeStatus(d.run, { state: "stopped", outcome: { kind: "stopped", stopKind: "rounds" }, cursor: { step: "checkpoint" } });
      return { outcome: "stopped", stopKind: "rounds" };
    },
    runCheckpoint: async (d, _io, options) => {
      calls.push(`checkpoint:${String(options?.autonomous)}`);
      writeStatus(d.run, { phase: "form", state: "running", outcome: undefined, chosenIdeaId: "idea-a" });
      return { outcome: "ok" };
    },
    runForm: async (d) => { calls.push("form"); writeStatus(d.run, { phase: "build" }); return { outcome: "ok" }; },
    runBuild: async (d) => { calls.push(`build:${String(d.cfg.autonomous)}`); writeStatus(d.run, { phase: "reflect" }); return { outcome: "ok" }; },
    runReflect: async (d) => { calls.push("reflect"); writeStatus(d.run, { state: "done", outcome: { kind: "success" } }); return { outcome: "ok" }; },
  });

  expect(code).toBe(0);
  expect(calls).toEqual(["frame", "discover", "ideate", "checkpoint:true", "form", "build:true", "reflect"]);
  expect(output.join("")).toContain("done");
  expect(output[0]).toBe("I understand this as finding a promising idea and carrying it through implementation and verification.\n");
});

test("conflicting autonomy controls fail before a run is created", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-controls-"));
  const errors: string[] = [];
  expect(await main([
    "run", "new", "Build a local tool", "--home", home, "--autonomous", "--interactive",
  ], { write: () => {}, error: (text) => errors.push(text) })).toBe(2);
  expect(errors.join("")).toContain("cannot be used together");
  expect(readdirSync(join(home, "runs"))).toEqual([]);
});

test("interactive JSON is rejected instead of opening an invisible prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-json-controls-"));
  const errors: string[] = [];
  expect(await main([
    "run", "new", "Explore local business ideas", "--home", home, "--interactive", "--json",
  ], { write: () => {}, error: (text) => errors.push(text) })).toBe(2);
  expect(errors.join("")).toContain("cannot be used together");
  expect(readdirSync(join(home, "runs"))).toEqual([]);
});

test("JSON exploration with a configured human checkpoint does not open stdin", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-json-checkpoint-"));
  initHome(home); // Existing manual/human preference must survive plug-and-play initialization.
  const output: string[] = [];
  let checkpointCalls = 0;
  const model = createMockModel({ id: "seat", responses: [{ content: ["unused"] }] as never });
  const roles = ["brain", "scout", "judge", "generator", "prober", "arbiter"] as const;
  const code = await main(["run", "new", "Explore business ideas for independent pharmacies", "--home", home, "--json"], {
    write: (text) => output.push(text),
  }, {
    models: Object.fromEntries(roles.map((role) => [role, model])) as never,
    apiKeyFor: async () => "key",
    runFrame: async (d) => { writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
    runDiscover: async (d) => { writeStatus(d.run, { phase: "ideate" }); return { outcome: "ok" }; },
    runIdeate: async (d) => {
      writeStatus(d.run, { state: "stopped", outcome: { kind: "stopped", stopKind: "rounds" }, cursor: { step: "checkpoint" } });
      return { outcome: "stopped", stopKind: "rounds" };
    },
    runCheckpoint: async () => { checkpointCalls++; return { outcome: "ok" }; },
  });
  expect(code).toBe(0);
  expect(checkpointCalls).toBe(0);
  expect(JSON.parse(output.join("")).status).toMatchObject({ phase: "ideate", state: "stopped" });
});
