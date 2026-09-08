#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { runAutonomyUseCase } from "./usecases/autonomous-tooling";
import { main, type CliDeps } from "../src/cli/main";
import { defaultConfig, saveConfig, type Role } from "../src/core/config";
import { initHome } from "../src/core/home";
import { RunRecord } from "../src/core/record";
import { readStatus, runPaths, type RunPaths, type RunStatus } from "../src/core/run";
import { pauseCommand } from "../src/cli/commands/pause";

export const STRESS_SCENARIOS = [
  "literature-ideation",
  "business-ideation",
  "broad-ambiguous-seed",
  "invalid-output-correction",
  "empty-model-output",
  "dns-resume",
  "rate-limit-resume",
  "provider-refusal",
  "pause-resume",
  "plug-and-play-delivery",
  "utility-delivery",
  "utility-repair",
] as const;

export type StressScenario = (typeof STRESS_SCENARIOS)[number];

export interface StressResult {
  scenario: StressScenario;
  providerMode: "mocked-models-only";
  ok: boolean;
  root: string;
  home: string;
  runId: string;
  exitCodes: number[];
  status: RunStatus;
  workflow?: unknown;
  tools: string[];
  searchHealth: string[];
  phaseEnds: string[];
  modelCalls: number;
  detail: Record<string, unknown>;
}

type Context = {
  systemPrompt?: string[];
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string }>;
};

const RESEARCH_BRIEF = `# Brief

## Problem
Find a differentiated, literature-grounded direction for improving fluorescent-protein measurement workflows without proposing wet-lab procedures.

## Constraints
- literature and computational analysis only
- no protein sequences, clinical claims, or operational laboratory instructions
- consequential factual claims require opened sources

## Search success
- a distinct mechanism with a falsifiable computational or literature validation step
- explicit separation of evidence, inference, and hypothesis

## Non-goals
- promising experimental success
- designing a biological sequence

## Shape
research

## Axes
- user: imaging researcher | assay analyst | tool builder
- mechanism: retrieval | calibration | simulation
- evidence: benchmark | primary literature | negative result

## Discovery questions
- Which primary sources establish the current measurement limits?
- Which computational validation methods expose the largest unresolved uncertainty?
`;

const BUSINESS_BRIEF = `# Brief

## Problem
Find a capital-efficient business opportunity for independent repair shops.

## Constraints
- prototype must be testable without paid data
- make market assumptions explicit

## Search success
- an observable workflow improvement
- a buyer and a measurable willingness-to-pay test

## Non-goals
- guaranteed revenue or valuation
- an unbounded marketplace launch

## Shape
product

## Axes
- buyer: owner | technician | parts coordinator
- mechanism: scheduling | diagnostics | procurement
- value: time | utilization | margin

## Discovery questions
- Which recurring shop workflows cause measurable delays?
- Which existing products already address those workflows?
`;

const BROAD_BRIEF = `# Brief

## Problem
Search for a high-upside business direction while treating wealth as an aspiration rather than a promise.

## Constraints
- assume one technical founder and a small validation budget
- assumptions are reversible and are not facts about the requester

## Search success
- a painful problem with a reachable buyer
- a cheap test of demand and delivery feasibility

## Non-goals
- guaranteeing wealth
- claiming a market is empty from a failed search

## Shape
product

## Axes
- buyer: individual | small business | enterprise
- mechanism: workflow | marketplace | infrastructure
- value: time | revenue | risk

## Discovery questions
- Which expensive recurring workflows remain poorly served?
- What evidence would quickly falsify demand?
`;

const DELIVERY_BRIEF = `# Brief

## Problem
Create a deterministic local command-line utility that normalizes arbitrary text into a slug.

## Constraints
- no network access or third-party runtime packages
- preserve Unicode letters through accent normalization

## Search success
- the command produces the expected slug for accented and punctuated input
- acceptance is checked by executing the generated artifact

## Non-goals
- package publication
- unrelated product ideation

## Shape
product

## Axes
- user: developer | operator | researcher
- interface: command | library | pipeline
- value: portability | reliability | speed

## Discovery questions
- Which observable edge cases distinguish correct normalization?
- Which local command can prove the required behavior?
`;

const LANDSCAPE = `# Landscape

## Obvious list
- generic assistant
- dashboard
- search portal
- marketplace
- report generator

## Atoms
- source provenance (common)
- evidence freshness (common)
- negative-results registry (rare)
- workflow handoff (common)
- structured uncertainty (rare)
- buyer trigger (common)
- switching cost (common)
- audit trail (common)
- retrieval coverage (common)
- calibration curve (rare)
- counterexample search (rare)
- time-to-answer (common)
- baseline comparison (common)
- local-first storage (rare)
- approval boundary (common)
- reproducible snapshot (rare)
- query expansion (common)
- failure classification (rare)
- cohort segmentation (common)
- reversible assumption (rare)

## Tensions
- breadth conflicts with verification depth
- speed conflicts with source inspection
- novelty claims weaken when search coverage is poor

## Distant domains
- fault-tolerant distributed systems
- insurance underwriting
- compiler optimization
`;

const INVALID_BRIEF = `# Brief

## Problem
An invalid first attempt.

## Shape
unknown

## Axes
- audience
`;

const DELIVERY_SPEC = `# Spec

## What
A dependency-free command-line utility that emits a normalized slug.

## For whom
Developers who need deterministic local text normalization.

## Why now
The behavior can be verified with one executable command.

## Scope
- one Node.js command
- Unicode accent normalization

## Non-goals
- network access
- package publication

## Risks
Punctuation and accents can expose normalization mistakes.

## First milestone
Running slugify.mjs on accented input emits the expected normalized slug.
`;

function deliveryFeatures(frozen: boolean): string {
  return JSON.stringify({
    version: 1,
    init: { needs: ["node"] },
    features: [{
      ...(frozen ? { id: "f01" } : {}),
      title: "Build the slug command",
      description: "Create slugify.mjs with Unicode accent normalization, lowercase output, collapsed separators, and trimmed boundaries.",
      acceptance: { type: "shell", command: "test \"$(node slugify.mjs 'Crème brûlée for Kiln!')\" = \"creme-brulee-for-kiln\"", needs: ["node"] },
    }],
  });
}

function ideaBatch(prefix: string, sourceKind: "scholar" | "web", broad = false): string {
  return Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return `# Idea ${n}

## Title
${prefix} ${n}

## Mechanism
Combine a verified input snapshot with mechanism ${n} and report uncertainty separately.

## Draws on
source provenance and counterexample search

## Axes
${sourceKind === "scholar"
  ? `- user: ${["imaging researcher", "assay analyst", "tool builder"][n % 3]}\n- mechanism: ${["retrieval", "calibration", "simulation"][n % 3]}\n- evidence: ${["benchmark", "primary literature", "negative result"][n % 3]}`
  : broad
    ? `- buyer: ${["individual", "small business", "enterprise"][n % 3]}\n- mechanism: ${["workflow", "marketplace", "infrastructure"][n % 3]}\n- value: ${["time", "revenue", "risk"][n % 3]}`
    : `- buyer: ${["owner", "technician", "parts coordinator"][n % 3]}\n- mechanism: ${["scheduling", "diagnostics", "procurement"][n % 3]}\n- value: ${["time", "utilization", "margin"][n % 3]}`}

## Testable claim
A blinded fixture comparison can measure whether mechanism ${n} improves the target outcome.

## Cheapest test
Run a deterministic fixture against the baseline and record failures.

## Strongest failure reason
The apparent improvement may disappear on unseen fixtures.

## Probability
${10 + n}%
`;
  }).join("\n");
}

function lastUser(context: Context): string {
  const content = [...(context.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "object" && part && "text" in part
    ? String((part as { text: unknown }).text) : "").join("\n");
}

function allText(context: Context): string {
  return JSON.stringify(context);
}

function targetPath(context: Context): string {
  return /Output file: (\S+)/.exec((context.systemPrompt ?? []).join("\n"))?.[1] ?? "";
}

function writeCall(path: string, content: string) {
  return { type: "toolCall", name: "write", arguments: { path, content } };
}

function fixtureFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.startsWith("https://api.openalex.org/works")) {
    return Promise.resolve(new Response(JSON.stringify({ results: [{
      id: "https://openalex.org/W-fixture",
      doi: "https://doi.org/10.0000/kiln.fixture",
      display_name: "Fixture primary study",
      publication_year: 2026,
      primary_location: { source: { display_name: "Fixture Journal" } },
      abstract_inverted_index: { verified: [0], measurement: [1], limitation: [2] },
    }] }), { headers: { "content-type": "application/json" } }));
  }
  if (url.startsWith("https://html.duckduckgo.com/html/")) {
    return Promise.resolve(new Response('<a class="result__a" href="https://example.test/repair-workflow">Repair workflow study</a><a class="result__snippet">Observed scheduling delays.</a>', { headers: { "content-type": "text/html" } }));
  }
  return Promise.resolve(new Response("fixture source body", { headers: { "content-type": "text/plain" } }));
}

function configureHome(root: string): string {
  mkdirSync(root, { recursive: true });
  const home = join(root, ".kiln");
  initHome(home);
  const cfg = defaultConfig();
  cfg.autonomous = true;
  cfg.ideation.rounds = 1;
  cfg.ideation.islands = 1;
  cfg.ideation.cheapIsland = false;
  cfg.ideation.entrantsCap = 5;
  cfg.ideation.anchorsCap = 2;
  cfg.ideation.pairCap = 10;
  cfg.ideation.minComparisons = 3;
  cfg.ideation.bootstrapSamples = 20;
  cfg.ideation.concurrency = 2;
  cfg.build.minFeatures = 1;
  cfg.build.maxFeatures = 1;
  saveConfig(home, cfg);
  return home;
}

function scenarioRoot(scenario: StressScenario, root?: string): string {
  if (root) return resolve(root);
  return mkdtempSync(join(tmpdir(), `kiln-stress-${scenario}-`));
}

function newestRun(home: string): RunPaths {
  const ids = readdirSync(join(home, "runs")).sort();
  const id = ids.at(-1);
  if (!id) throw new Error(`scenario did not create a run in ${home}`);
  return runPaths(home, id);
}

function evidenceModels(brief: string, sourceKind: "scholar" | "web" = "web", broad = false): { deps: CliDeps; calls: { brain: number; scout: number } } {
  const calls = { brain: 0, scout: 0 };
  const brain = createMockModel({ id: "stress-brain", provider: "mock-producer", handler: (context: Context) => {
    calls.brain += 1;
    const target = targetPath(context);
    if (target.endsWith("brief.md") && !existsSync(target)) return { content: [writeCall(target, brief)] };
    if (target.endsWith("landscape.md") && !existsSync(target)) return { content: [writeCall(target, LANDSCAPE)] };
    return { content: ["No executable probe is warranted for this provider-free fixture."] };
  } } as never);
  const scout = createMockModel({ id: "stress-scout", provider: "mock-research", handler: (context: Context) => {
    calls.scout += 1;
    if (context.messages?.at(-1)?.role === "toolResult") {
      return { content: [sourceKind === "scholar"
        ? "The opened fixture study reports a verified measurement limitation (https://doi.org/10.0000/kiln.fixture)."
        : "The opened fixture source reports scheduling delays (https://example.test/repair-workflow)."] };
    }
    return { content: [{ type: "toolCall", name: sourceKind === "scholar" ? "scholar_search" : "web_search", arguments: {
      query: sourceKind === "scholar" ? "fluorescent protein measurement limitation" : "independent repair shop workflow delays",
      maxResults: 2,
    } }] };
  } } as never);
  const generator = createMockModel({ id: "stress-generator", provider: "mock-producer", handler: () => ({ content: [ideaBatch(sourceKind === "scholar" ? "Research direction" : "Business direction", sourceKind, broad)] }) } as never);
  const prober = createMockModel({ id: "stress-prober", provider: "mock-producer", responses: [{ content: ["unused"] }] as never });
  const arbiter = createMockModel({ id: "stress-arbiter", provider: "mock-reviewer", handler: (context: Context) => allText(context).includes('"name":"axis_map"')
    ? { content: [{ type: "toolCall", name: "axis_map", arguments: { value: "individual", reason: "closest fixture cell" } }] }
    : allText(context).includes('"name":"novelty"')
      ? { content: [{ type: "toolCall", name: "novelty", arguments: { restatement: false, reason: "distinct mechanism" } }] }
      : { content: [{ type: "toolCall", name: "collision", arguments: { same: false, reason: "no matching mechanism in opened results" } }] } } as never);
  const judge = createMockModel({ id: "stress-judge", provider: "mock-reviewer", handler: (context: Context) => {
    if ((context.tools ?? []).some((tool) => tool.name === "verdict")) return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "B", reason: "fixture tradeoff" } }] };
    return { content: [lastUser(context).includes("Losing reasons") ? "Retain falsifiable mechanisms." : "Prefer opened evidence and cheap tests."] };
  } } as never);
  const models = { brain, scout, generator, prober, arbiter, judge, builder: brain, auditor: judge, critic: judge, reflector: brain } as Record<Role, Model>;
  return {
    calls,
    deps: {
      models,
      streamFn: streamMock as never,
      apiKeyFor: async (provider) => provider.startsWith("mock-") ? "provider-free-stress" : undefined,
      fetchImpl: fixtureFetch as unknown as typeof fetch,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    },
  };
}

async function invoke(home: string, args: string[], deps: CliDeps): Promise<{ code: number; output: string }> {
  const output: string[] = [];
  const code = await main([...args, "--home", home, "--json"], {
    write: (text) => output.push(text),
    error: (text) => output.push(text),
  }, deps);
  return { code, output: output.join("") };
}

function resultFromRun(scenario: StressScenario, root: string, home: string, run: RunPaths, exitCodes: number[], detail: Record<string, unknown> = {}): StressResult {
  const events = new RunRecord(run.record).read();
  const status = readStatus(run);
  const workflow = existsSync(join(run.dir, "workflow.json")) ? JSON.parse(readFileSync(join(run.dir, "workflow.json"), "utf8")) : undefined;
  return {
    scenario,
    providerMode: "mocked-models-only",
    ok: exitCodes.at(-1) === 0 && status.state !== "failed",
    root,
    home,
    runId: run.id,
    exitCodes,
    status,
    workflow,
    tools: events.flatMap((event) => event.t === "tool.call" ? [event.name] : []),
    searchHealth: events.flatMap((event) => event.t === "search.health" ? [event.status] : []),
    phaseEnds: events.flatMap((event) => event.t === "phase.end" ? [`${event.phase}:${event.outcome}`] : []),
    modelCalls: events.filter((event) => event.t === "model.call").length,
    detail,
  };
}

async function ideationScenario(scenario: "literature-ideation" | "business-ideation" | "broad-ambiguous-seed", root?: string): Promise<StressResult> {
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  const research = scenario === "literature-ideation";
  const brief = research ? RESEARCH_BRIEF : scenario === "business-ideation" ? BUSINESS_BRIEF : BROAD_BRIEF;
  const seed = research
    ? "Develop literature-grounded ideas for improving fluorescent-protein measurement analysis without sequences or wet-lab protocols."
    : scenario === "business-ideation"
      ? "Find differentiated business ideas for independent repair shops."
      : "Find an idea that will make me a billionaire and ship it.";
  const harness = evidenceModels(brief, research ? "scholar" : "web", scenario === "broad-ambiguous-seed");
  const invoked = await invoke(home, ["run", "new", seed, "--id", `stress-${scenario}`, "--through", "checkpoint", "--autonomous", "--yes"], harness.deps);
  const run = newestRun(home);
  return resultFromRun(scenario, base, home, run, [invoked.code], {
    frontierIdeas: existsSync(run.frontier) ? JSON.parse(readFileSync(run.frontier, "utf8")).ideas?.length ?? 0 : 0,
    discoveryFiles: readdirSync(run.discoveryDir).length,
    brainCalls: harness.calls.brain,
    scoutCalls: harness.calls.scout,
  });
}

async function invalidCorrection(root?: string): Promise<StressResult> {
  const scenario = "invalid-output-correction" as const;
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  let writes = 0;
  const brain = createMockModel({ id: "invalid-then-valid", provider: "mock-producer", handler: (context: Context) => {
    const target = targetPath(context);
    if (!target.endsWith("brief.md")) return { content: ["done"] };
    if (context.messages?.at(-1)?.role === "toolResult") return { content: ["written"] };
    writes += 1;
    return { content: [writeCall(target, writes === 1 ? INVALID_BRIEF : BUSINESS_BRIEF)] };
  } } as never);
  const invoked = await invoke(home, ["run", "new", "Create a repair-shop scheduling concept", "--id", "stress-invalid-output", "--through", "frame"], {
    brainModel: brain as never,
    streamFn: streamMock as never,
    apiKeyFor: async () => "provider-free-stress",
  });
  const run = newestRun(home);
  return resultFromRun(scenario, base, home, run, [invoked.code], {
    correctionWrites: writes,
    briefValidShape: readStatus(run).shape,
  });
}

async function emptyOutput(root?: string): Promise<StressResult> {
  const scenario = "empty-model-output" as const;
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  const brain = createMockModel({ id: "empty", provider: "mock-producer", handler: () => ({ content: [] }) } as never);
  const invoked = await invoke(home, ["run", "new", "Create a bounded utility concept", "--id", "stress-empty-output", "--through", "frame"], {
    brainModel: brain as never,
    streamFn: streamMock as never,
    apiKeyFor: async () => "provider-free-stress",
  });
  const run = newestRun(home);
  const result = resultFromRun(scenario, base, home, run, [invoked.code], { briefExists: existsSync(run.brief) });
  result.ok = invoked.code === 1 && result.status.state === "failed" && !existsSync(run.brief);
  return result;
}

async function transientResume(scenario: "dns-resume" | "rate-limit-resume", root?: string): Promise<StressResult> {
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  let frameWrites = 0;
  const normal = evidenceModels(BUSINESS_BRIEF, "web");
  const brain = createMockModel({ id: "resume-brain", provider: "mock-producer", handler: (context: Context) => {
    const target = targetPath(context);
    if (target.endsWith("brief.md") && !existsSync(target)) { frameWrites += 1; return { content: [writeCall(target, BUSINESS_BRIEF)] }; }
    if (target.endsWith("landscape.md") && !existsSync(target)) return { content: [writeCall(target, LANDSCAPE)] };
    return { content: ["done"] };
  } } as never);
  const failingScout = createMockModel({ id: "transient-scout", provider: "mock-research", handler: () => {
    return scenario === "dns-resume"
      ? { throw: "getaddrinfo ENOTFOUND provider.invalid", responseRequestId: "stress-dns" }
      : { throw: "rate limit", responseStatus: 429, responseHeaders: { "retry-after": "1" }, responseRequestId: "stress-429" };
  } } as never);
  // A fresh healthy scout is installed for the resumed invocation; persisted state, not model
  // object identity, is what this scenario is intended to exercise.
  const firstDeps = { ...normal.deps, models: { ...normal.deps.models, brain, scout: failingScout } };
  const first = await invoke(home, ["run", "new", "Find repair-shop workflow ideas", "--id", `stress-${scenario}`, "--through", "discover", "--autonomous", "--yes"], firstDeps);
  const run = newestRun(home);
  const stopped = readStatus(run);
  const resumedDeps = { ...normal.deps, models: { ...normal.deps.models, brain } };
  const second = await invoke(home, ["run", "resume", run.id, "--through", "discover", "--autonomous", "--yes"], resumedDeps);
  return resultFromRun(scenario, base, home, run, [first.code, second.code], {
    stoppedState: stopped.state,
    stoppedKind: stopped.outcome?.stopKind,
    frameWrites,
  });
}

async function refusal(root?: string): Promise<StressResult> {
  const scenario = "provider-refusal" as const;
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  const brain = createMockModel({ id: "refusal", provider: "mock-producer", handler: () => ({
    content: [], stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" },
  }) } as never);
  const invoked = await invoke(home, ["run", "new", "Create a bounded utility concept", "--id", "stress-provider-refusal", "--through", "frame"], {
    brainModel: brain as never,
    streamFn: streamMock as never,
    apiKeyFor: async () => "provider-free-stress",
  });
  const run = newestRun(home);
  const result = resultFromRun(scenario, base, home, run, [invoked.code], {});
  result.ok = invoked.code === 1 && result.status.outcome?.failureClass === "refusal";
  return result;
}

async function pauseResume(root?: string): Promise<StressResult> {
  const scenario = "pause-resume" as const;
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  let runId = "";
  const slow = createMockModel({ id: "slow", provider: "mock-producer", handler: async (context: Context) => {
    await Bun.sleep(500);
    return { content: [writeCall(targetPath(context), BUSINESS_BRIEF)] };
  } } as never);
  const first = await invoke(home, ["run", "new", "Create a repair-shop scheduling concept", "--id", "stress-pause-resume", "--through", "frame"], {
    brainModel: slow as never,
    streamFn: streamMock as never,
    apiKeyFor: async () => "provider-free-stress",
    onRun: (run) => { runId = run.id; pauseCommand(run.id, { home }, { write: () => {} }); },
  });
  const run = runPaths(home, runId);
  const paused = readStatus(run);
  const healthy = evidenceModels(BUSINESS_BRIEF);
  const second = await invoke(home, ["run", "resume", run.id, "--through", "frame", "--autonomous", "--yes"], healthy.deps);
  return resultFromRun(scenario, base, home, run, [first.code, second.code], {
    pausedState: paused.state,
    pausedReason: paused.pausedReason,
  });
}

async function plugAndPlayDelivery(root?: string): Promise<StressResult> {
  const scenario = "plug-and-play-delivery" as const;
  const base = scenarioRoot(scenario, root);
  const home = configureHome(base);
  const formed: { spec?: string; features?: string; init?: string } = {};
  const producer = createMockModel({ id: "delivery-brain", provider: "mock-producer", handler: (context: Context) => {
    if (context.messages?.at(-1)?.role === "toolResult") return { content: ["done"] };
    const target = targetPath(context);
    if (target.endsWith("brief.md") && !existsSync(target)) return { content: [writeCall(target, DELIVERY_BRIEF)] };
    if (target.endsWith("landscape.md") && !existsSync(target)) return { content: [writeCall(target, LANDSCAPE)] };
    const requested = /^Write (.+) now\.$/m.exec(lastUser(context))?.[1];
    if (requested && basename(requested) === "spec.md") { formed.spec = requested; return { content: [writeCall(requested, DELIVERY_SPEC)] }; }
    if (requested && basename(requested) === "features.json") { formed.features = requested; return { content: [writeCall(requested, deliveryFeatures(false))] }; }
    if (requested && basename(requested) === "init.sh") { formed.init = requested; return { content: [writeCall(requested, "#!/bin/sh\nset -eu\n")] }; }
    if (lastUser(context).includes("Revise the complete formed project")) {
      if (!formed.spec || !formed.features || !formed.init) throw new Error("formation paths were not captured");
      return { content: [writeCall(formed.spec, DELIVERY_SPEC), writeCall(formed.features, deliveryFeatures(true)), writeCall(formed.init, "#!/bin/sh\nset -eu\n")] };
    }
    return { content: ["No executable probe is warranted for this provider-free fixture."] };
  } } as never);
  const scout = createMockModel({ id: "delivery-scout", provider: "mock-research", handler: (context: Context) => context.messages?.at(-1)?.role === "toolResult"
    ? { content: ["The opened fixture source reports a comparable workflow (https://example.test/repair-workflow)."] }
    : { content: [{ type: "toolCall", name: "web_search", arguments: { query: "deterministic slug command", maxResults: 2 } }] } } as never);
  const generator = createMockModel({ id: "delivery-generator", provider: "mock-producer", handler: () => ({ content: [ideaBatch("Slug utility direction", "web")] }) } as never);
  const prober = createMockModel({ id: "delivery-prober", provider: "mock-producer", responses: [{ content: ["unused"] }] as never });
  const arbiter = createMockModel({ id: "delivery-arbiter", provider: "mock-reviewer", handler: (context: Context) => allText(context).includes('"name":"axis_map"')
    ? { content: [{ type: "toolCall", name: "axis_map", arguments: { value: "owner", reason: "closest fixture cell" } }] }
    : allText(context).includes('"name":"novelty"')
      ? { content: [{ type: "toolCall", name: "novelty", arguments: { restatement: false, reason: "distinct mechanism" } }] }
      : { content: [{ type: "toolCall", name: "collision", arguments: { same: false, reason: "not the same mechanism" } }] } } as never);
  const judge = createMockModel({ id: "delivery-judge", provider: "mock-reviewer", handler: (context: Context) => (context.tools ?? []).some((tool) => tool.name === "verdict")
    ? { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "A", reason: "directly testable" } }] }
    : { content: ["Prefer direct executable evidence."] } } as never);
  const critic = createMockModel({ id: "delivery-critic", provider: "mock-reviewer", handler: () => ({ content: [{ type: "toolCall", name: "critique", arguments: {
    scopeCreep: [], unverifiable: [], missing: [], verdict: "ok",
  } }] }) } as never);
  const slugSource = `const input = process.argv.slice(2).join(" ");\nconst slug = input.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\nconsole.log(slug);\n`;
  const builder = createMockModel({ id: "delivery-builder", provider: "mock-producer", handler: (context: Context) => context.messages?.at(-1)?.role === "toolResult"
    ? { content: ["implementation complete"] }
    : { content: [writeCall("slugify.mjs", slugSource)] } } as never);
  const auditor = createMockModel({ id: "delivery-auditor", provider: "mock-reviewer", handler: () => ({ content: [{ type: "toolCall", name: "audit", arguments: {
    verified: ["The detached snapshot passes the executable slug check."], claimedUnverified: [], regressions: [], nextSessionNotes: "none",
    checkQuality: { adequate: true, reason: "The shell check executes the required behavior." }, verdict: "agree",
  } }] }) } as never);
  const reflector = createMockModel({ id: "delivery-reflector", provider: "mock-producer", responses: [{ content: ["No playbook delta is warranted from this fixture."] }] as never });
  const models = { brain: producer, scout, generator, prober, arbiter, judge, critic, builder, auditor, reflector } as Record<Role, Model>;
  const streamFn = ((model: Model, context: Context, options: unknown) => {
    const tools = new Set((context.tools ?? []).map((tool) => tool.name));
    if (tools.has("critique")) return streamMock(critic as never, context as never, options as never);
    if (tools.has("audit")) return streamMock(auditor as never, context as never, options as never);
    return streamMock(model as never, context as never, options as never);
  }) as never;
  const invoked = await invoke(home, ["run", "new", "Create and ship a dependency-free CLI that converts text to a slug", "--id", "stress-plug-and-play-delivery", "--yes"], {
    adaptiveWorkflow: true,
    models,
    streamFn,
    apiKeyFor: async (provider) => provider.startsWith("mock-") ? "provider-free-stress" : undefined,
    fetchImpl: fixtureFetch as unknown as typeof fetch,
    fetchUsage: async () => ({ used: 0, limit: 1 }),
  });
  const run = newestRun(home);
  const status = readStatus(run);
  const projectDir = status.projectDir;
  const artifact = projectDir ? join(projectDir, "repo", "slugify.mjs") : "";
  const executed = artifact && existsSync(artifact)
    ? Bun.spawnSync(["node", artifact, "Crème brûlée for Kiln!"], { cwd: join(projectDir!, "repo") })
    : undefined;
  return resultFromRun(scenario, base, home, run, [invoked.code], {
    ...(invoked.code === 0 ? {} : { cliOutput: invoked.output.trim() }),
    artifactOutput: executed?.stdout.toString().trim(),
    artifactExitCode: executed?.exitCode,
    projectDir,
    cleanRepo: projectDir && existsSync(join(projectDir, "repo"))
      ? Bun.spawnSync(["git", "status", "--porcelain"], { cwd: join(projectDir, "repo") }).stdout.toString() === ""
      : false,
  });
}

async function utilityScenario(scenario: "utility-delivery" | "utility-repair", root?: string): Promise<StressResult> {
  const base = scenarioRoot(scenario, root);
  const usecase = scenario === "utility-delivery" ? "utility-crash-recovery" : "check-failure-repair";
  const use = await runAutonomyUseCase(usecase, { root: base });
  const run = runPaths(use.home, use.runId);
  return resultFromRun(scenario, base, use.home, run, [use.firstExitCode ?? 0, use.exitCode], {
    artifactOutput: use.artifactOutput,
    acceptanceChecks: use.acceptanceChecks,
    crossProviderAudits: use.crossProviderAudits,
    builderSessions: use.builderSessions,
    builderModelCallsAfterResume: use.builderModelCallsAfterResume,
    cleanRepo: Bun.spawnSync(["git", "status", "--porcelain"], { cwd: join(use.projectDir, "repo") }).stdout.toString() === "",
  });
}

export async function runStressScenario(scenario: StressScenario, options: { root?: string } = {}): Promise<StressResult> {
  if (scenario === "literature-ideation" || scenario === "business-ideation" || scenario === "broad-ambiguous-seed") return ideationScenario(scenario, options.root);
  if (scenario === "invalid-output-correction") return invalidCorrection(options.root);
  if (scenario === "empty-model-output") return emptyOutput(options.root);
  if (scenario === "dns-resume" || scenario === "rate-limit-resume") return transientResume(scenario, options.root);
  if (scenario === "provider-refusal") return refusal(options.root);
  if (scenario === "pause-resume") return pauseResume(options.root);
  if (scenario === "plug-and-play-delivery") return plugAndPlayDelivery(options.root);
  if (scenario === "utility-delivery" || scenario === "utility-repair") return utilityScenario(scenario, options.root);
  throw new Error(`unknown stress scenario: ${String(scenario)}`);
}

async function cli(): Promise<void> {
  const requested = process.argv[2] as StressScenario | "all" | undefined;
  const scenarios = !requested || requested === "all" ? [...STRESS_SCENARIOS] : [requested];
  if (scenarios.some((scenario) => !STRESS_SCENARIOS.includes(scenario as StressScenario))) {
    throw new Error(`usage: bun run scripts/stress-kiln.ts [all|${STRESS_SCENARIOS.join("|")}]`);
  }
  const results: StressResult[] = [];
  for (const scenario of scenarios as StressScenario[]) results.push(await runStressScenario(scenario));
  process.stdout.write(`${JSON.stringify({ providerMode: "mocked-models-only", results }, null, 2)}\n`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (import.meta.main) await cli();
