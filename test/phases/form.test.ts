import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { hashInput, RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { formationApprovalPath, writeFormationApproval } from "../../src/formation/freeze";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { materializeProjectPath, projectPaths, readProjectMarker, writeProjectMarker } from "../../src/formation/paths";
import type { FeaturesFile } from "../../src/formation/features";
import { lastChosenIdea, runForm, type FormDeps } from "../../src/phases/form";
import { parseBrief } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { FakeGitRunner } from "../build/fake-git";

const BRIEF = `# Brief\n\n## Problem\nOperators need a tool.\n\n## Constraints\n- local only\n\n## Search success\n- visible output\n\n## Non-goals\n- hosted service\n\n## Shape\nproduct\n\n## Axes\n- buyer: solo | team | enterprise\n- mechanism: cli | web | api\n- value: speed | quality | cost\n\n## Discovery questions\n- What exists?\n- What fails?\n`;
const SPEC = `# Spec\n\n## What\nA local command.\n\n## For whom\nOperators.\n\n## Why now\nInputs are available.\n\n## Scope\n- one command\n\n## Non-goals\n- hosted service\n\n## Risks\nInput drift.\n\n## First milestone\nA user runs the command and sees a result.\n`;
const IDEA = `## Title\nLocal Lens\n\n## Mechanism\nTurn local inputs into a concise result.\n\n## Draws on\nCompiler pipelines.\n\n## Axes\n- buyer: solo\n- mechanism: cli\n- value: speed\n\n## Testable claim\nA user gets output.\n\n## Cheapest test\nRun a file check.\n\n## Strongest failure reason\nInputs may vary.\n`;

function features(ids: boolean): FeaturesFile | Omit<FeaturesFile, "features"> & { features: Array<Omit<FeaturesFile["features"][number], "id">> } {
  const values = [1, 2, 3].map((n) => ({
    ...(ids ? { id: `f0${n}` } : {}), title: `Feature ${n}`, description: `Deliver ${n}`,
    acceptance: { type: "file" as const, path: `f${n}.txt` },
  }));
  return { version: 1, init: { needs: [] }, features: values as never };
}

function lastMessage(ctx: any) { return (ctx.messages ?? []).at(-1); }
function lastUser(ctx: any): string {
  for (let index = (ctx.messages ?? []).length - 1; index >= 0; index -= 1) {
    const message = ctx.messages[index]; if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return (message.content ?? []).map((part: any) => part.text ?? "").join("\n");
  }
  return "";
}
const writeCall = (path: string, content: string) => ({ type: "toolCall", name: "write", arguments: { path, content } });

function producer(paths: ReturnType<typeof projectPaths>, opts: { declared?: boolean; invalidFirst?: boolean; manualRevision?: boolean; oneManualRevision?: boolean; prefilledInitial?: "correct" | "malicious" } = {}) {
  return createMockModel({ id: "brain", handler: (ctx: any) => {
    if (lastMessage(ctx)?.role === "toolResult") return { content: ["done"] };
    const prompt = lastUser(ctx);
    if (opts.declared && prompt.includes(`Write ${paths.spec}`)) return { content: [{ type: "toolCall", name: "exit", arguments: { kind: "not_formable", reasons: ["idea cannot meet the constraint"] } }] };
    if (prompt.includes(`${paths.spec} is not usable`)) return { content: [writeCall(paths.spec, SPEC)] };
    if (prompt.includes(`${paths.featuresMirror} is not usable`)) return { content: [writeCall(paths.featuresMirror, JSON.stringify(features(false)))] };
    if (prompt.includes(`${paths.initSh} is not usable`)) return { content: [writeCall(paths.initSh, "#!/bin/sh\nexit 0\n")] };
    if (prompt.includes(`Write ${paths.spec}`) && !prompt.includes("Revise")) return { content: [writeCall(paths.spec, opts.invalidFirst ? "# bad" : SPEC)] };
    if (prompt.includes(`Write ${paths.featuresMirror}`) && !prompt.includes("Revise")) {
      const initial = features(false) as any;
      if (opts.prefilledInitial) initial.features.forEach((feature: any, index: number) => Object.assign(feature, { id: opts.prefilledInitial === "correct" ? `f0${index + 1}` : `model-${index + 1}`, passes: true, attempts: 9 }));
      return { content: [writeCall(paths.featuresMirror, opts.invalidFirst ? "not-json" : JSON.stringify(initial))] };
    }
    if (prompt.includes(`Write ${paths.initSh}`) && !prompt.includes("Revise")) return { content: [writeCall(paths.initSh, opts.invalidFirst ? "exit 0\n" : "#!/bin/sh\nexit 0\n")] };
    if (prompt.includes("Revise the complete") || prompt.includes("revision is invalid")) return { content: [
      writeCall(paths.spec, SPEC),
      writeCall(paths.featuresMirror, JSON.stringify(opts.manualRevision ? {
        version: 1, init: { needs: [] }, features: [1, 2, 3].map((n) => ({ id: `f0${n}`, title: `Feature ${n}`, description: `Deliver ${n}`, acceptance: { type: "manual", instructions: "look" } })),
      } : opts.oneManualRevision ? {
        version: 1, init: { needs: [] }, features: [1, 2, 3].map((n) => ({ id: `f0${n}`, title: `Feature ${n}`, description: `Deliver ${n}`, acceptance: n === 2 ? { type: "manual", instructions: "look" } : { type: "file", path: `f${n}.txt` } })),
      } : features(true))),
      writeCall(paths.initSh, "#!/bin/sh\nexit 0\n"),
    ] };
    return { content: ["done"] };
  } } as never);
}

function critic(verdicts: Array<"ok" | "revise">, cost?: unknown, noTool = false) {
  let n = 0;
  return createMockModel({ id: "critic", cost, handler: () => {
    const verdict = verdicts[Math.min(n++, verdicts.length - 1)] ?? "ok";
    return noTool ? { content: ["no structured call"], usage: { input: 1_000, output: 1_000 } }
      : { content: [{ type: "toolCall", name: "critique", arguments: { scopeCreep: [], unverifiable: [], missing: [], verdict } }], usage: cost ? { input: 1_000, output: 1_000 } : undefined };
  } } as never);
}

function setup(opts: { chosen?: string; criticVerdicts?: Array<"ok" | "revise">; declared?: boolean; criticModels?: unknown[]; invalidFirst?: boolean; manualRevision?: boolean; oneManualRevision?: boolean; prefilledInitial?: "correct" | "malicious" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-form-")); initHome(home);
  const run = createRun(home, "seed", { id: "form-run" }); const record = new RunRecord(run.record); const paths = projectPaths(run.project);
  writeFileSync(run.brief, BRIEF); const parsed = parseBrief(BRIEF);
  const chosen = opts.chosen ?? "idea-a";
  writeStatus(run, { phase: "form", state: "running", shape: parsed.shape, shapeHash: shapeHash(parsed), chosenIdeaId: chosen });
  for (const id of new Set([chosen, "idea-a", "idea-b"])) {
    writeFileSync(join(run.ideasDir, `${id}.md`), IDEA);
    writeFileSync(join(run.ideasDir, `${id}.evidence.json`), JSON.stringify({ status: "active", parents: [] }));
  }
  const brain = producer(paths, { declared: opts.declared, invalidFirst: opts.invalidFirst, manualRevision: opts.manualRevision, oneManualRevision: opts.oneManualRevision, prefilledInitial: opts.prefilledInitial });
  const defaultCritic = critic(opts.criticVerdicts ?? ["ok", "ok"]); let criticIndex = 0;
  const deps: FormDeps = {
    home, run, record, cfg: defaultConfig(), models: () => ({ model: brain as never, ref: "producer/brain" }),
    availableProviders: new Set(["producer", "other"]),
    modelsOn: () => ({ model: (opts.criticModels?.[criticIndex++] ?? defaultCritic) as never, ref: "other/critic" }),
    apiKeyFor: async () => "key", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(1), git: new FakeGitRunner(),
  };
  return { home, run, record, paths, brain, critic: defaultCritic, deps, git: deps.git as FakeGitRunner };
}

describe("runForm", () => {
  test("lastChosenIdea ignores reject and another-round ids", () => {
    const s = setup({ chosen: undefined });
    s.record.append({ t: "checkpoint.decision", kind: "pick", id: "idea-a" });
    s.record.append({ t: "checkpoint.decision", kind: "reject", id: "idea-b", reason: "no" });
    s.record.append({ t: "checkpoint.decision", kind: "another_round", steering: "broader" });
    expect(lastChosenIdea(s.record)).toBe("idea-a");
    s.record.append({ t: "checkpoint.decision", kind: "autonomous_pick", id: "idea-b" });
    expect(lastChosenIdea(s.record)).toBe("idea-b");
  });

  test("reuses one form brain, critiques twice, revises once, freezes and advances", async () => {
    const s = setup(); const result = await runForm(s.deps);
    expect(result).toEqual({ outcome: "ok" });
    expect(readStatus(s.run)).toMatchObject({ phase: "build", state: "running", chosenIdeaId: "idea-a", specHash: expect.any(String) });
    expect(JSON.parse(readFileSync(s.run.features, "utf8")).features.map((item: any) => item.id)).toEqual(["f01", "f02", "f03"]);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "formation.attempt")).toMatchObject([{ ideaId: "idea-a", attempt: 1 }]);
    expect(s.record.read().filter((event) => event.t === "formation.revision")).toMatchObject([{ ideaId: "idea-a", attempt: 1 }]);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
    expect(s.git.commits).toHaveLength(1);
    expect(s.brain.calls.length).toBeGreaterThan(3);
    const system = (s.brain.calls[0]!.context.systemPrompt ?? []).join("\n");
    expect(system).toContain("3-7 features");
    expect(system).toContain("First milestone must be 1-600 characters");
    expect(system).toContain("What, For whom, Why now, Scope, Non-goals, Risks, First milestone");
    expect(system).not.toContain("3-12 features");
    expect(system).not.toContain("Turn guard:");
  });

  test("stops initial production as soon as all three artifacts validate", async () => {
    const s = setup(); let unnecessaryFollowups = 0;
    const brain = createMockModel({ id: "bundle-aware", handler: (ctx: any) => {
      const prompt = lastUser(ctx);
      if (lastMessage(ctx)?.role === "toolResult") {
        if (!prompt.includes("Revise the complete")) unnecessaryFollowups += 1;
        return { content: ["done"] };
      }
      if (prompt.includes(`Write ${s.paths.spec}`) && !prompt.includes("Revise the complete")) return { content: [
        writeCall(s.paths.spec, SPEC), writeCall(s.paths.featuresMirror, JSON.stringify(features(false))), writeCall(s.paths.initSh, "#!/bin/sh\nexit 0\n"),
      ] };
      if (prompt.includes("Revise the complete")) return { content: [
        writeCall(s.paths.spec, SPEC), writeCall(s.paths.featuresMirror, JSON.stringify(features(true))), writeCall(s.paths.initSh, "#!/bin/sh\nexit 0\n"),
      ] };
      return { content: ["done"] };
    } } as never);
    s.deps.models = () => ({ model: brain as never, ref: "producer/bundle-aware" });

    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(unnecessaryFollowups).toBe(0);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
  });

  test("feeds full-bundle validation errors back immediately and cannot stop an invalid bundle", async () => {
    const s = setup(); let sawFeedback = false;
    const overlong = SPEC.replace("A user runs the command and sees a result.", "x".repeat(601));
    const brain = createMockModel({ id: "bundle-repair", handler: (ctx: any) => {
      const prompt = lastUser(ctx);
      if (prompt.includes("Harness validation still fails")) {
        sawFeedback = prompt.includes("First milestone: 601 characters (cap 600)");
        return { content: [writeCall(s.paths.spec, SPEC)] };
      }
      if (lastMessage(ctx)?.role === "toolResult") return { content: ["done"] };
      if (prompt.includes(`Write ${s.paths.spec}`) && !prompt.includes("Revise the complete")) return { content: [
        writeCall(s.paths.spec, overlong), writeCall(s.paths.featuresMirror, JSON.stringify(features(false))), writeCall(s.paths.initSh, "#!/bin/sh\nexit 0\n"),
      ] };
      if (prompt.includes("Revise the complete")) return { content: [
        writeCall(s.paths.spec, SPEC), writeCall(s.paths.featuresMirror, JSON.stringify(features(true))), writeCall(s.paths.initSh, "#!/bin/sh\nexit 0\n"),
      ] };
      return { content: ["done"] };
    } } as never);
    s.deps.models = () => ({ model: brain as never, ref: "producer/bundle-repair" });

    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(sawFeedback).toBe(true);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
  });

  test("a direct unranked task keeps the full user request and brief authoritative", async () => {
    const s = setup({ chosen: "supplied-task" });
    const seed = "Build the complete supplied task, including this detail beyond any dossier summary: PRESERVE-9471.\n";
    writeFileSync(s.run.seed, seed);
    writeFileSync(join(s.run.ideasDir, "supplied-task.evidence.json"), JSON.stringify({
      status: "unranked", parents: [], probe: { status: "not_run", reason: "direct supplied task; no ideation probe" },
    }));
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    const system = (s.brain.calls[0]!.context.systemPrompt ?? []).join("\n");
    expect(system).toContain("This is a direct supplied task");
    expect(system).toContain("PRESERVE-9471");
    expect(system).toContain("## Complete framing brief");
    expect(system).toContain("provisional axes as a competitive ranking");
    expect(system).toContain("Probe: not run (direct supplied task; no ideation probe)");
  });

  test("invalid chosen-idea content cannot reach a form model or acceptance lock", async () => {
    const cases = [
      { label: "incomplete dossier", idea: IDEA.replace("## Cheapest test", "## Omitted test") },
      { label: "invalid evidence json", evidence: "not-json" },
      { label: "rejected evidence", evidence: JSON.stringify({ status: "rejected", parents: [] }) },
      { label: "malformed probe", evidence: JSON.stringify({ status: "unranked", parents: [], probe: { status: "invented" } }) },
    ];
    for (const item of cases) {
      const s = setup();
      if (item.idea) writeFileSync(join(s.run.ideasDir, "idea-a.md"), item.idea);
      if (item.evidence) writeFileSync(join(s.run.ideasDir, "idea-a.evidence.json"), item.evidence);
      expect(await runForm(s.deps), item.label).toMatchObject({ outcome: "failed", failureClass: "integrity" });
      expect(s.brain.calls, item.label).toHaveLength(0);
      expect(existsSync(s.run.acceptanceLock), item.label).toBe(false);
      expect(s.git.commits, item.label).toHaveLength(0);
    }
  });

  test("always assigns initial ids and strips mutable fields even when model ids look canonical", async () => {
    for (const mode of ["correct", "malicious"] as const) {
      let firstCriticContext = "";
      const first = createMockModel({ id: `critic-${mode}`, handler: (ctx: any) => {
        firstCriticContext = (ctx.systemPrompt ?? []).join("\n");
        return { content: [{ type: "toolCall", name: "critique", arguments: { scopeCreep: [], unverifiable: [], missing: [], verdict: "ok" } }] };
      } } as never);
      const s = setup({ prefilledInitial: mode, criticModels: [first, critic(["ok"])] });
      expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
      expect(s.brain.calls).toHaveLength(7);
      expect(firstCriticContext).toContain('"id": "f01"');
      expect(firstCriticContext).not.toContain("model-1");
      expect(firstCriticContext).not.toContain('"passes"');
      expect(firstCriticContext).not.toContain('"attempts"');
    }
  });

  test("a second revise verdict exits not_formable without creating a repo", async () => {
    const s = setup({ criticVerdicts: ["ok", "revise"] });
    const result = await runForm(s.deps);
    expect(result).toMatchObject({ outcome: "honest_exit", kind: "not_formable" });
    expect(existsSync(s.paths.repo)).toBe(false);
    expect(existsSync(s.run.acceptanceLock)).toBe(false);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
    expect(s.record.read().findLast((event) => event.t === "honest_exit")).toMatchObject({ source: "mechanical" });
  });

  test("a declared not_formable exit is allowed and creates no repo", async () => {
    const s = setup({ declared: true }); const result = await runForm(s.deps);
    expect(result).toMatchObject({ outcome: "honest_exit", kind: "not_formable" });
    expect(existsSync(s.paths.repo)).toBe(false);
    expect(s.record.read().find((event) => event.t === "honest_exit")).toMatchObject({ kind: "not_formable", source: "declared" });
  });

  test("each invalid initial file gets exactly one corrective write, including JSON parse and hashbang failures", async () => {
    const s = setup({ invalidFirst: true });
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(s.brain.calls).toHaveLength(13);
    expect(readFileSync(s.paths.initSh, "utf8")).toMatch(/^#!/);
    expect(JSON.parse(readFileSync(s.run.features, "utf8")).features).toHaveLength(3);
  });

  test("valid pre-freeze files are skipped and only the required revision uses the form brain", async () => {
    const s = setup(); const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" });
    writeFileSync(project.spec, SPEC); writeFileSync(project.featuresMirror, JSON.stringify(features(true))); writeFileSync(project.initSh, "#!/bin/sh\nexit 0\n");
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(s.brain.calls).toHaveLength(2);
  });

  test("zero executable checks after the revision exits mechanically without a repo", async () => {
    const s = setup({ manualRevision: true });
    const result = await runForm(s.deps);
    expect(result).toMatchObject({ outcome: "honest_exit", kind: "not_formable" });
    expect(result.outcome === "honest_exit" ? result.reasons : []).toContain("zero executable acceptance checks remain after revision");
    expect(s.record.read().findLast((event) => event.t === "honest_exit")).toMatchObject({ source: "mechanical" });
    expect(existsSync(s.paths.repo)).toBe(false);
  });

  test("binding items constrain revision but do not veto a second ok verdict", async () => {
    const first = critic(["ok"]);
    const second = createMockModel({ id: "critic-binding", responses: [{ content: [{
      type: "toolCall", name: "critique", arguments: {
        scopeCreep: [], missing: [], verdict: "ok", unverifiable: [{ featureId: "f02", text: "manual check remains" }],
      },
    }] }] as never });
    const s = setup({ oneManualRevision: true, criticModels: [first, second] });
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(existsSync(s.run.acceptanceLock)).toBe(true);
  });

  test("an existing lock skips every model and reconciles all post-lock state from authoritative copies", async () => {
    const s = setup(); const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" });
    writeFileSync(project.spec, SPEC); writeFileSync(project.initSh, "#!/bin/sh\n");
    const formed = features(true) as FeaturesFile; writeFileSync(s.run.features, `${JSON.stringify(formed, null, 2)}\n`);
    const lock = writeAcceptanceLock(formed, hashInput(SPEC)); writeFileSync(s.run.acceptanceLock, `${JSON.stringify(lock, null, 2)}\n`);
    writeFileSync(project.featuresMirror, "poison"); writeFileSync(project.lockMirror, "poison");
    let modelCalls = 0; s.deps.models = () => { modelCalls += 1; throw new Error("model must not resolve"); };
    s.deps.modelsOn = () => { modelCalls += 1; throw new Error("critic must not resolve"); };
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    writeFileSync(project.spec, `${SPEC}\n`);
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(modelCalls).toBe(0);
    expect(readFileSync(project.featuresMirror, "utf8")).toBe(readFileSync(s.run.features, "utf8"));
    expect(readFileSync(project.lockMirror, "utf8")).toBe(readFileSync(s.run.acceptanceLock, "utf8"));
    expect(existsSync(s.run.featureState)).toBe(true);
    expect(s.git.commits).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(0);
    expect(s.record.read().filter((event) => event.t === "spec.drift")).toHaveLength(1);
  });

  test("an unapproved authoritative feature file cannot pose as an in-progress freeze", async () => {
    const s = setup(); const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" }); const formed = features(true) as FeaturesFile;
    writeFileSync(project.spec, SPEC); writeFileSync(project.initSh, "#!/bin/sh\n"); writeFileSync(s.run.features, JSON.stringify(formed));
    s.deps.models = () => { throw new Error("form brain must not rerun"); };
    s.deps.modelsOn = () => { throw new Error("critic must not rerun"); };
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity", message: expect.stringContaining("formation approval") });
    expect(existsSync(s.run.acceptanceLock)).toBe(false);
    expect(s.git.commits).toHaveLength(0);
  });

  test("an approved in-progress freeze resumes from authoritative features without models", async () => {
    const s = setup(); const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" }); const formed = features(true) as FeaturesFile;
    writeFileSync(project.spec, SPEC); writeFileSync(project.initSh, "#!/bin/sh\n"); writeFileSync(s.run.features, JSON.stringify(formed));
    writeFormationApproval(s.deps, "idea-a", formed, hashInput(SPEC));
    s.deps.models = () => { throw new Error("form brain must not rerun"); };
    s.deps.modelsOn = () => { throw new Error("critic must not rerun"); };
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(existsSync(s.run.acceptanceLock)).toBe(true);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(0);
    expect(s.git.commits).toHaveLength(1);
  });

  test("post-lock and in-progress resumes require structurally valid spec, init and authoritative features", async () => {
    for (const broken of ["spec", "init", "features"] as const) {
      const s = setup(); const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" });
      if (broken !== "spec") writeFileSync(project.spec, SPEC);
      writeFileSync(project.initSh, broken === "init" ? "exit 0\n" : "#!/bin/sh\n");
      const formed = features(true) as FeaturesFile;
      if (broken === "features") formed.features[1]!.id = "wrong";
      writeFileSync(s.run.features, JSON.stringify(formed));
      s.deps.models = () => { throw new Error("model must not run"); };
      const result = await runForm(s.deps);
      expect(result).toMatchObject({ outcome: "failed", failureClass: "integrity" });
      expect(s.record.read().findLast((event) => event.t === "failure")).toMatchObject({ class: "integrity" });
      expect(s.git.commits).toHaveLength(0);
    }
  });

  test("recovers an external project from the run-side symlink when status.projectDir is absent", async () => {
    const s = setup(); const out = mkdtempSync(join(tmpdir(), "kiln-form-external-")); const project = materializeProjectPath(s.run, out, { ideaId: "idea-a" });
    const formed = features(true) as FeaturesFile;
    writeFileSync(project.spec, SPEC); writeFileSync(project.initSh, "#!/bin/sh\n"); writeFileSync(s.run.features, JSON.stringify(formed));
    writeFormationApproval(s.deps, "idea-a", formed, hashInput(SPEC));
    writeStatus(s.run, { projectDir: undefined });
    s.deps.models = () => { throw new Error("model must not run"); };
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(readStatus(s.run).projectDir).toBe(realpathSync(out));
    expect(existsSync(join(out, "acceptance.lock"))).toBe(true);
  });

  test("a crash after critic approval resumes without another model call or false acceptance", async () => {
    const s = setup();
    s.deps.onApprovalStep = () => { throw new Error("approval-crash"); };
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", message: "approval-crash" });
    expect(existsSync(formationApprovalPath(s.deps))).toBe(true);
    expect(existsSync(s.run.features)).toBe(false);
    const brainCalls = s.brain.calls.length;
    const critiqueCalls = s.record.read().filter((event) => event.t === "critique").length;

    s.deps.onApprovalStep = undefined;
    s.deps.models = () => { throw new Error("form brain must not rerun"); };
    s.deps.modelsOn = () => { throw new Error("critic must not rerun"); };
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(s.brain.calls).toHaveLength(brainCalls);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(critiqueCalls);
    expect(s.git.commits).toHaveLength(1);
    expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
  });

  test("resumes every pre-freeze stage without duplicating durable model work", async () => {
    for (const crashStage of ["first_critique", "revised", "second_critique"] as const) {
      const s = setup();
      s.deps.onFormStage = (stage) => { if (stage === crashStage) throw new Error(`form-crash-${stage}`); };
      expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", message: `form-crash-${crashStage}` });
      const firstBrainCalls = s.brain.calls.length;
      const firstCritiques = s.record.read().filter((event) => event.t === "critique").length;
      expect(firstCritiques).toBe(crashStage === "second_critique" ? 2 : 1);

      s.deps.onFormStage = undefined;
      expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
      expect(s.record.read().filter((event) => event.t === "critique"), crashStage).toHaveLength(2);
      expect(s.record.read().filter((event) => event.t === "formation.revision"), crashStage).toHaveLength(1);
      expect(s.record.read().filter((event) => event.t === "freeze"), crashStage).toHaveLength(1);
      expect(s.git.commits, crashStage).toHaveLength(1);
      if (crashStage !== "first_critique") expect(s.brain.calls, crashStage).toHaveLength(firstBrainCalls);
    }
  });

  test("brain turn guards include turns durably spent before resume", async () => {
    const s = setup();
    s.deps.onFormStage = (stage) => { if (stage === "first_critique") throw new Error("after-first-critique"); };
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", message: "after-first-critique" });
    const spentTurns = s.record.read().filter((event) => event.t === "turn" && event.phase === "form" && event.role === "brain").length;
    expect(spentTurns).toBeGreaterThan(0);
    s.deps.cfg.budgets.turns.form = spentTurns;
    s.deps.onFormStage = undefined;
    const calls = s.brain.calls.length;
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", failureClass: "budget", message: expect.stringContaining("turn cap") });
    expect(s.brain.calls).toHaveLength(calls);
  });

  test("corrupt formation progress fails integrity without replaying models", async () => {
    const s = setup();
    s.deps.onFormStage = (stage) => { if (stage === "revised") throw new Error("after-revision"); };
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", message: "after-revision" });
    const calls = s.brain.calls.length;
    const critiques = s.record.read().filter((event) => event.t === "critique").length;
    writeFileSync(join(s.run.dir, "formation.progress.json"), "not-json");
    s.deps.onFormStage = undefined;
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity", message: expect.stringContaining("formation progress") });
    expect(s.brain.calls).toHaveLength(calls);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(critiques);
    expect(existsSync(s.run.acceptanceLock)).toBe(false);
  });

  test("critic turn guards include incomplete critic turns durably spent before resume", async () => {
    const broken = createMockModel({ id: "critic-broken", responses: [
      { content: ["no structured call"] },
      { throw: "getaddrinfo ENOTFOUND critic.invalid" },
    ] as never });
    const s = setup();
    s.deps.modelsOn = () => ({ model: broken as never, ref: "other/critic-broken" });
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed" });
    expect(broken.calls).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "turn" && event.phase === "form" && event.role === "critic")).toHaveLength(2);
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", failureClass: "budget", message: expect.stringContaining("turn cap") });
    expect(broken.calls).toHaveLength(2);
  });

  test("a stale approval receipt cannot bless project files changed after critique", async () => {
    const s = setup();
    s.deps.onApprovalStep = () => { throw new Error("approval-crash"); };
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", message: "approval-crash" });
    const held = JSON.parse(readFileSync(s.paths.featuresMirror, "utf8")) as FeaturesFile;
    held.features[0]!.description = "changed after approval";
    writeFileSync(s.paths.featuresMirror, JSON.stringify(held));
    s.deps.onApprovalStep = undefined;
    s.deps.models = () => { throw new Error("form brain must not rerun"); };
    s.deps.modelsOn = () => { throw new Error("critic must not rerun"); };
    expect(await runForm(s.deps)).toMatchObject({
      outcome: "failed", failureClass: "integrity", message: expect.stringContaining("featuresHash"),
    });
    expect(existsSync(s.run.features)).toBe(false);
    expect(existsSync(s.run.acceptanceLock)).toBe(false);
    expect(s.git.commits).toHaveLength(0);
  });

  test("cancellation after critic approval is resumable without repeating approval", async () => {
    const s = setup(); const control = new RunControl();
    s.deps.onApprovalStep = () => { control.cancel("pause after approval"); };
    await expect(withRunControl(control, () => runForm(s.deps))).rejects.toBeInstanceOf(RunCancelledError);
    expect(existsSync(formationApprovalPath(s.deps))).toBe(true);
    const brainCalls = s.brain.calls.length;
    const critiqueCalls = s.record.read().filter((event) => event.t === "critique").length;

    s.deps.onApprovalStep = undefined;
    s.deps.models = () => { throw new Error("form brain must not rerun"); };
    s.deps.modelsOn = () => { throw new Error("critic must not rerun"); };
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(s.brain.calls).toHaveLength(brainCalls);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(critiqueCalls);
  });

  test("explicit idea wins and controlled cleanup precedes marker replacement without deleting unrelated state", async () => {
    const s = setup({ chosen: "idea-a", criticVerdicts: ["ok", "revise"] });
    const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" });
    for (const path of [project.spec, project.featuresMirror, project.initSh, project.lockMirror, s.run.features, s.run.acceptanceLock]) writeFileSync(path, "old generated");
    writeFileSync(s.run.featureState, "");
    mkdirSync(project.repo); mkdirSync(project.checksDir); mkdirSync(project.blockedDir);
    writeFileSync(join(project.repo, "sentinel"), "repo survives"); writeFileSync(join(project.checksDir, "sentinel"), "checks survive");
    const result = await runForm(s.deps, "idea-b");
    expect(result).toMatchObject({ outcome: "honest_exit", kind: "not_formable" });
    expect(readProjectMarker(project.dir)).toMatchObject({ runId: s.run.id, ideaId: "idea-b" });
    expect(readFileSync(join(project.repo, "sentinel"), "utf8")).toBe("repo survives");
    expect(readFileSync(join(project.checksDir, "sentinel"), "utf8")).toBe("checks survive");
    expect(existsSync(s.run.acceptanceLock)).toBe(false);
    expect(existsSync(s.run.featureState)).toBe(true);
    expect(readFileSync(s.run.featureState, "utf8")).toBe("");
  });

  test("forced explicit relocation cleans a differently-owned target before replacing its marker", async () => {
    const s = setup({ chosen: "idea-a", criticVerdicts: ["ok", "revise"] });
    const oldTarget = mkdtempSync(join(tmpdir(), "kiln-old-target-"));
    materializeProjectPath(s.run, oldTarget, { ideaId: "idea-a" });
    writeFileSync(join(oldTarget, "old-sentinel"), "old survives");
    const target = mkdtempSync(join(tmpdir(), "kiln-forced-target-")); const targetPaths = projectPaths(target);
    writeProjectMarker(target, { runId: "other-run", ideaId: "other-idea", kilnVersion: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" });
    for (const path of [targetPaths.spec, targetPaths.featuresMirror, targetPaths.initSh, targetPaths.lockMirror]) writeFileSync(path, "valid stale output");
    writeFileSync(join(target, "sentinel"), "preserve");
    writeFileSync(s.run.features, JSON.stringify(features(true))); writeFileSync(s.run.acceptanceLock, "stale lock"); writeFileSync(s.run.featureState, "");

    const result = await runForm(s.deps, "idea-b", { out: target, force: true });
    expect(result).toMatchObject({ outcome: "honest_exit", kind: "not_formable" });
    expect(readProjectMarker(target)).toMatchObject({ runId: s.run.id, ideaId: "idea-b" });
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("preserve");
    expect(readFileSync(join(oldTarget, "old-sentinel"), "utf8")).toBe("old survives");
    expect(readFileSync(targetPaths.spec, "utf8")).toBe(SPEC);
    expect(s.brain.calls.length).toBeGreaterThan(2);
    expect(existsSync(s.run.acceptanceLock)).toBe(false);
  });

  test("nonempty durable state refuses re-form before cleanup or marker replacement", async () => {
    const s = setup({ chosen: "idea-a" }); const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" });
    writeFileSync(project.spec, "old spec"); writeFileSync(s.run.featureState, "{\"featureId\":\"f01\"}\n");
    const result = await runForm(s.deps, "idea-b", { force: true });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(readProjectMarker(project.dir)).toMatchObject({ ideaId: "idea-a" });
    expect(readFileSync(project.spec, "utf8")).toBe("old spec");
    expect(readFileSync(s.run.featureState, "utf8")).toContain("f01");
    expect(s.record.read().findLast((event) => event.t === "failure")).toMatchObject({ class: "integrity", message: expect.stringContaining("state.jsonl") });
  });

  test("shape mismatch fails before phase.start or project materialization", async () => {
    const s = setup(); writeFileSync(s.run.brief, BRIEF.replace("- buyer: solo | team | enterprise", "- buyer: person | team | enterprise"));
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(existsSync(s.run.project)).toBe(false);
    expect(s.record.read().some((event) => event.t === "phase.start" && event.phase === "form")).toBe(false);
  });

  test("the shared ledger lets the form brain finish but stops on either critic crossing", async () => {
    const expensiveCost = { input: 10_000, output: 10_000, cacheRead: 0, cacheWrite: 0 } as never;
    for (const crossing of ["first", "second"] as const) {
      const high = critic(["ok"], expensiveCost, true); const low = critic(["ok"]);
      const s = setup({ criticModels: crossing === "first" ? [high] : [low, high] });
      const result = await runForm(s.deps);
      expect(result).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: s.deps.cfg.budgets.usd });
      expect(readStatus(s.run)).toMatchObject({ state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: s.deps.cfg.budgets.usd } });
      expect(existsSync(s.paths.repo)).toBe(false);
      expect(high.calls).toHaveLength(1);
      expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(crossing === "first" ? 1 : 2);
    }
  });

  test("a structurally complete saved bundle can borrow bounded repair headroom without raising the run total", async () => {
    const s = setup();
    s.deps.cfg.budgets.usd = 8;
    Object.assign(s.deps.cfg.budgets.share, { frame: 0.05, discover: 0, ideate: 0, form: 0.2, build: 0.7, reflect: 0.05 });
    const project = materializeProjectPath(s.run, undefined, { ideaId: "idea-a" });
    writeFileSync(project.spec, SPEC.replace("A user runs the command and sees a result.", "x".repeat(601)));
    writeFileSync(project.featuresMirror, JSON.stringify(features(false)));
    writeFileSync(project.initSh, "#!/bin/sh\nexit 0\n");
    const call = (costUsd: number) => s.record.append({
      t: "model.call", role: "brain", provider: "p", model: "m", inputHash: `prior-${costUsd}`,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd, stopReason: "stop", excerpt: "",
    });
    s.record.append({ t: "phase.start", phase: "frame" }); call(0.3); s.record.append({ t: "phase.end", phase: "frame", outcome: "ok" });
    s.record.append({ t: "phase.start", phase: "form" }); call(1.8); s.record.append({ t: "phase.end", phase: "form", outcome: "failed" });

    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(s.deps.cfg.budgets.usd).toBe(8);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
  });

  test("resumes a valid partial revision in place and targets only critic-implicated unchanged artifacts", async () => {
    const firstCritic = createMockModel({ id: "first-critic", responses: [{ content: [{
      type: "toolCall", name: "critique", arguments: {
        scopeCreep: [], unverifiable: [], verdict: "revise",
        missing: [{ featureId: "f03", text: "The specification and README acceptance check disagree." }],
      },
    }] }] as never });
    const s = setup({ criticModels: [firstCritic, critic(["ok"])] });
    s.deps.cfg.budgets.usd = 8;
    Object.assign(s.deps.cfg.budgets.share, { frame: 0.05, discover: 0, ideate: 0, form: 0.2, build: 0.7, reflect: 0.05 });
    s.deps.onFormStage = (stage) => { if (stage === "first_critique") throw new Error("interrupt-before-revision"); };
    expect(await runForm(s.deps)).toMatchObject({ outcome: "failed", message: "interrupt-before-revision" });

    s.record.append({ t: "formation.revision", ideaId: "idea-a", attempt: 1 });
    writeFileSync(s.paths.spec, SPEC.replace("A local command.", "A small local command."));
    s.record.append({
      t: "model.call", role: "brain", provider: "p", model: "prior", inputHash: "prior-form-spend",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 4.2, stopReason: "stop", excerpt: "",
    });
    writeStatus(s.run, { phase: "form", state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: 8 } });
    let revisionPrompt = "";
    const completing = createMockModel({ id: "completion", handler: (ctx: any) => {
      revisionPrompt = lastUser(ctx);
      const changed = structuredClone(features(true) as FeaturesFile);
      changed.features[2]!.description = "Deliver the README contract exactly.";
      return { content: [writeCall(s.paths.featuresMirror, JSON.stringify(changed))] };
    } } as never);
    s.deps.models = () => ({ model: completing as never, ref: "producer/completion" });
    s.deps.onFormStage = undefined;

    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(completing.calls).toHaveLength(1);
    expect(revisionPrompt).toContain("Resume the interrupted revision");
    expect(revisionPrompt).toContain(s.paths.featuresMirror);
    expect(readFileSync(s.paths.spec, "utf8")).toContain("A small local command.");
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
  });

  test("a larger formation budget advances autonomously to the next value-ladder idea", async () => {
    const s = setup({ criticVerdicts: ["ok", "revise", "ok", "ok"] });
    s.deps.cfg.budgets.usd = 50; s.deps.cfg.autonomous = true;
    const ids = ["idea-a", "idea-b"];
    writeFileSync(s.run.frontier, JSON.stringify({
      version: 1, mode: "loop", round: 1, rawFront: ids, shown: ids, eligible: ids,
      ideas: ids.map((id) => ({ id, backfill: false, cell: id })), ladders: { value: ids, feasibility: [...ids].reverse() },
      searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true,
    }));
    for (const id of ids) writeFileSync(join(s.run.renderedDir, `${id}-r1.md`), `# ${id}\n`);
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(readStatus(s.run)).toMatchObject({ phase: "build", state: "running", chosenIdeaId: "idea-b" });
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(4);
    expect(s.record.read().filter((event) => event.t === "formation.attempt").map((event) => event.t === "formation.attempt" ? event.attempt : 0)).toEqual([1, 2]);
    expect(s.record.read().filter((event) => event.t === "formation.revision")).toHaveLength(2);
    expect(s.record.read().filter((event) => event.t === "phase.start" && event.phase === "form")).toHaveLength(1);
  });

  test("returning to an older idea starts a new attempt and cannot reuse its old critiques", async () => {
    const s = setup({ criticVerdicts: ["ok", "revise", "ok", "ok", "ok", "ok"] });
    s.deps.cfg.budgets.usd = 50; s.deps.cfg.autonomous = true;
    const ids = ["idea-a", "idea-b"];
    writeFileSync(s.run.frontier, JSON.stringify({
      version: 1, mode: "loop", round: 1, rawFront: ids, shown: ids, eligible: ids,
      ideas: ids.map((id) => ({ id, backfill: false, cell: id })), ladders: { value: ids, feasibility: [...ids].reverse() },
      searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true,
    }));
    for (const id of ids) writeFileSync(join(s.run.renderedDir, `${id}-r1.md`), `# ${id}\n`);
    expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
    expect(await runForm(s.deps, "idea-a", { force: true })).toEqual({ outcome: "ok" });
    expect(s.record.read().filter((event) => event.t === "formation.attempt").map((event) => event.t === "formation.attempt" ? event.attempt : 0)).toEqual([1, 2, 3]);
    expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(6);
  });

  test("runForm resumes every freeze crash without another critic, commit, or matching event", async () => {
    for (let crashAfter = 1; crashAfter <= 6; crashAfter += 1) {
      const s = setup(); s.deps.onFreezeStep = (step) => { if (step === crashAfter) throw new Error(`freeze-crash-${step}`); };
      expect(await runForm(s.deps)).toMatchObject({ outcome: "failed" });
      expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
      expect(s.record.read().filter((event) => event.t === "formation.attempt")).toHaveLength(1);
      expect(s.record.read().filter((event) => event.t === "formation.revision")).toHaveLength(1);
      s.deps.onFreezeStep = undefined;
      expect(await runForm(s.deps)).toEqual({ outcome: "ok" });
      expect(s.record.read().filter((event) => event.t === "critique")).toHaveLength(2);
      expect(s.record.read().filter((event) => event.t === "formation.attempt")).toHaveLength(1);
      expect(s.record.read().filter((event) => event.t === "formation.revision")).toHaveLength(1);
      expect(s.git.commits).toHaveLength(1);
      expect(s.record.read().filter((event) => event.t === "freeze")).toHaveLength(1);
    }
  });
});
