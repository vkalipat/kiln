import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { runReflect as reflectPhase } from "../../src/phases/reflect";
import { main } from "../../src/cli/main";
import { defaultConfig, loadConfig, saveConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { readStatus } from "../../src/core/run";
import { derivedCaps } from "../../src/formation/features";
import { builderResult, feature, setupLoop } from "../build/loop-fixture";

const BRIEF = `# Brief

## Problem
Operators need a small local artifact.

## Constraints
- local only

## Search success
- visible output

## Non-goals
- hosted service

## Shape
product

## Axes
- buyer: solo | team | enterprise
- mechanism: cli | web | api
- value: speed | quality | cost

## Discovery questions
- What exists?
- What fails?
`;

const LANDSCAPE = `# Landscape

## Obvious list
- dashboard

## Atoms
- local file

## Tensions
- speed vs quality

## Distant domains
- compilers
`;

const SPEC = `# Spec

## What
A local artifact.

## For whom
Operators.

## Why now
The input is available.

## Scope
- one generated file

## Non-goals
- hosted service

## Risks
Input drift.

## First milestone
The repository contains artifact.txt.
`;

const initialFeatures = () => ({
  version: 1,
  init: { needs: [] },
  features: [{
    title: "Create the artifact",
    description: "Write the first local artifact.",
    acceptance: { type: "file", path: "artifact.txt", contains: "built" },
  }],
});

const frozenFeatures = () => ({
  ...initialFeatures(),
  features: initialFeatures().features.map((feature, index) => ({ ...feature, id: `f${String(index + 1).padStart(2, "0")}` })),
});

type Context = {
  systemPrompt?: string[];
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string }>;
};

function lastUser(ctx: Context): string {
  const content = [...(ctx.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("\n");
  }
  return "";
}

function lastRole(ctx: Context): string | undefined {
  return ctx.messages?.at(-1)?.role;
}

const writeCall = (path: string, content: string) => ({ type: "toolCall", name: "write", arguments: { path, content } });
const allText = (ctx: Context) => JSON.stringify(ctx);

function batch(): string {
  return Array.from({ length: 10 }, (_, index) => {
    const id = index + 1;
    return `# Idea ${id}

## Title
Artifact ${id}

## Mechanism
Generate local artifact ${id} from a frozen input.

## Draws on
Compiler pass ${id}.

## Axes
- buyer: ${["solo", "team", "enterprise"][id % 3]}
- mechanism: ${["cli", "web", "api"][id % 3]}
- value: ${["speed", "quality", "cost"][id % 3]}

## Testable claim
Artifact ${id} can be checked from disk.

## Cheapest test
Read the generated file.

## Strongest failure reason
The artifact may be incomplete.

## Probability
5%
`;
  }).join("\n");
}

function mockedHarness() {
  const formed: { spec?: string; features?: string; init?: string } = {};
  const brain = createMockModel({ id: "brain", handler: (ctx: Context) => {
    if (lastRole(ctx) === "toolResult") return { content: ["done"] };
    const prompt = lastUser(ctx);
    const target = /Output file: (\S+)/.exec((ctx.systemPrompt ?? []).join("\n"))?.[1];
    if (target?.endsWith("brief.md") && !existsSync(target)) return { content: [writeCall(target, BRIEF)] };
    if (target?.endsWith("landscape.md") && !existsSync(target)) return { content: [writeCall(target, LANDSCAPE)] };

    const requested = /^Write (.+) now\.$/m.exec(prompt)?.[1];
    if (requested && basename(requested) === "spec.md") {
      formed.spec = requested;
      return { content: [writeCall(requested, SPEC)] };
    }
    if (requested && basename(requested) === "features.json") {
      formed.features = requested;
      return { content: [writeCall(requested, JSON.stringify(initialFeatures()))] };
    }
    if (requested && basename(requested) === "init.sh") {
      formed.init = requested;
      return { content: [writeCall(requested, "#!/bin/sh\nexit 0\n")] };
    }
    if (prompt.includes("Revise the complete formed project")) {
      if (!formed.spec || !formed.features || !formed.init) throw new Error("form paths were not captured");
      return { content: [
        writeCall(formed.spec, SPEC),
        writeCall(formed.features, JSON.stringify(frozenFeatures())),
        writeCall(formed.init, "#!/bin/sh\nexit 0\n"),
      ] };
    }
    return { content: ["No executable probe is warranted."] };
  } } as never);

  const scout = createMockModel({ id: "scout", handler: (ctx: Context) => {
    if (!allText(ctx).includes("Prior-art check")) return { content: ["- useful local-artifact finding"] };
    if (allText(ctx).includes("toolResult")) return { content: ["No matching artifact found."] };
    return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "local artifact prior art", maxResults: 1 } }] };
  } } as never);
  const generator = createMockModel({ id: "generator", handler: () => ({ content: [batch()] }) } as never);
  const prober = createMockModel({ id: "prober", handler: () => ({ content: ["unused"] }) } as never);
  const arbiter = createMockModel({ id: "arbiter", handler: (ctx: Context) => allText(ctx).includes('"name":"axis_map"')
    ? { content: [{ type: "toolCall", name: "axis_map", arguments: { value: "solo", reason: "closest" } }] }
    : allText(ctx).includes('"name":"novelty"')
      ? { content: [{ type: "toolCall", name: "novelty", arguments: { restatement: false, reason: "different mechanism" } }] }
      : { content: [{ type: "toolCall", name: "collision", arguments: { same: false, reason: "different" } }] } } as never);
  const judge = createMockModel({ id: "judge", handler: () => ({ content: [{
    type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "B", reason: "tradeoff" },
  }] }) } as never);
  const critic = createMockModel({ id: "critic", handler: () => ({ content: [{
    type: "toolCall", name: "critique", arguments: { scopeCreep: [], unverifiable: [], missing: [], verdict: "ok" },
  }] }) } as never);
  const builder = createMockModel({ id: "builder", handler: (ctx: Context) => lastRole(ctx) === "toolResult"
    ? { content: ["done"] }
    : { content: [writeCall("artifact.txt", "built\n")] } } as never);
  const auditor = createMockModel({ id: "auditor", handler: () => ({ content: [{
    type: "toolCall", name: "audit", arguments: {
      verified: ["artifact exists"], claimedUnverified: [], regressions: [], nextSessionNotes: "none",
      checkQuality: { adequate: true, reason: "The file check is direct." }, verdict: "agree",
    },
  }] }) } as never);
  const reflector = createMockModel({ id: "reflector", handler: () => ({ content: [{
    type: "toolCall", name: "playbook_delta", arguments: {
      op: "add", section: "build", text: "Prefer a direct executable artifact check.",
      why: "The executable check caught a mismatch before audit.", kind: "confirmed",
      evidence: [{ kind: "metric", ref: "featuresTotal" }],
    },
  }] }) } as never);

  const models = { brain, scout, judge, generator, prober, arbiter, builder, auditor, critic, reflector } as Record<Role, Model>;
  const streamFn = ((model: Model, ctx: Context, options: unknown) => {
    const tools = new Set((ctx.tools ?? []).map((tool) => tool.name));
    if (tools.has("critique")) return streamMock(critic as never, ctx as never, options as never);
    if (tools.has("audit")) return streamMock(auditor as never, ctx as never, options as never);
    return streamMock(model as never, ctx as never, options as never);
  }) as never;
  return { models, streamFn };
}

const SECTION_14_KEYS = [
  "featuresTotal", "featuresPassed", "featuresBlocked", "attemptsByFeature", "builderSessions", "checkPassRate", "initExitCode",
  "regressionsCaught", "regressionRepairs", "regressionSweepSeconds", "regressionChecksRun", "regressionChecksSkipped", "sweepsIncomplete",
  "auditorAgreeRate", "auditorDisagreeRate", "auditorEmptyDisagreeRate", "auditorTruncated", "auditEvidenceUsable", "auditRetried",
  "auditorTokenShare", "auditorCostUsd", "checkQualityInadequate", "costByRole", "costByPhase", "wallByPhase", "stopKind", "stops",
  "honestExits", "declarationOverruled", "formationRevisions", "formationAttempts", "criticVerdicts", "crossProviderCritic",
  "crossProviderAuditor", "manualFeatureShare", "builderSelfVerified", "builderCommitted", "relocked", "specDrift", "overBudgetPlan",
  "skippedAfterBlocked", "floorUnderestimated", "usdCapHits", "budgetOvershootUsd", "checksVoided", "censored", "contextPressureByArm",
  "digestTruncated", "deltaProposed",
] as const;

function cliIo(output: string[]) {
  return { write: (text: string) => output.push(text), error: (text: string) => output.push(text) };
}

describe("formation and build CLI end to end", () => {
  test("run --through reflect completes the mocked lifecycle and writes every section 14 metric", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-e2e-form-build-"));
    initHome(home);
    const cfg = defaultConfig();
    cfg.ideation.rounds = 1;
    cfg.ideation.bootstrapSamples = 20;
    cfg.build.minFeatures = 1;
    cfg.build.maxFeatures = 1;
    saveConfig(home, cfg);
    const harness = mockedHarness();
    const output: string[] = [];

    const code = await main([
      "run", "new", "local artifact", "--home", home, "--bare", "--through", "reflect", "--autonomous", "--yes", "--json",
    ], cliIo(output), {
      models: harness.models,
      streamFn: harness.streamFn,
      apiKeyFor: async () => "key",
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    });

    expect(code).toBe(0);
    const summary = JSON.parse(output.join(""));
    expect(summary.status).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(summary.outcome).toEqual({ outcome: "ok" });
    expect(summary.projectDir).toBeString();
    expect(summary.features).toMatchObject([{ id: "f01", state: "passed", passes: true, passSource: "executed" }]);
    expect(readFileSync(join(summary.projectDir, "repo", "artifact.txt"), "utf8")).toBe("built\n");

    const metrics = JSON.parse(readFileSync(join(summary.dir, "metrics.json"), "utf8"));
    expect(Object.keys(metrics)).toEqual(expect.arrayContaining([...SECTION_14_KEYS]));
    expect(metrics).toMatchObject({
      featuresTotal: 1,
      featuresPassed: { executed: 1, humanVerified: 0 },
      checkPassRate: { acceptance: 1 },
      digestTruncated: false,
      deltaProposed: { accepted: 1, rejected: 0 },
    });

    const events = new RunRecord(join(summary.dir, "record.jsonl")).read();
    const buildEnd = events.find((event) => event.t === "phase.end" && event.phase === "build")?.seq ?? -1;
    const reflectStart = events.find((event) => event.t === "phase.start" && event.phase === "reflect")?.seq ?? -1;
    expect(buildEnd).toBeGreaterThan(0);
    expect(reflectStart).toBeGreaterThan(buildEnd);
  }, 30_000);

  test("project build single-session preserves aggregate caps, arm provenance, context pressure and deadline censoring", async () => {
    const fixture = setupLoop([feature("f01"), feature("f02")]);

    const startedAt = Date.now();
    let expired = false;
    let driverOptions: { turnCap: number; usdCap: number } | undefined;
    let statusAtReflect: ReturnType<typeof readStatus> | undefined;
    const harness = mockedHarness();
    const output: string[] = [];
    const injected: any = {
      models: harness.models,
      streamFn: harness.streamFn,
      apiKeyFor: async () => "key",
      fetchUsage: async () => ({ used: 0, limit: 1 }),
      buildDeps: {
        git: fixture.git,
        runCheck: fixture.deps.runCheck,
        runAuditor: fixture.deps.runAuditor,
        runSweep: fixture.deps.runSweep,
        now: () => expired ? startedAt + 1_000_000_000 : startedAt,
        stepHook: (index: number) => { if (index === 11) expired = true; },
        createDriver: (_deps: unknown, options: { turnCap: number; usdCap: number }) => {
          driverOptions = options;
          return {
            spentUsd: 0,
            turns: 0,
            runFeature: async () => builderResult({ contextPressure: true }),
          };
        },
      },
      runReflect: async (deps: Parameters<typeof reflectPhase>[0]) => {
        statusAtReflect = readStatus(deps.run);
        return reflectPhase(deps);
      },
    };

    const code = await main([
      "project", "build", fixture.deps.run.id, "--home", fixture.home, "--single-session", "--autonomous", "--yes", "--json",
    ], cliIo(output), injected);

    expect(code).toBe(0);
    expect(statusAtReflect).toMatchObject({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "deadline" } });
    const cfg = loadConfig(fixture.home);
    const aggregate = derivedCaps(cfg).maxFeatures * cfg.build.expectedAttempts;
    expect(driverOptions).toMatchObject({
      turnCap: cfg.build.sessionTurnCap * aggregate,
      usdCap: cfg.build.builderUsdCap * aggregate,
    });
    const attempts = fixture.record.read().filter((event) => event.t === "attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ arm: "single_session", contextPressure: true, disposition: "passed" });
    const metrics = JSON.parse(readFileSync(fixture.deps.run.metrics, "utf8"));
    expect(metrics).toMatchObject({
      stopKind: "deadline",
      censored: true,
      contextPressureByArm: { fresh: 0, single_session: 1 },
    });
    const events = fixture.record.read();
    expect(events.findIndex((event) => event.t === "phase.start" && event.phase === "reflect"))
      .toBeGreaterThan(events.findIndex((event) => event.t === "phase.end" && event.phase === "build"));
  }, 20_000);
});
