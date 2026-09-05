#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { RealGitRunner } from "../../src/build/git";
import { foldState } from "../../src/build/state";
import { main, type CliDeps } from "../../src/cli/main";
import { defaultConfig, saveConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { hashInput, RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus, type RunStatus } from "../../src/core/run";
import { freeze } from "../../src/formation/freeze";
import type { FeaturesFile } from "../../src/formation/features";
import { materializeProjectPath } from "../../src/formation/paths";
import { parseBrief } from "../../src/phases/frame";
import type { PhaseDeps } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";

export type AutonomyUseCase = "utility-crash-recovery" | "check-failure-repair";

export interface AutonomyUseCaseResult {
  name: AutonomyUseCase;
  providerMode: "mocked-models-only";
  root: string;
  home: string;
  runId: string;
  projectDir: string;
  firstExitCode?: number;
  exitCode: number;
  status: RunStatus;
  artifactOutput: string;
  builderSessions: number;
  builderModelCalls: number;
  builderModelCallsAfterResume: number;
  acceptanceChecks: boolean[];
  crossProviderAudits: number;
  featureCommits: string[];
  attemptDispositions: string[];
  events: string[];
}

export interface AutonomyUseCaseOptions { root?: string }

type ModelContext = {
  messages?: Array<{ role?: string; content?: unknown }>;
};

const BRIEF = `# Brief

## Problem
A developer needs a small, dependable local command-line utility.

## Constraints
- no network access
- no third-party runtime packages

## Search success
- the result is directly executable

## Non-goals
- hosted deployment

## Shape
product

## Axes
- audience: developer | operator | researcher
- interface: cli | library | service
- value: speed | reliability | portability

## Discovery questions
- What behavior can a shell check prove?
- What failure should recovery preserve?
`;

function specFor(milestone: string): string {
  return `# Spec

## What
A dependency-free local command-line utility.

## For whom
Developers and operators.

## Why now
The behavior can be verified locally.

## Scope
- one executable utility
- one deterministic interface

## Non-goals
- network access
- package publication

## Risks
Edge-case input may expose an implementation mistake.

## First milestone
${milestone}
`;
}

function writeCall(path: string, content: string) {
  return { type: "toolCall", name: "write", arguments: { path, content } };
}

function lastRole(context: ModelContext): string | undefined {
  return context.messages?.at(-1)?.role;
}

function prepareRoot(name: AutonomyUseCase, requested?: string): string {
  if (!requested) return mkdtempSync(join(tmpdir(), `kiln-${name}-`));
  const root = resolve(requested);
  mkdirSync(root, { recursive: true });
  if (existsSync(join(root, ".kiln"))) throw new Error(`use-case root already contains .kiln: ${root}`);
  return root;
}

async function prepareRun(root: string, features: FeaturesFile, milestone: string) {
  const home = join(root, ".kiln");
  initHome(home);
  const cfg = defaultConfig();
  cfg.autonomous = true;
  cfg.build.minFeatures = features.features.length;
  cfg.build.maxFeatures = features.features.length;
  cfg.build.expectedCheckSeconds = 1;
  cfg.build.expectedInitSeconds = 1;
  saveConfig(home, cfg);

  const run = createRun(home, milestone, { id: "autonomy-demo" });
  const project = materializeProjectPath(run, undefined, { ideaId: "autonomy-demo" });
  const spec = specFor(milestone);
  writeFileSync(run.brief, BRIEF);
  writeFileSync(project.spec, spec);
  writeFileSync(project.initSh, "#!/bin/sh\nset -eu\n");
  const record = new RunRecord(run.record);
  const unused = createMockModel({ id: "fixture-setup", provider: "mock-setup", responses: [{ content: ["unused"] }] } as never);
  const deps: PhaseDeps = {
    home, run, record, cfg,
    models: () => ({ model: unused as never, ref: "mock-setup/fixture-setup" }),
    apiKeyFor: async () => "provider-free-fixture",
    effort: "medium",
    limiter: new Limiter(1),
  };
  await freeze(deps, features, hashInput(spec), new RealGitRunner());
  const brief = parseBrief(BRIEF);
  writeStatus(run, {
    phase: "build", state: "running", outcome: undefined,
    shape: "product", shapeHash: shapeHash(brief), specHash: hashInput(spec), projectDir: project.dir,
  });
  return { home, run, project };
}

function summarizeEvent(event: ReturnType<RunRecord["read"]>[number]): string | undefined {
  if (event.t === "tool.call") return `tool.call:${event.name}`;
  if (event.t === "check") return `check:${event.phase}:${event.ok ? "pass" : "fail"}`;
  if (event.t === "attempt") return `attempt:${event.disposition}`;
  if (event.t === "phase.end") return `phase.end:${event.phase}:${event.outcome}`;
  return undefined;
}

function harnessModels(builder: Model): Pick<CliDeps, "models" | "streamFn" | "apiKeyFor" | "fetchUsage"> {
  const auditor = createMockModel({ id: "fixture-auditor", provider: "mock-reviewer", handler: (context: ModelContext) => {
    const failed = JSON.stringify(context).includes("passed: false");
    return failed
      ? { content: [{ type: "toolCall", name: "audit", arguments: { regressions: ["The executable acceptance check failed."], nextSessionNotes: "Repair the behavior named by the check output." } }] }
      : { content: [{ type: "toolCall", name: "audit", arguments: {
        verified: ["The detached snapshot passes the executable acceptance check."],
        claimedUnverified: [], regressions: [], nextSessionNotes: "No repair needed.",
        checkQuality: { adequate: true, reason: "The shell command directly exercises the utility." }, verdict: "agree",
      } }] };
  } } as never);
  const reflector = createMockModel({
    id: "fixture-reflector", provider: "mock-producer",
    responses: [{ content: ["The run confirms existing recovery guidance; no new playbook delta is warranted."] }] as never,
  });
  const models = { builder, auditor, reflector } as Partial<Record<Role, Model>>;
  return {
    models,
    streamFn: streamMock as never,
    apiKeyFor: async (provider) => provider.startsWith("mock-") ? "provider-free-fixture" : undefined,
    fetchUsage: async () => undefined,
  };
}

function finishResult(
  name: AutonomyUseCase,
  root: string,
  home: string,
  run: Awaited<ReturnType<typeof prepareRun>>["run"],
  projectDir: string,
  exitCode: number,
  builderModelCalls: number,
  builderModelCallsAfterResume: number,
  artifactOutput: string,
  firstExitCode?: number,
): AutonomyUseCaseResult {
  const record = new RunRecord(run.record);
  const events = record.read();
  return {
    name, providerMode: "mocked-models-only", root, home, runId: run.id, projectDir,
    ...(firstExitCode === undefined ? {} : { firstExitCode }), exitCode, status: readStatus(run), artifactOutput,
    builderSessions: events.filter((event) => event.t === "builder.session").length,
    builderModelCalls, builderModelCallsAfterResume,
    acceptanceChecks: events.flatMap((event) => event.t === "check" && event.phase === "acceptance" ? [event.ok] : []),
    crossProviderAudits: events.filter((event) => event.t === "audit" && event.crossProvider).length,
    featureCommits: events.flatMap((event) => event.t === "commit" ? [event.sha] : []),
    attemptDispositions: events.flatMap((event) => event.t === "attempt" ? [event.disposition] : []),
    events: events.flatMap((event) => summarizeEvent(event) ?? []),
  };
}

async function utilityCrashRecovery(options: AutonomyUseCaseOptions): Promise<AutonomyUseCaseResult> {
  const name = "utility-crash-recovery" as const;
  const root = prepareRoot(name, options.root);
  const features: FeaturesFile = { version: 1, init: { needs: ["node"] }, features: [{
    id: "f01",
    title: "Build a Unicode-aware slug command",
    description: "Create slugify.mjs. It must normalize accents, lowercase text, collapse non-alphanumeric runs to hyphens, and trim boundary hyphens.",
    acceptance: { type: "shell", command: "test \"$(node slugify.mjs 'Crème brûlée for Kiln!')\" = \"creme-brulee-for-kiln\"", needs: ["node"] },
  }] };
  const prepared = await prepareRun(root, features, "Running slugify.mjs produces a normalized slug and survives an interrupted build commit.");
  let builderModelCalls = 0;
  const source = `const input = process.argv.slice(2).join(" ");\nconst slug = input.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\nconsole.log(slug);\n`;
  const builder = createMockModel({ id: "fixture-builder", provider: "mock-producer", handler: (context: ModelContext) => {
    builderModelCalls += 1;
    return lastRole(context) === "toolResult" ? { content: ["Implementation complete."] } : { content: [writeCall("slugify.mjs", source)] };
  } } as never);
  const deps = harnessModels(builder as never);
  let crashed = false;
  const firstOutput: string[] = [];
  const firstExitCode = await main([
    "project", "build", prepared.run.id, "--home", prepared.home, "--autonomous", "--yes", "--json",
  ], { write: (text) => firstOutput.push(text), error: (text) => firstOutput.push(text) }, {
    ...deps,
    buildDeps: { stepHook: (index) => { if (index === 8 && !crashed) { crashed = true; throw new Error("simulated process interruption"); } } },
  });
  const callsBeforeResume = builderModelCalls;
  const output: string[] = [];
  const exitCode = await main([
    "project", "build", prepared.run.id, "--home", prepared.home, "--autonomous", "--yes", "--json",
  ], { write: (text) => output.push(text), error: (text) => output.push(text) }, deps);
  const executed = spawnSync("node", [join(prepared.project.repo, "slugify.mjs"), "Crème brûlée for Kiln!"], { encoding: "utf8" });
  if (executed.status !== 0) throw new Error(`generated utility failed: ${executed.stderr}`);
  return finishResult(name, root, prepared.home, prepared.run, prepared.project.dir, exitCode,
    builderModelCalls, builderModelCalls - callsBeforeResume, executed.stdout.trim(), firstExitCode);
}

function latestAttempt(context: ModelContext): number {
  const matches = [...JSON.stringify(context).matchAll(/Attempt: (\d+)/g)];
  return Number(matches.at(-1)?.[1] ?? "1");
}

async function checkFailureRepair(options: AutonomyUseCaseOptions): Promise<AutonomyUseCaseResult> {
  const name = "check-failure-repair" as const;
  const root = prepareRoot(name, options.root);
  const features: FeaturesFile = { version: 1, init: { needs: ["node"] }, features: [{
    id: "f01",
    title: "Build a JSONL total command",
    description: "Create summarize.mjs. Read JSON objects from standard input and emit one compact JSON object with their count and exact numeric total.",
    acceptance: {
      type: "shell",
      command: "printf '%s\\n' '{\"amount\":2.5}' '{\"amount\":5}' | node summarize.mjs | grep -Fx '{\"count\":2,\"total\":7.5}'",
      needs: ["node", "grep"],
    },
  }] };
  const prepared = await prepareRun(root, features, "summarize.mjs totals decimal JSONL input after repairing a failed executable check.");
  let builderModelCalls = 0;
  const common = `let input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst rows = input.trim().split(/\\n+/).filter(Boolean).map((line) => JSON.parse(line));\n`;
  const broken = `${common}const total = rows.reduce((sum, row) => sum + parseInt(String(row.amount), 10), 0);\nconsole.log(JSON.stringify({ count: rows.length, total }));\n`;
  const repaired = `${common}const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);\nconsole.log(JSON.stringify({ count: rows.length, total }));\n`;
  const builder = createMockModel({ id: "fixture-builder", provider: "mock-producer", handler: (context: ModelContext) => {
    builderModelCalls += 1;
    if (lastRole(context) === "toolResult") return { content: ["Implementation complete."] };
    return { content: [writeCall("summarize.mjs", latestAttempt(context) === 1 ? broken : repaired)] };
  } } as never);
  const deps = harnessModels(builder as never);
  const output: string[] = [];
  const exitCode = await main([
    "project", "build", prepared.run.id, "--home", prepared.home, "--autonomous", "--yes", "--json",
  ], { write: (text) => output.push(text), error: (text) => output.push(text) }, deps);
  const input = '{"amount":2.5}\n{"amount":5}\n';
  const executed = spawnSync("node", [join(prepared.project.repo, "summarize.mjs")], { input, encoding: "utf8" });
  if (executed.status !== 0) throw new Error(`generated utility failed: ${executed.stderr}`);
  return finishResult(name, root, prepared.home, prepared.run, prepared.project.dir, exitCode,
    builderModelCalls, 0, executed.stdout.trim());
}

export async function runAutonomyUseCase(name: AutonomyUseCase, options: AutonomyUseCaseOptions = {}): Promise<AutonomyUseCaseResult> {
  if (name === "utility-crash-recovery") return utilityCrashRecovery(options);
  if (name === "check-failure-repair") return checkFailureRepair(options);
  throw new Error(`unknown autonomy use case: ${String(name)}`);
}

async function cli(): Promise<void> {
  const requested = process.argv[2] as AutonomyUseCase | "all" | undefined;
  const names: AutonomyUseCase[] = !requested || requested === "all"
    ? ["utility-crash-recovery", "check-failure-repair"]
    : [requested];
  const results: AutonomyUseCaseResult[] = [];
  for (const name of names) results.push(await runAutonomyUseCase(name));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
}

if (import.meta.main) await cli();
