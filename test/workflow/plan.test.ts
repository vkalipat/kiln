import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { TASKS } from "../../scripts/benchmarks/paired-completion";
import {
  compileWorkflow,
  ensureWorkflowPlan,
  loadWorkflowPlan,
  planWorkflow,
  saveWorkflowPlan,
  workflowGuidance,
  workflowInterpretation,
  workflowPath,
} from "../../src/workflow/plan";

describe("adaptive workflow planning", () => {
  test("quantified alternative searches select broad ideation without authorizing a build", () => {
    const actual = "Find three genuinely different, evidence-backed ways a small software team could reduce the time independent repair businesses spend turning customer emails into accurate quotes. Assume a two-person team and a six-week prototype window. Research existing products so the proposals have a concrete distinction from existing offerings; compare value, feasibility, and differentiation; recommend the strongest starting point and explain what evidence could invalidate it. Deliver an ideation shortlist and recommendation only. Do not build, buy anything, contact people, or deploy services.";
    for (const seed of [actual,
      "Find 4 distinct ways to reduce food waste. Ideas only.",
      "Suggest several practical approaches to scheduling repairs. Recommendations only.",
      "Identify two evidence-backed, meaningfully different approaches to affordable cooling. Research only.",
      "Generate five ambitious ideas for reliable local transport. Ideas only.",
    ]) {
      const plan = planWorkflow(seed);
      expect(plan).toMatchObject({ intent: "open_ended_ideation", goal: "explore", defaultThrough: "checkpoint", strategy: { mode: "exploratory", research: "broad" } });
      expect(compileWorkflow(plan, {}).phases).toEqual(["frame", "discover", "ideate", "checkpoint"]);
    }
    for (const seed of ["Find three bugs in this repo", "Find three different approaches to fixing my existing app"]) {
      expect(planWorkflow(seed)).toMatchObject({ intent: "existing_artifact", artifactContext: "not_supplied" });
    }
    expect(planWorkflow("Find way to implement this spec for a CSV parser")).toMatchObject({ intent: "supplied_concept", strategy: { mode: "direct", research: "none" } });
  });
  test("complete local task prompts preserve direct execution through all location clauses", () => {
    for (const task of TASKS) {
      const plan = planWorkflow(task.prompt);
      expect(plan).toMatchObject({ intent: "supplied_concept", goal: "deliver", strategy: { mode: "direct", research: "none" }, directFrame: "deterministic-v1" });
      expect(compileWorkflow(plan, {}).phases).toEqual(["frame", "form", "build", "reflect"]);
      expect(planWorkflow(task.prompt, { adaptive: false }).directFrame).toBeUndefined();
    }
  });
  test("greenfield output locations do not imply an existing source project", () => {
    for (const seed of [
      "Create and ship a Python CLI to normalize text. Put the named CLI at the project root.",
      "Write a CSV converter script. Save its files in the project directory.",
      "Create a command-line calculator in the project directory.",
      "Create a Python CLI. Run its tests from the project root.",
      "Build a JSON parser script. Include tests passing with a test command from the project directory.",
      "Write a parser script and verify it with python -m unittest discover.",
    ]) {
      const plan = planWorkflow(seed);
      expect(plan).toMatchObject({ intent: "supplied_concept", goal: "deliver", artifactContext: "not_applicable", defaultThrough: "reflect" });
      expect(compileWorkflow(plan, {}).phases).toEqual(["frame", "form", "build", "reflect"]);
    }
    for (const seed of [
      "Create a CLI feature in this repo. Put it at the project root.",
      "Create a feature in my existing app.",
      "Update the project root configuration.",
      "Review the project directory.",
      "Continue building the project.",
      "Create a report from files in the project directory.",
      "Create a report. Run a command reading files from the project directory.",
    ]) expect(planWorkflow(seed)).toMatchObject({ intent: "existing_artifact", artifactContext: "not_supplied", defaultThrough: "checkpoint" });
    expect(planWorkflow("Create a parser CLI; discover alternatives before implementing it. Run python -m unittest discover.").strategy?.mode).toBe("focused");
  });

  test("existing frozen plans retain their original intent after classifier changes", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-frozen-location-"));
    const seed = "Create a CLI. Put its files at the project root.";
    const run = createRun(home, seed);
    const plan = planWorkflow(readFileSync(run.seed, "utf8"));
    const { directFrame: _directFrame, ...unmarked } = plan;
    const historical = { ...unmarked, intent: "existing_artifact" as const, artifactContext: "not_supplied" as const,
      defaultThrough: "checkpoint" as const, checkpointDefault: "human" as const };
    saveWorkflowPlan(run, historical);
    expect(ensureWorkflowPlan(run)).toEqual(historical);
  });
  test("ordinary requests to write or make an implementation need no delivery flags", () => {
    for (const seed of ["Write a Python script to convert CSV to JSON", "Make a command-line calculator"]) {
      const plan = planWorkflow(seed);
      expect(plan.goal).toBe("deliver");
      expect(plan.strategy).toEqual({ mode: "direct", research: "none" });
      expect(compileWorkflow(plan, {}).phases).toEqual(["frame", "form", "build", "reflect"]);
    }
    for (const seed of ["Write a plan for a Python script", "Do not write a script; research only", "Make a proposal for a CLI"]) {
      expect(planWorkflow(seed).goal).toBe("explore");
    }
  });
  test("brief interpretations distinguish delivery, exploration, and missing artifact context", () => {
    expect(workflowInterpretation(planWorkflow("Build a CSV parser"))).toContain("implementing your supplied concept");
    expect(workflowInterpretation(planWorkflow("Find a startup idea and ship it"))).toContain("implementation and verification");
    expect(workflowInterpretation(planWorkflow("Explore startup ideas"))).toContain("exploring and comparing ideas");
    expect(workflowInterpretation(planWorkflow("A local scheduling service"))).toContain("assumptions and risks");
    expect(workflowInterpretation(planWorkflow("Fix this repository"))).toContain("need its readable source");
  });
  test("a concrete local implementation does not request research merely because it forbids research", () => {
    const plan = planWorkflow("Create and ship a dependency-free Python CLI to slugify text. No external research, hosted service, installation, or deployment is needed. Use the current directory only.");
    expect(plan.strategy).toEqual({ mode: "direct", research: "none" });
    expect(compileWorkflow(plan, {}).phases).toEqual(["frame", "form", "build", "reflect"]);
  });
  test("treats an ambitious wish as an open-ended search and derives a complete delivery path", () => {
    const plan = planWorkflow("Find an idea that will make me a billionaire and ship it.");

    expect(plan).toMatchObject({
      version: 1,
      intent: "open_ended_ideation",
      goal: "deliver",
      defaultThrough: "reflect",
      assumptionPolicy: "bounded",
      researchPolicy: "landscape",
      checkpointDefault: "autonomous",
    });
    expect(plan.rationale.join(" ")).toContain("checkable proxy");
    expect(compileWorkflow(plan, {})).toMatchObject({
      through: "reflect",
      throughSource: "intent",
      checkpointPolicy: "autonomous",
      phases: ["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"],
    });
  });

  test("distinguishes a supplied concept from work on an existing artifact", () => {
    expect(planWorkflow("Build a local household-energy comparison tool")).toMatchObject({
      intent: "supplied_concept",
      goal: "deliver",
      researchPolicy: "targeted",
      assumptionPolicy: "preserve",
    });
    expect(planWorkflow("Build an app for beekeepers")).toMatchObject({
      intent: "supplied_concept",
      artifactContext: "not_applicable",
    });
    expect(planWorkflow("I have an idea for a browser extension that compares privacy policies")).toMatchObject({
      intent: "supplied_concept",
      goal: "explore",
    });
    expect(planWorkflow("Give me business ideas for independent pharmacies")).toMatchObject({
      intent: "open_ended_ideation",
      goal: "explore",
    });
    expect(planWorkflow("Continue the existing project and fix its import flow")).toMatchObject({
      intent: "existing_artifact",
      goal: "deliver",
      researchPolicy: "repository_first",
      assumptionPolicy: "inspect_existing",
      artifactContext: "not_supplied",
      defaultThrough: "checkpoint",
      checkpointDefault: "human",
    });
  });

  test("keeps exploration at the checkpoint and lets explicit controls win", () => {
    expect(planWorkflow("Explore business ideas for independent pharmacies")).toMatchObject({
      goal: "explore",
      defaultThrough: "checkpoint",
      checkpointDefault: "human",
    });
    expect(compileWorkflow(planWorkflow("Explore business ideas for independent pharmacies"), {
      through: "build", autonomous: true,
    })).toMatchObject({
      through: "build",
      throughSource: "explicit",
      checkpointPolicy: "autonomous",
      phases: ["frame", "discover", "ideate", "checkpoint", "form", "build"],
    });
    expect(compileWorkflow(planWorkflow("Find a startup idea and ship it"), { interactive: true })).toMatchObject({
      through: "reflect",
      checkpointPolicy: "human",
    });
  });

  test("changes phase behavior instead of only labelling the run", () => {
    const open = planWorkflow("Give me business ideas for pharmacies");
    const supplied = planWorkflow("A refill-forecasting service for independent pharmacies");
    expect(workflowGuidance(open, "ideate")).toContain("broad portfolio");
    expect(workflowGuidance(supplied, "discover")).toContain("do not perform broad unrelated market exploration");
    expect(workflowGuidance(supplied, "ideate")).toContain("not unrelated replacement concepts");
  });

  test("persists a frozen plan and rejects a conflicting rewrite", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-workflow-"));
    const run = createRun(home, "Find an idea for safer clinical handoffs");
    const plan = planWorkflow(readFileSync(run.seed, "utf8"));

    saveWorkflowPlan(run, plan);
    expect(loadWorkflowPlan(run)).toEqual(plan);
    expect(JSON.parse(readFileSync(workflowPath(run), "utf8"))).toEqual(plan);
    expect(() => saveWorkflowPlan(run, planWorkflow("Build a recipe app"))).toThrow("workflow plan is already frozen");
    writeFileSync(run.seed, "a changed seed\n");
    expect(() => ensureWorkflowPlan(run)).toThrow("does not match the run seed");
  });
});
