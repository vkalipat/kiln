import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { main } from "../../src/cli/main";
import { defaultConfig, saveConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun, runPaths, writeStatus } from "../../src/core/run";
import { ideateSpentUsd, projectedRoundCost } from "../../src/ideation/budget";
import { runIdeate } from "../../src/phases/ideate";

const BRIEF = `# Brief

## Problem
Find a useful indexing mechanism.

## Constraints
- cheap

## Search success
- testable

## Non-goals
- hype

## Shape
product

## Axes
- audience: solo | teams | enterprise
- approach: index | model | protocol

## Discovery questions
- What exists?
- What fails?
`;
const LANDSCAPE = "# Landscape\n\n## Obvious list\n- dashboard\n\n## Atoms\n- index\n\n## Tensions\n- speed vs quality\n\n## Distant domains\n- ecology\n";
type Context = { systemPrompt?: string[]; messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string }> };
function lastUser(ctx: Context): string {
  const content = [...(ctx.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("\n");
  return "";
}
const allText = (ctx: Context) => JSON.stringify(ctx);

function batch(n: number): string {
  return Array.from({ length: 5 }, (_, index) => {
    const id = n * 5 + index + 1;
    return `# Idea ${index + 1}

## Title
Idea ${id}

## Mechanism
distinct indexing mechanism ${id}

## Draws on
atom ${id}

## Axes
- audience: ${["solo", "teams", "enterprise"][id % 3]}
- approach: ${["index", "model", "protocol"][id % 3]}

## Testable claim
claim ${id}

## Cheapest test
manual test ${id}

## Strongest failure reason
failure ${id}

## Probability
5%
`;
  }).join("\n");
}

function models(): Record<Role, Model> {
  const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const brain = createMockModel({ id: "brain", cost, handler: (ctx: Context) => {
    const target = /Output file: (\S+)/.exec((ctx.systemPrompt ?? []).join("\n"))?.[1] ?? "";
    if (target.endsWith("brief.md") && !existsSync(target)) return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: BRIEF } }] };
    if (target.endsWith("landscape.md") && !existsSync(target)) return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: LANDSCAPE } }] };
    return { content: ["No executable probe is warranted."] };
  } } as never);
  const scout = createMockModel({ id: "scout", cost, handler: (ctx: Context) => {
    if (!allText(ctx).includes("Prior-art check")) return { content: ["- useful landscape finding"] };
    if (allText(ctx).includes("toolResult")) return { content: ["No matching artifact found."] };
    return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "indexing prior art", maxResults: 1 } }] };
  } } as never);
  const generator = createMockModel({ id: "generator", cost, handler: (ctx: Context) => ({ content: [(ctx.systemPrompt ?? []).join("\n").includes("Bare baseline") ? `${batch(0)}\n${batch(1)}` : batch(lastUser(ctx).includes("Batch 2") ? 1 : 0)] }) } as never);
  const arbiter = createMockModel({ id: "arbiter", cost, handler: (ctx: Context) => allText(ctx).includes('"name":"axis_map"')
    ? { content: [{ type: "toolCall", name: "axis_map", arguments: { value: "solo", reason: "closest" } }] }
    : allText(ctx).includes('"name":"novelty"')
      ? { content: [{ type: "toolCall", name: "novelty", arguments: { restatement: false, reason: "different mechanism" } }] }
      : { content: [{ type: "toolCall", name: "collision", arguments: { same: false, reason: "different" } }] } } as never);
  const judge = createMockModel({ id: "judge", cost, handler: (ctx: Context) => {
    if ((ctx.tools ?? []).some((tool) => tool.name === "verdict")) return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "B", reason: "tradeoff" } }] };
    return { content: [lastUser(ctx).includes("Losing reasons") ? "Prefer concrete mechanisms." : "Prefer measurable value and feasible tests."] };
  } } as never);
  const prober = createMockModel({ id: "prober", cost, responses: [{ content: ["unused"] }] as never });
  return { brain, scout, judge, generator, prober, arbiter, builder: brain, auditor: judge, critic: judge, reflector: brain } as Record<Role, Model>;
}

describe("kiln run through checkpoint", () => {
  test("runs frame, discover, ideate and autonomous checkpoint with mocks", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-e2e-ideate-")); initHome(home);
    const cfg = defaultConfig(); cfg.ideation.rounds = 1; cfg.ideation.islands = 1; cfg.ideation.cheapIsland = false;
    cfg.ideation.entrantsCap = 5; cfg.ideation.anchorsCap = 2; cfg.ideation.pairCap = 10; cfg.ideation.minComparisons = 3; cfg.ideation.bootstrapSamples = 20;
    saveConfig(home, cfg);
    const output: string[] = [];
    const code = await main(["run", "new", "indexing tool", "--home", home, "--through", "checkpoint", "--autonomous", "--yes", "--json"], { write: (text) => output.push(text), error: (text) => output.push(text) }, {
      streamFn: streamMock as never, models: models(), apiKeyFor: async () => "key",
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    });
    expect({ code, output: output.join("") }).toMatchObject({ code: 0 });
    const summary = JSON.parse(output.join(""));
    expect(summary.status).toMatchObject({ phase: "form", state: "running" });
    expect(summary.status.chosenIdeaId).toMatch(/^r1-i1-/);
    expect(summary.frontier.ideas.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(summary.dir, "frontier.json"), "utf8")).ideas.length).toBeGreaterThan(0);
    expect(existsSync(join(summary.dir, "metrics.json"))).toBe(true);
  }, 20_000);

  test("CLI bare mode reaches the same checkpoint with ten renders and no tournament", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-e2e-bare-")); initHome(home);
    const cfg = defaultConfig(); cfg.ideation.rounds = 1; cfg.ideation.bootstrapSamples = 20; saveConfig(home, cfg);
    const output: string[] = [];
    const code = await main(["run", "new", "indexing tool", "--home", home, "--bare", "--autonomous", "--yes", "--json"], { write: (text) => output.push(text), error: (text) => output.push(text) }, {
      streamFn: streamMock as never, models: models(), apiKeyFor: async () => "key",
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    });
    expect(code).toBe(0); const summary = JSON.parse(output.join(""));
    const frontier = JSON.parse(readFileSync(join(summary.dir, "frontier.json"), "utf8"));
    expect(frontier.mode).toBe("bare"); expect(frontier.ideas).toHaveLength(10);
    expect(existsSync(join(summary.dir, "tournament.jsonl"))).toBe(false);
    expect(summary.status).toMatchObject({ phase: "form", state: "running" });
  }, 20_000);

  test("a total prior-art outage stays visible as unknown novelty instead of a false no-idea exit", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-e2e-search-outage-")); initHome(home);
    const cfg = defaultConfig(); cfg.ideation.rounds = 1; cfg.ideation.islands = 1; cfg.ideation.cheapIsland = false;
    cfg.ideation.entrantsCap = 5; cfg.ideation.anchorsCap = 2; cfg.ideation.pairCap = 10; cfg.ideation.minComparisons = 3; cfg.ideation.bootstrapSamples = 20;
    saveConfig(home, cfg);
    const output: string[] = [];
    const code = await main(["run", "new", "indexing tool", "--home", home, "--through", "checkpoint", "--autonomous", "--yes", "--json"], { write: (text) => output.push(text), error: (text) => output.push(text) }, {
      streamFn: streamMock as never, models: models(), apiKeyFor: async () => "key",
      fetchImpl: (async () => new Response("search unavailable", { status: 503 })) as unknown as typeof fetch,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    });
    expect(code).toBe(0);
    const summary = JSON.parse(output.join(""));
    expect(summary.frontier).toMatchObject({ searchHealth: 0, noveltyEnforced: false });
    expect(summary.frontier.eligible.length).toBeGreaterThan(0);
    expect(summary.status).toMatchObject({ phase: "form", state: "running" });
  }, 20_000);

  test("a near-floor resume judges only the missing ordering instead of demanding a fresh full round", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-e2e-ideate-resume-")); initHome(home);
    const cfg = defaultConfig(); cfg.routing = { mode: "manual" }; cfg.ideation.rounds = 1; cfg.ideation.islands = 1; cfg.ideation.cheapIsland = false;
    cfg.ideation.entrantsCap = 5; cfg.ideation.anchorsCap = 2; cfg.ideation.pairCap = 10; cfg.ideation.minComparisons = 3; cfg.ideation.bootstrapSamples = 20;
    saveConfig(home, cfg);
    const output: string[] = []; const seats = models();
    const code = await main(["run", "new", "indexing tool", "--home", home, "--through", "ideate", "--autonomous", "--yes", "--json"], { write: (text) => output.push(text), error: (text) => output.push(text) }, {
      streamFn: streamMock as never, models: seats, apiKeyFor: async () => "key",
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    });
    expect(code).toBe(0);
    const summary = JSON.parse(output.join("")); const run = runPaths(home, summary.id); const record = new RunRecord(run.record);
    const lines = readFileSync(run.tournament, "utf8").trim().split("\n");
    writeFileSync(run.tournament, `${lines.slice(0, -1).join("\n")}\n`);
    writeStatus(run, { phase: "ideate", state: "running", cursor: { round: 1, step: "round.start" }, outcome: undefined });
    const full = projectedRoundCost(cfg, (role) => ({ model: seats[role], ref: `mock/${role}` })).costUsd;
    const spent = ideateSpentUsd(record.read());
    cfg.budgets.usd = (spent + full / 10) / cfg.budgets.share.ideate;
    const before = record.read().filter((event) => event.t === "model.call" && event.role === "judge").length;
    const result = await runIdeate({
      home, run, record, cfg, limiter: new Limiter(4), streamFn: streamMock as never,
      models: (role: Role) => ({ model: seats[role], ref: `mock/${role}` }), apiKeyFor: async () => "key",
      fetchUsage: async () => ({ used: 0, limit: 1 }), islandModels: { generator: [{ model: seats.generator, ref: "mock/generator" }] },
    } as never);
    const after = record.read().filter((event) => event.t === "model.call" && event.role === "judge").length;
    expect(result).toMatchObject({ outcome: "stopped", stopKind: "rounds" });
    expect(after - before).toBeGreaterThanOrEqual(1);
    expect(after - before).toBeLessThanOrEqual(2); // one ordering, plus at most its bounded retry
  }, 20_000);

  test("an exhausted ideation wall allocation stops before any generator call", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-e2e-ideate-wall-")); initHome(home);
    const run = createRun(home, "indexing tool");
    writeFileSync(run.brief, BRIEF); writeFileSync(run.landscape, LANDSCAPE);
    writeStatus(run, { phase: "ideate", state: "running", shape: "product" });
    const cfg = defaultConfig(); cfg.budgets.wallSeconds = 0; cfg.ideation.rounds = 1; cfg.ideation.islands = 1; cfg.ideation.cheapIsland = false;
    const seats = models(); const record = new RunRecord(run.record);
    const result = await runIdeate({
      home, run, record, cfg, limiter: new Limiter(2), streamFn: streamMock as never,
      models: (role: Role) => ({ model: seats[role], ref: `mock/${role}` }), apiKeyFor: async () => "key",
      islandModels: { generator: [{ model: seats.generator, ref: "mock/generator" }] },
    } as never);
    expect(result).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect((seats.generator as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });
});
