import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig, type IdeaShape, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { appendLine, writeAtomic } from "../../src/core/paths";
import { createRun, readStatus, runPaths, writeStatus } from "../../src/core/run";
import { hashInput, RunRecord } from "../../src/core/record";
import { discoverCalibrationGroups, impliedPreferences } from "../../src/evals/calibrate";
import { createProductionEffortSweepDeps, productionEffortProjector } from "../../src/evals/effort-runner";
import type { EffortCellRequest } from "../../src/evals/effort";
import type { FrontierFile } from "../../src/phases/ideate";
import { FakeGitRunner } from "../build/fake-git";
import { projectPaths, writeProjectMarker } from "../../src/formation/paths";
import { writeAcceptanceLock } from "../../src/formation/lock";
import type { FeaturesFile } from "../../src/formation/features";
import type { RunExecutorSpec, RunSummary } from "../../src/evals/executor";

const USAGE = { input: 100, output: 20 };
function contextText(ctx: { messages?: Array<{ role?: string; content?: unknown }> }): string {
  const message = [...(ctx.messages ?? [])].reverse().find((item) => item.role === "user");
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "").join("\n") : "";
}
function model() {
  const value = createMockModel({ id: "judge", provider: "mock", handler: (ctx: unknown) => {
    const context = ctx as { tools?: Array<{ name: string }>; messages?: Array<{ role?: string; content?: unknown }> };
    if (!(context.tools ?? []).some((tool) => tool.name === "verdict")) return { content: ["Prefer the more consequential concrete mechanism."], usage: USAGE };
    const text = contextText(context); const a = Number(/## Idea A[\s\S]*?VALUE-(\d+)/.exec(text)?.[1]); const b = Number(/## Idea B[\s\S]*?VALUE-(\d+)/.exec(text)?.[1]);
    return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: a < b ? "A" : "B", feasibilityWinner: "A", reason: "fixture" } }], usage: USAGE };
  } });
  return new Proxy(value, { get(target, property, receiver) {
    return property === "thinking" ? { efforts: ["low", "medium", "high", "xhigh"] as const } : Reflect.get(target, property, receiver);
  } });
}
function request(target: EffortCellRequest["target"], level: EffortCellRequest["level"] = "low"): EffortCellRequest {
  const roles = target === "generator+brain" ? ["generator", "brain"] as Role[] : [target as Role];
  return { id: `${target}-${level}`, target, roles, profile: "default", level, kind: "level", rounds: 1, evalId: "effort-production" };
}

describe("production effort factory", () => {
  test("returns CLI-ready deps and routes every target through the matching injectable vehicle", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-runner-")); initHome(home); const cfg = defaultConfig(); const heldModel = model(); const calls: string[] = [];
    const runtime = { models: (role: Role) => ({ model: heldModel as never, ref: `mock/${role}` }), apiKeyFor: async () => "key", available: new Set(["mock"]),
      modelsOn: (role: Role) => ({ model: heldModel as never, ref: `mock/${role}` }), fetchUsage: async () => undefined, auth: {} as never };
    const vehicle = (name: string) => async (cell: EffortCellRequest, context: { cli: { runtimeEffort?: unknown } }) => {
      calls.push(`${name}:${cell.target}`); expect(context.cli.runtimeEffort).toEqual({ enabled: false, profile: "default" });
      return { wins: 1, n: 1, quality: 1, usdPerSuccess: 1, costUsd: 1 };
    };
    const git = new FakeGitRunner();
    const deps = await createProductionEffortSweepDeps(home, cfg, {}, { runtime: runtime as never, git, executor: async () => { throw new Error("unused"); },
      judge: vehicle("judge") as never, ideate: vehicle("ideate") as never, build: vehicle("build") as never });
    await deps.handler(request("judge")); await deps.handler(request("generator+brain")); await deps.handler(request("builder")); await deps.handler(request("auditor"));
    expect(calls).toEqual(["judge:judge", "ideate:generator+brain", "build:builder", "build:auditor"]);
    expect(deps.models("judge").ref).toBe("mock/judge"); expect(deps.git).toBe(git);
    expect(deps.project?.(request("judge", "high"))).toBe(productionEffortProjector(request("judge", "high")));
  });

  test("the real judge vehicle replays the same complete durable group and resumes its orderings", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-runner-")); initHome(home); const cfg = defaultConfig();
    const run = createRun(home, "fixture seed", { id: "source" }); writeStatus(run, { shape: "product" });
    writeFileSync(join(run.criteriaDir, "r1-deadbeef.md"), "Prefer lower VALUE rank.\n");
    const ids = ["a", "b", "c", "d"]; ids.forEach((id, index) => writeFileSync(join(run.renderedDir, `${id}-r1.md`), `VALUE-${index + 1}\n`));
    const frontier: FrontierFile = { version: 1, mode: "loop", round: 1, rawFront: ids, shown: ids, eligible: ids,
      ideas: ids.map((id) => ({ id, backfill: false, cell: id })), ladders: { value: ids, feasibility: ids }, searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true };
    writeAtomic(run.frontier, `${JSON.stringify(frontier)}\n`);
    const group = discoverCalibrationGroups(home)[0]!; const replay = join(home, "evals", "calibration", "fixture.jsonl");
    let seq = 0;
    for (const preference of impliedPreferences(ids, "a", "d")) {
      const [left, right] = [preference.winner, preference.loser].sort(); const a = `${group.id}/${left}`; const b = `${group.id}/${right}`;
      for (const order of ["ab", "ba"] as const) appendLine(replay, JSON.stringify({ seq: ++seq, calibrationGroupId: group.id, a, b, order, round: 1,
        valueWinner: "a", labelWinner: `${group.id}/${preference.winner}`, labelBest: "a", labelWorst: "d", judgeModel: "mock/judge" }));
    }
    writeAtomic(join(home, "evals", "calibration.json"), `${JSON.stringify({ version: 1, labelSource: "human", computedAt: "2026-09-05T00:00:00.000Z",
      hash: { judgePrompt: "j", kernelPrompt: "k", judgeModel: "mock/judge", renderVersion: 1, effort: "medium" }, effort: "medium", groups: 1,
      impliedPairs: 5, refusedGroups: 0, agreement: 1, orderAgreement: 1, feasibilityOrderAgreement: 1, calibrated: false, provisional: true,
      byShape: {}, strata: {}, costUsd: 0 }, null, 2)}\n`);
    const heldModel = model(); const runtime = { models: (_role: Role) => ({ model: heldModel as never, ref: "mock/judge" }), apiKeyFor: async () => "key", available: new Set(["mock"]),
      modelsOn: (_role: Role) => ({ model: heldModel as never, ref: "mock/judge" }), fetchUsage: async () => undefined, auth: {} as never };
    const deps = await createProductionEffortSweepDeps(home, cfg, { streamFn: streamMock as never }, { runtime: runtime as never, git: new FakeGitRunner(), executor: async () => { throw new Error("unused"); } });
    const first = await deps.handler(request("judge")); expect(first).toMatchObject({ wins: 5, n: 5, quality: 1 }); expect(heldModel.calls).toHaveLength(10);
    const resumed = await deps.handler(request("judge")); expect(resumed.n).toBe(5); expect(heldModel.calls).toHaveLength(10);
  });

  test("projector covers the binding judge, loop, builder, auditor, and A/A cells", () => {
    expect(productionEffortProjector(request("judge", "low"))).toBe(3.95);
    expect(productionEffortProjector(request("generator+brain", "low"))).toBeCloseTo(99.75);
    expect(productionEffortProjector(request("builder", "high"))).toBe(56.4);
    expect(productionEffortProjector(request("auditor", "xhigh"))).toBe(52.25);
    expect(productionEffortProjector({ ...request("generator+brain", "medium"), kind: "aa" })).toBe(53.42);
  });

  test("default ideate vehicle runs the 12-dev incumbent/cell pair with k=8 and frozen effort", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-runner-")); initHome(home); const cfg = defaultConfig(); const heldModel = model(); const specs: Array<{ arm: string; effort: unknown }> = [];
    const runtime = { models: (role: Role) => ({ model: heldModel as never, ref: `mock/${role}` }), apiKeyFor: async () => "key", available: new Set(["mock"]),
      modelsOn: (role: Role) => ({ model: heldModel as never, ref: `mock/${role}` }), fetchUsage: async () => undefined, auth: {} as never };
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      specs.push({ arm: spec.arm, effort: structuredClone(spec.effort) }); const run = existsSync(runPaths(spec.home, spec.runId).status) ? runPaths(spec.home, spec.runId) : createRun(spec.home, spec.seedText, { id: spec.runId });
      const shape: IdeaShape = spec.seedIdentity.id.includes("research") ? "research" : spec.seedIdentity.id.includes("creative") ? "creative" : "product";
      const ids = Array.from({ length: 8 }, (_, index) => `idea-${index}`);
      ids.forEach((id, index) => writeFileSync(join(run.renderedDir, `${id}-r1.md`), `VALUE-${index + 1}\n`));
      writeAtomic(run.frontier, `${JSON.stringify({ version: 1, mode: "loop", round: 1, shown: ids, ideas: ids.map((id) => ({ id })) })}\n`);
      writeStatus(run, { shape, seed: spec.seedIdentity, phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
      const status = readStatus(run); return { runId: run.id, seedId: spec.seedIdentity.id, split: "dev", shape, arm: spec.arm, status, outcome: status.outcome, costUsd: 0, metrics: {}, frontier: {} };
    };
    const deps = await createProductionEffortSweepDeps(home, cfg, { streamFn: streamMock as never }, { runtime: runtime as never, git: new FakeGitRunner(), executor });
    const result = await deps.handler(request("generator+brain", "low"));
    expect(result).toMatchObject({ wins: 48, n: 96, quality: 0.5 }); expect(specs).toHaveLength(24);
    expect(specs[0]?.effort).toMatchObject({ brain: { level: "high" }, generator: { level: "medium" } });
    expect(specs[1]?.effort).toMatchObject({ brain: { level: "low", source: "profile" }, generator: { level: "low", source: "profile" } });
  });

  test("default build vehicle forms five freezes once, clones them, and compares executed feature state", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-runner-")); initHome(home); const cfg = defaultConfig(); const heldModel = model(); let formCalls = 0; let buildCalls = 0;
    const runtime = { models: (role: Role) => ({ model: heldModel as never, ref: `mock/${role}` }), apiKeyFor: async () => "key", available: new Set(["mock"]),
      modelsOn: (role: Role) => ({ model: heldModel as never, ref: `mock/${role}` }), fetchUsage: async () => undefined, auth: {} as never };
    const executor = async (spec: RunExecutorSpec): Promise<RunSummary> => {
      const held = runPaths(spec.home, spec.runId); const run = existsSync(held.status) ? held : createRun(spec.home, spec.seedText, { id: spec.runId });
      if (spec.through === "form") {
        formCalls += 1; const project = projectPaths(run.project); for (const dir of [project.dir, project.repo, project.checksDir, project.blockedDir]) mkdirSync(dir, { recursive: true });
        writeProjectMarker(run.project, { runId: run.id, ideaId: "idea", kilnVersion: "test", createdAt: "2026-09-05T00:00:00.000Z" });
        const text = "# Spec\n\n## First milestone\nWorks.\n"; const specHash = hashInput(text);
        const features: FeaturesFile = { version: 1, init: { needs: [] }, features: [{ id: "f01", title: "one", description: "one", acceptance: { type: "file", path: "out" } }] };
        const lock = writeAcceptanceLock(features, specHash); const featureText = `${JSON.stringify(features, null, 2)}\n`; const lockText = `${JSON.stringify(lock, null, 2)}\n`;
        writeFileSync(project.spec, text); writeFileSync(project.initSh, "#!/bin/sh\n"); writeFileSync(run.features, featureText); writeFileSync(project.featuresMirror, featureText);
        writeFileSync(run.acceptanceLock, lockText); writeFileSync(project.lockMirror, lockText); writeFileSync(run.featureState, "");
        new RunRecord(run.record).append({ t: "freeze", featureCount: 1, lockIdsHash: lock.ids, lockHash: hashInput(lock), manualCount: 0, executableCount: 1, needsUnion: [], specHash });
        writeStatus(run, { phase: "build", state: "running", projectDir: run.project, specHash });
      } else {
        buildCalls += 1; if (readFileSync(run.featureState, "utf8") === "") appendLine(run.featureState, JSON.stringify({ t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1, repairs: 0 }));
        writeStatus(run, { phase: "build", state: "done", outcome: { kind: "success" } });
      }
      const status = readStatus(run); return { runId: run.id, seedId: spec.seedIdentity.id, split: "dev", shape: "product", arm: spec.arm, status, outcome: status.outcome, costUsd: 0, metrics: {} };
    };
    const deps = await createProductionEffortSweepDeps(home, cfg, {}, { runtime: runtime as never, git: new FakeGitRunner(), executor });
    const result = await deps.handler(request("builder", "low"));
    expect(result).toMatchObject({ wins: 2.5, n: 5, quality: 0.5 }); expect(formCalls).toBe(5); expect(buildCalls).toBe(10);
  });
});
