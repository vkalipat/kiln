import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun, writeStatus } from "../../src/core/run";
import { projectPaths } from "../../src/formation/paths";
import { shapeHash } from "../../src/phases/contracts";
import { runForm, type FormDeps } from "../../src/phases/form";
import { parseBrief } from "../../src/phases/frame";
import { planWorkflow } from "../../src/workflow/plan";
import { applyWorkflowProfile } from "../../src/workflow/profile";
import { applyFrozenRouting, freezeRouting } from "../../src/workflow/routing";
import { FakeGitRunner } from "../build/fake-git";

const brief = "# Brief\n\n## Problem\nBuild the supplied local utility.\n\n## Constraints\n- local only\n\n## Search success\n- usable outputs, tests and documentation\n\n## Non-goals\n- hosted service\n\n## Shape\nproduct\n\n## Axes\n- user: operator | analyst | developer\n- mechanism: cli | library | gui\n- value: speed | accuracy | clarity\n\n## Discovery questions\n- Which inputs are valid?\n";
const idea = "## Title\nLocal utility\n\n## Mechanism\nTransform local inputs into usable outputs.\n\n## Draws on\nLocal processing.\n\n## Axes\n- user: operator\n- mechanism: cli\n- value: clarity\n\n## Testable claim\nA user gets the requested output.\n\n## Cheapest test\nCheck the requested output.\n\n## Strongest failure reason\nInputs may be malformed.\n";
const spec = "# Spec\n\n## What\nA local utility with the requested behaviors.\n\n## For whom\nOperators.\n\n## Why now\nThe task is supplied.\n\n## Scope\n- requested behaviors, tests and documentation\n\n## Non-goals\n- hosted service\n\n## Risks\nMalformed input.\n\n## First milestone\nAll requested behaviors work with tests and documentation.\n";

test("formation pins cohesive behavior slices while allowing one or multiple independently verified features", async () => {
  for (const count of [1, 3]) {
    const home = mkdtempSync(join(tmpdir(), "kiln-feature-slices-"));
    initHome(home);
    const run = createRun(home, "Build the requested local utility with tests and README usage.");
    const record = new RunRecord(run.record);
    const paths = projectPaths(run.project);
    writeFileSync(run.brief, brief);
    writeFileSync(join(run.ideasDir, "supplied-task.md"), idea);
    writeFileSync(join(run.ideasDir, "supplied-task.evidence.json"), JSON.stringify({ status: "unranked", parents: [] }));
    const parsed = parseBrief(brief);
    writeStatus(run, { phase: "form", state: "running", shape: parsed.shape, shapeHash: shapeHash(parsed), chosenIdeaId: "supplied-task" });
    const list = (assigned: boolean) => ({ version: 1, init: { needs: [] }, features: Array.from({ length: count }, (_, i) => ({
      ...(assigned ? { id: `f0${i + 1}` } : {}), title: `Independent behavior ${i + 1}`,
      description: `Deliver behavior ${i + 1}, its tests and documented usage.`,
      acceptance: { type: "shell", command: `test -f behavior-${i + 1}.py && test -f test_behavior-${i + 1}.py && test -s README.md && python3 -m unittest discover -v` },
    })) });
    let wrote = false;
    const producer = createMockModel({ id: "producer", handler: (context: any) => {
      if (context.messages.at(-1)?.role === "toolResult") return { content: ["done"] };
      const assigned = wrote; wrote = true;
      return { content: [
        { type: "toolCall", name: "write", arguments: { path: paths.spec, content: spec } },
        { type: "toolCall", name: "write", arguments: { path: paths.featuresMirror, content: JSON.stringify(list(assigned)) } },
        { type: "toolCall", name: "write", arguments: { path: paths.initSh, content: "#!/bin/sh\nexit 0\n" } },
      ] };
    } } as never);
    const critic = createMockModel({ id: "independent", handler: () => ({ content: [{ type: "toolCall", name: "critique", arguments: { verdict: "ok", scopeCreep: [], unverifiable: [], missing: [] } }] }) } as never);
    const seed = readFileSync(run.seed, "utf8");
    const profile = applyWorkflowProfile(defaultConfig(), planWorkflow(seed));
    expect(profile.build.minFeatures).toBe(1);
    freezeRouting(run, profile, {});
    const cfg = applyFrozenRouting(defaultConfig(), run);
    expect(cfg.build.minFeatures).toBe(1);
    const deps: FormDeps = { home, run, record, cfg, limiter: new Limiter(1), git: new FakeGitRunner(),
      models: () => ({ model: producer as never, ref: "producer/producer" }),
      modelsOn: () => ({ model: critic as never, ref: "other/independent" }), availableProviders: new Set(["producer", "other"]),
      apiKeyFor: async () => "mock", streamFn: streamMock as never, effort: "medium" };
    expect(await runForm(deps)).toEqual({ outcome: "ok" });
    const pinned = (producer.calls[0]!.context.systemPrompt ?? []).join("\n");
    expect(pinned).toContain("Do not create separate features just for tests or README work supporting the same behavior");
    expect(pinned).toContain("A small supplied local utility should usually be one feature");
    expect(pinned).toContain("Use multiple features for independently useful and verifiable behaviors");
    expect(pinned).toContain("Preserve every user requirement and executable acceptance check within these slices");
    expect(pinned).toMatch(/init.needs and 1-\d+ features/);
    expect(JSON.parse(readFileSync(run.features, "utf8"))).toEqual(list(true));
    expect(JSON.parse(readFileSync(run.acceptanceLock, "utf8"))).toBeTruthy();
    expect(record.read().filter((event) => event.t === "critique")).toHaveLength(2);
    expect(critic.calls).toHaveLength(2);
  }
});
