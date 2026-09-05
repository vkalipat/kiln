import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { defaultConfig, type Role } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { acquireRunLock, RunLockedError } from "../../src/core/lock";
import { RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { shapeHash } from "../../src/phases/contracts";
import { parseBrief } from "../../src/phases/frame";
import { runIdeate, type FrontierFile, type IdeateDeps } from "../../src/phases/ideate";
import { runBare } from "../../src/ideation/bare";
import { readTournament } from "../../src/ideation/tournament";
import { requestAnotherRound } from "../../src/phases/checkpoint";

const BRIEF = `# Brief

## Problem
Find a useful mechanism.

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

const LANDSCAPE = `# Landscape

## Obvious list
- dashboard

## Atoms
- index

## Tensions
- speed vs quality

## Distant domains
- ecology
`;

type MockContext = { systemPrompt?: string[]; messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string }> };
const COST = { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 };

function text(context: MockContext): string { return JSON.stringify(context); }

function lastUser(context: MockContext): string {
  for (let i = (context.messages ?? []).length - 1; i >= 0; i -= 1) {
    const message = context.messages![i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("\n");
  }
  return "";
}

function dossierBatch(round: number, island: number, batch: number, repeat: boolean): string {
  const sourceRound = repeat && round > 1 ? 1 : round;
  return Array.from({ length: 5 }, (_, offset) => {
    const n = (batch - 1) * 5 + offset + 1;
    const audience = ["solo", "teams", "enterprise"][n % 3]!;
    const approach = ["index", "model", "protocol"][Math.floor(n / 3) % 3]!;
    return `# Idea ${offset + 1}

## Title
R${sourceRound} I${island} Idea ${n}

## Mechanism
unique mechanism round ${sourceRound} island ${island} number ${n}

## Draws on
atom ${n}

## Axes
- audience: ${audience}
- approach: ${approach}

## Testable claim
claim ${sourceRound}-${island}-${n}

## Cheapest test
manual interview ${n}

## Strongest failure reason
failure ${n}

## Probability
5%
`;
  }).join("\n");
}

function rank(title: string): number {
  const match = /R(\d+) I(\d+) Idea (\d+)/.exec(title);
  return match ? Number(match[1]) * 1000 + Number(match[2]) * 100 + Number(match[3]) : 0;
}

interface SetupOptions {
  rounds?: number;
  repeatAfterFirst?: boolean;
  rateLimitGenerator?: boolean;
  stallBrain?: boolean;
  contextPressureGenerator?: boolean;
  generatorFailureStatus?: number;
  id?: string;
}

function setup(options: SetupOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-ideate-"));
  const run = createRun(home, "seed", { id: options.id ?? "run" });
  writeFileSync(run.brief, BRIEF); writeFileSync(run.landscape, LANDSCAPE);
  const parsed = parseBrief(BRIEF);
  writeStatus(run, { phase: "ideate", shape: parsed.shape, shapeHash: shapeHash(parsed) });
  const cfg = defaultConfig();
  cfg.ideation.rounds = options.rounds ?? 3; cfg.ideation.islands = 1; cfg.ideation.cheapIsland = false;
  cfg.ideation.entrantsCap = 5; cfg.ideation.anchorsCap = 2; cfg.ideation.pairCap = 10;
  cfg.ideation.minComparisons = 3; cfg.ideation.bootstrapSamples = 20;
  cfg.ideation.arbiterCaps = { novelty: 10, collision: 10 }; cfg.ideation.searchConcurrency = 2;
  let limited = options.rateLimitGenerator === true;
  let failureStatus = options.generatorFailureStatus;
  const generator = createMockModel({ id: "generator", cost: COST, contextWindow: options.contextPressureGenerator ? 100 : 200_000, handler: (context: MockContext) => {
    if (limited) { limited = false; return { throw: "rate limit exceeded" }; }
    if (failureStatus !== undefined) {
      const status = failureStatus; failureStatus = undefined;
      return { throw: "generation failed", responseHeaders: { "x-test": "1" }, responseStatus: status, responseRequestId: `req-${status}` };
    }
    const system = (context.systemPrompt ?? []).join("\n");
    const usage = options.contextPressureGenerator ? { input: 80, output: 1 } : undefined;
    if (system.includes("Bare baseline")) return { content: [`${dossierBatch(1, 1, 1, false)}\n${dossierBatch(1, 1, 2, false)}`], usage };
    const round = Number(/Round (\d+) of/.exec(system)?.[1] ?? 1); const island = Number(/island (\d+) of/.exec(system)?.[1] ?? 1);
    const batch = /Batch 2/.test(lastUser(context)) ? 2 : 1;
    return { content: [dossierBatch(round, island, batch, options.repeatAfterFirst === true)], usage };
  } } as never);
  const scout = createMockModel({ id: "scout", cost: COST, handler: (context: MockContext) => text(context).includes("toolResult")
    ? { content: ["No artifact uses the same mechanism for the same purpose."] }
    : { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "prior art", maxResults: 1 } }] } } as never);
  const arbiter = createMockModel({ id: "arbiter", cost: COST, handler: (context: MockContext) => {
    const all = text(context);
    if (all.includes('"name":"novelty"')) return { content: [{ type: "toolCall", name: "novelty", arguments: { restatement: options.repeatAfterFirst === true && all.includes("r2-i"), reason: "mechanisms compared" } }] };
    if (all.includes('"name":"axis_map"')) return { content: [{ type: "toolCall", name: "axis_map", arguments: { value: "solo", reason: "closest" } }] };
    return { content: [{ type: "toolCall", name: "collision", arguments: { same: false, reason: "different" } }] };
  } } as never);
  const brain = createMockModel({ id: "brain", cost: COST, handler: (context: MockContext) => {
    if (options.stallBrain) {
      const ideaPath = lastUser(context).split("\n").find((line) => line.endsWith(".md")) ?? run.brief;
      return { content: [{ type: "toolCall", name: "read", arguments: { path: ideaPath } }] };
    }
    return { content: ["No executable probe is warranted."] };
  } } as never);
  let judgeCalls = 0;
  const judge = createMockModel({ id: "judge", cost: COST, handler: (context: MockContext) => {
    const tools = context.tools?.map((tool) => tool.name) ?? [];
    if (!tools.includes("verdict")) return { content: [lastUser(context).includes("meta-review") ? "Avoid vague mechanisms." : "Prefer measurable value and executable feasibility."] };
    judgeCalls += 1;
    const user = lastUser(context); const a = /^# ([^\n]+)/m.exec(user.split("## Idea A")[1] ?? "")?.[1] ?? "";
    const b = /^# ([^\n]+)/m.exec(user.split("## Idea B")[1] ?? "")?.[1] ?? "";
    const valueWinner = rank(a) >= rank(b) ? "A" : "B"; const feasibilityWinner = valueWinner === "A" ? "B" : "A";
    return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner, feasibilityWinner, reason: "tradeoff" } }] };
  } } as never);
  const prober = createMockModel({ id: "prober", cost: COST, handler: () => ({ content: ["unused"] }) } as never);
  const models: Record<Role, Model> = { brain, scout, judge, generator, prober, arbiter, builder: brain, auditor: judge, critic: judge, reflector: brain } as Record<Role, Model>;
  const record = new RunRecord(run.record);
  const deps: IdeateDeps = {
    home, run, record, cfg, models: (role) => ({ model: models[role]!, ref: `mock/${models[role]!.id}` }),
    islandModels: { generator: [{ model: generator as never, ref: "mock/generator" }] },
    apiKeyFor: async () => "key", effort: "medium", streamFn: streamMock as never,
    fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    limiter: new Limiter(cfg.ideation.concurrency), searchJitterMs: 0,
  };
  return { home, run, record, deps, generator, judgeCalls: () => judgeCalls };
}

describe("runIdeate", () => {
  test("a pre-cancelled bare phase dispatches no provider and records no false terminal event", async () => {
    const s = setup({ rounds: 1 });
    const control = new RunControl();
    control.cancel("cancel before phase dispatch");
    await expect(withRunControl(control, () => runBare(s.deps))).rejects.toBeInstanceOf(RunCancelledError);
    expect(s.generator.calls).toHaveLength(0);
    expect(s.record.read().some((event) => event.t === "failure" || event.t === "phase.end")).toBe(false);
    expect(readStatus(s.run)).toMatchObject({ phase: "ideate", state: "running" });
    expect(existsSync(s.run.lock)).toBe(false);
  });

  test("a full three-round run reaches a deterministic five-to-eight idea checkpoint", async () => {
    const a = setup({ id: "deterministic" }); const b = setup({ id: "deterministic" });
    expect(await runIdeate(a.deps)).toEqual({ outcome: "stopped", stopKind: "rounds" });
    expect(await runIdeate(b.deps)).toEqual({ outcome: "stopped", stopKind: "rounds" });
    const af = readFileSync(a.run.frontier, "utf8"); const bf = readFileSync(b.run.frontier, "utf8");
    expect(af).toBe(bf);
    const frontier = JSON.parse(af) as FrontierFile;
    expect(frontier.round).toBe(3); expect(frontier.ideas.length).toBeGreaterThanOrEqual(5); expect(frontier.ideas.length).toBeLessThanOrEqual(8);
    expect(readStatus(a.run).cursor?.step).toBe("checkpoint");
    expect(readStatus(a.run).outcome).toEqual({ kind: "stopped", stopKind: "rounds" });
    expect(readStatus(a.run).state).toBe("stopped");
    expect(existsSync(a.run.lock)).toBe(false);
    expect(existsSync(a.run.metrics)).toBe(true);
  }, 30_000);

  test("stops stagnant when a later round contributes no shown entrant", async () => {
    const s = setup({ rounds: 3, repeatAfterFirst: true });
    const result = await runIdeate(s.deps);
    expect(result).toMatchObject({ outcome: "stopped", stopKind: "stagnant" });
    expect(s.record.read().some((event) => event.t === "stop" && event.stopKind === "stagnant")).toBe(true);
  }, 20_000);

  test("stops before generation when the ideate share is below the round floor", async () => {
    const s = setup({ rounds: 1 }); s.deps.cfg.budgets.usd = 0;
    expect(await runIdeate(s.deps)).toEqual({ outcome: "stopped", stopKind: "budget", frontierEmpty: true });
    expect(readStatus(s.run).outcome).toMatchObject({ kind: "stopped", stopKind: "budget", frontierEmpty: true });
    expect(readdirSync(s.run.rawIdeasDir)).toEqual([]);
  });

  test("resume with one missing tournament ordering buys only that ordering", async () => {
    const s = setup({ rounds: 1 }); await runIdeate(s.deps);
    const lines = readTournament(s.run); const missing = lines.at(-1)!;
    const insertions = s.record.read().filter((event) => event.t === "idea.insert").length;
    writeFileSync(s.run.tournament, lines.slice(0, -1).map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeStatus(s.run, { state: "running", cursor: { round: 1, step: "tournament" }, outcome: undefined });
    const before = s.judgeCalls();
    expect(await runIdeate(s.deps)).toEqual({ outcome: "stopped", stopKind: "rounds" });
    expect(s.judgeCalls() - before).toBe(1);
    expect(readTournament(s.run).some((line) => line.a === missing.a && line.b === missing.b && line.order === missing.order)).toBe(true);
    expect(s.record.read().filter((event) => event.t === "idea.insert")).toHaveLength(insertions);
  }, 20_000);

  test("a checkpoint another decision durably extends the planned rounds", async () => {
    const s = setup({ rounds: 1 }); await runIdeate(s.deps);
    expect(requestAnotherRound(s, "favor narrower users")).toEqual({ outcome: "ok" });
    expect(await runIdeate(s.deps)).toEqual({ outcome: "stopped", stopKind: "rounds" });
    expect(JSON.parse(readFileSync(s.run.frontier, "utf8")).round).toBe(2);
    expect(s.record.read().find((event) => event.t === "checkpoint.decision" && event.kind === "another_round")).toMatchObject({ steering: "favor narrower users" });
    expect(s.record.read().flatMap((event) => event.t === "stop" && event.stopKind === "rounds" ? [event.round] : [])).toEqual([1, 2]);
    expect(readStatus(s.run).ideationRounds).toBe(2);
  }, 20_000);

  test("a provider usage-limit error pauses with fetchUsage-derived wakeAt", async () => {
    const s = setup({ rounds: 1, rateLimitGenerator: true }); const wakeAt = "2026-09-04T18:00:00.000Z";
    let polls = 0;
    s.deps.fetchUsage = async () => ++polls === 1 ? ({ used: 0, limit: 1, resetAt: wakeAt }) : ({ used: 1, limit: 1, resetAt: wakeAt });
    expect(await runIdeate(s.deps)).toEqual({ outcome: "ok" });
    expect(readStatus(s.run)).toMatchObject({ state: "paused", wakeAt, pausedReason: expect.stringContaining("rate limit") });
    expect(s.record.read().some((event) => event.t === "pause" && event.wakeAt === wakeAt)).toBe(true);
    expect(readdirSync(s.run.rawIdeasDir)).toEqual([]);
    expect(existsSync(s.run.lock)).toBe(false);

    // The raw file is the whole-session commit point. Once the usage window is healthy, resume
    // must rerun the missing island rather than trusting the partial first attempt.
    s.deps.fetchUsage = async () => ({ used: 0, limit: 1, resetAt: wakeAt });
    writeStatus(s.run, { state: "running", pausedReason: undefined, wakeAt: undefined });
    expect(await runIdeate(s.deps)).toEqual({ outcome: "stopped", stopKind: "rounds" });
    expect(readdirSync(s.run.rawIdeasDir)).toEqual(["r1-i1.md"]);
  });

  test("holds the run lock for the whole phase and leaves a live holder untouched", async () => {
    const s = setup({ rounds: 1 });
    const held = acquireRunLock(s.run);
    try {
      await expect(runIdeate(s.deps)).rejects.toBeInstanceOf(RunLockedError);
      expect(existsSync(s.run.lock)).toBe(true);
    } finally {
      held.release();
    }
  });

  test("records context pressure so the next round rebuild is observable", async () => {
    const s = setup({ rounds: 1, contextPressureGenerator: true });
    await runIdeate(s.deps);
    expect(s.record.read().some((event) => event.t === "note" && /context pressure.*fresh/i.test(event.text))).toBe(true);
  });

  test("classifies a structured generator rejection as verify and preserves its request metadata", async () => {
    const s = setup({ rounds: 1, generatorFailureStatus: 403 });
    const result = await runIdeate(s.deps);
    expect(result).toMatchObject({ outcome: "failed", failureClass: "verify", message: "generation failed" });
    expect(readdirSync(s.run.rawIdeasDir)).toEqual([]);
    expect(s.record.read().find((event) => event.t === "model.call" && event.errorStatus === 403)).toMatchObject({ errorId: "req-403" });
  });

  test("bare generation uses structured provider status instead of hardcoding transient", async () => {
    const verify = setup({ rounds: 1, generatorFailureStatus: 403 });
    expect(await runBare(verify.deps)).toMatchObject({ outcome: "failed", failureClass: "verify" });
    const transient = setup({ rounds: 1, generatorFailureStatus: 503 });
    expect(await runBare(transient.deps)).toMatchObject({ outcome: "failed", failureClass: "transient" });
  });

  test("writes terminal metrics and releases the lock when orchestration throws", async () => {
    const s = setup({ rounds: 1 });
    s.deps.islandModels = { generator: [] };
    const result = await runIdeate(s.deps);
    expect(result).toMatchObject({ outcome: "failed", failureClass: "verify" });
    expect(existsSync(s.run.metrics)).toBe(true);
    expect(existsSync(s.run.lock)).toBe(false);
  });

  test("three repeated brain tool-result fingerprints stop as stalled", async () => {
    const s = setup({ rounds: 1, stallBrain: true });
    expect(await runIdeate(s.deps)).toMatchObject({ outcome: "stopped", stopKind: "stalled" });
    expect(s.record.read().find((event) => event.t === "stop" && event.stopKind === "stalled")).toMatchObject({
      stallTool: "read",
      stallFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("bare mode renders ten ideas through the same evidence pipeline and writes no tournament", async () => {
    const s = setup({ rounds: 1 });
    expect(await runBare(s.deps)).toEqual({ outcome: "ok" });
    const frontier = JSON.parse(readFileSync(s.run.frontier, "utf8")) as FrontierFile;
    expect(frontier.mode).toBe("bare"); expect(frontier.ideas).toHaveLength(10);
    expect(readdirSync(s.run.renderedDir).filter((file) => file.endsWith("-r1.md"))).toHaveLength(10);
    expect(readTournament(s.run)).toEqual([]);
    expect(existsSync(s.run.lock)).toBe(false);
  }, 20_000);
});
