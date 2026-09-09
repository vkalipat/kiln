import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
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
