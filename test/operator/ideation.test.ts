import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig, saveConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { acquireRunLock, RunLockedError } from "../../src/core/lock";
import { createRun, readStatus, type RunPaths } from "../../src/core/run";
import { RunCancelledError } from "../../src/core/run-control";
import { invokeIdeation, type InvokeIdeationInput } from "../../src/operator/ideation";

const BRIEF = "# Brief\n\n## Problem\nFind a useful indexing mechanism.\n\n## Constraints\n- cheap\n\n## Search success\n- testable\n\n## Non-goals\n- hype\n\n## Shape\nproduct\n\n## Axes\n- audience: solo | teams | enterprise\n- approach: index | model | protocol\n\n## Discovery questions\n- What exists?\n- What fails?\n";
const LANDSCAPE = "# Landscape\n\n## Obvious list\n- dashboard\n\n## Atoms\n- index\n\n## Tensions\n- speed vs quality\n\n## Distant domains\n- ecology\n";
const batch = (offset: number) => Array.from({ length: 5 }, (_, i) => `# Idea ${i + 1}\n\n## Title\nIdea ${i + offset}\n\n## Mechanism\ndistinct indexing mechanism ${i + offset}\n\n## Draws on\natom ${i + offset}\n\n## Axes\n- audience: ${["solo", "teams", "enterprise"][i % 3]}\n- approach: ${["index", "model", "protocol"][i % 3]}\n\n## Testable claim\nclaim ${i + offset}\n\n## Cheapest test\nmanual test ${i + offset}\n\n## Strongest failure reason\nfailure ${i + offset}\n\n## Probability\n5%\n`).join("\n");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-operator-ideation-")); initHome(home);
  const parentRun = createRun(home, "Original indexing goal");
  const cfg = defaultConfig(); cfg.routing = { mode: "adaptive" }; Object.assign(cfg.ideation, { rounds: 1, islands: 1, cheapIsland: false, entrantsCap: 5, anchorsCap: 2, pairCap: 10, minComparisons: 3, bootstrapSamples: 20 }); saveConfig(home, cfg);
  const mock = (id: string, handler: (ctx: any) => any) => createMockModel({ id, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, handler: (ctx: any) => ({ ...handler(ctx), usage: { input: 100, output: 100, cost: { input: 0.0001, output: 0.0002, total: 0.0003 } } }) } as never);
  const brain = mock("brain", (ctx) => {
    const target = /Output file: (\S+)/.exec((ctx.systemPrompt ?? []).join("\n"))?.[1] ?? "";
    if (!existsSync(target) && (target.endsWith("brief.md") || target.endsWith("landscape.md"))) return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: target.endsWith("brief.md") ? BRIEF : LANDSCAPE } }] };
    return { content: ["No executable probe is warranted."] };
  });
  const scout = mock("scout", (ctx) => {
    const text = JSON.stringify(ctx);
    if (!text.includes("Prior-art check")) return { content: ["Useful landscape finding"] };
    if (text.includes("toolResult")) return { content: ["No matching artifact found."] };
    return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "indexing prior art", maxResults: 1 } }] };
  });
  const generator = mock("generator", (ctx) => ({ content: [batch(JSON.stringify(ctx.messages).includes("Batch 2") ? 5 : 0)] }));
  const judge = mock("judge", (ctx) => (ctx.tools ?? []).some((tool: any) => tool.name === "verdict")
    ? { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "B", reason: "tradeoff" } }] }
    : { content: ["Prefer measurable value and feasible tests."] });
  const arbiter = mock("arbiter", (ctx) => {
    const text = JSON.stringify(ctx);
    const [name, args] = text.includes('"name":"axis_map"') ? ["axis_map", { value: "solo", reason: "closest" }]
      : text.includes('"name":"novelty"') ? ["novelty", { restatement: false, reason: "different mechanism" }]
      : ["collision", { coverageAdequate: true, same: false, reason: "different" }];
    return { content: [{ type: "toolCall", name, arguments: args }] };
  });
  const models = { brain, scout, generator, judge, arbiter, prober: brain, builder: brain, auditor: judge, critic: judge, reflector: brain };
  let dispatches = 0;
  const abort = new AbortController();
  const input: InvokeIdeationInput = { home, parentRun, originalGoal: "Build a useful indexing tool", task: "Compare indexing mechanisms", cfg,
    signal: abort.signal, apiKeyFor: async () => "offline-key", models: (role: Role) => ({ model: models[role] as never, ref: `mock/${role}` }),
    streamFn: ((...args: Parameters<typeof streamMock>) => { dispatches++; return streamMock(...args); }) as never,
    fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    fetchUsage: async () => ({ used: 0, limit: 1 }) };
  return { input, abort, dispatches: () => dispatches };
}

test("native module runs research, competitive ideation and checkpoint under parent resources", async () => {
  const { input, dispatches } = fixture();
  const events: string[] = []; input.onEvent = (event) => events.push(event.type);
  input.onRun = (run) => { expect(() => acquireRunLock(run)).toThrow(RunLockedError); };
  const contextPath = join(input.parentRun.dir, "requirements.txt"); writeFileSync(contextPath, "Preserve existing scope.\n");
  input.context = [{ path: contextPath, sha256: createHash("sha256").update(readFileSync(contextPath)).digest("hex") }];
  const result = await invokeIdeation(input);
  expect(result.outcome).toEqual({ outcome: "ok" });
  expect(result.chosenId).toMatch(/^r1-i1-/);
  expect(result.shortlist.length).toBeGreaterThan(0);
  expect(result.shortlist.some((entry) => entry.id === result.chosenId && entry.eligible)).toBe(true);
  expect(result.runDir.startsWith(join(input.parentRun.dir, "artifacts", "ideation", "runs"))).toBe(true);
  expect(result.shortlist.every((entry) => entry.probeStatus === "not_run")).toBe(true);
  expect(result.artifacts.every((ref) => createHash("sha256").update(readFileSync(ref.path)).digest("hex") === ref.sha256)).toBe(true);
  const seedHash = createHash("sha256").update(readFileSync(join(result.runDir, "seed.md"))).digest("hex");
  const workflow = JSON.parse(readFileSync(join(result.runDir, "workflow.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(input.parentRun.dir, "artifacts", "ideation", `${result.runId}.json`), "utf8"));
  expect(workflow.seedSha256).toBe(seedHash); expect(provenance.seedSha256).toBe(seedHash);
  expect(result.costUsd).toBeGreaterThan(0); expect(dispatches()).toBeGreaterThan(0); expect(events.length).toBeGreaterThan(0);
  expect(result.costUsd).toBeCloseTo(dispatches() * 0.0003, 10);
  const record = new RunRecord(join(result.runDir, "record.jsonl")).read();
  expect(record.some((event) => event.t === "checkpoint.decision" && event.kind === "autonomous_pick")).toBe(true);
  expect(record.some((event) => event.t === "phase.start" && (event.phase === "form" || event.phase === "build"))).toBe(false);
}, 20_000);

test("frozen input tamper fails before provider dispatch", async () => {
  const { input, dispatches } = fixture();
  input.onRun = (run) => writeFileSync(run.seed, "tampered");
  const result = await invokeIdeation(input);
  expect(result.outcome).toMatchObject({ outcome: "failed", failureClass: "integrity" });
  expect(result.chosenId).toBeUndefined(); expect(dispatches()).toBe(0);
});

test("parent cancellation stops the module before provider dispatch and saves child pause", async () => {
  const { input, abort, dispatches } = fixture(); let run: RunPaths | undefined;
  input.onRun = (value) => { run = value; abort.abort("operator cancelled"); };
  await expect(invokeIdeation(input)).rejects.toBeInstanceOf(RunCancelledError);
  expect(readStatus(run!)).toMatchObject({ state: "paused", pausedReason: "user_cancelled" });
  expect(dispatches()).toBe(0);
});

test("native provider refusal stays terminal without switching seats or manufacturing a shortlist", async () => {
  const { input, dispatches } = fixture();
  const refusal = createMockModel({ id: "refusal", responses: [{ content: [], stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Provider declined" }] as never });
  input.models = () => ({ model: refusal as never, ref: "mock/refusal" });
  const result = await invokeIdeation(input);
  expect(result.outcome).toMatchObject({ outcome: "failed", failureClass: "refusal" });
  expect(result.chosenId).toBeUndefined(); expect(result.shortlist).toEqual([]);
  expect(dispatches()).toBe(1);
});

test("artifact symlink traversal is refused before creating outside directories", async () => {
  const { input, dispatches } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "kiln-module-outside-"));
  symlinkSync(outside, join(input.parentRun.dir, "artifacts"));
  await expect(invokeIdeation(input)).rejects.toThrow("policy");
  expect(existsSync(join(outside, "ideation"))).toBe(false);
  expect(dispatches()).toBe(0);
});

test("context snapshots reject mismatching hashes and oversized files before dispatch", async () => {
  const { input, dispatches } = fixture();
  const path = join(input.parentRun.dir, "context.txt"); writeFileSync(path, "original");
  input.context = [{ path, sha256: "0".repeat(64) }];
  await expect(invokeIdeation(input)).rejects.toThrow("hash mismatch");
  writeFileSync(path, "x".repeat(65_537));
  await expect(invokeIdeation(input)).rejects.toThrow("65536");
  expect(dispatches()).toBe(0);
});

test("authenticated updates are frozen in order without changing original goal identity", async () => {
  const { input } = fixture();
  input.userDirections = ["Allow a hosted prototype.", "Use local execution only; no hosted services."];
  const result = await invokeIdeation(input);
  expect(result.outcome).toEqual({ outcome: "ok" });
  const seed = readFileSync(join(result.runDir, "seed.md"), "utf8");
  expect(seed).toContain(input.originalGoal);
  expect(seed).toContain(input.userDirections[1]!);
  expect(seed).toContain("newer updates supersede the original goal");
  expect(seed.indexOf(input.userDirections[0]!)).toBeLessThan(seed.indexOf(input.userDirections[1]!));
  const provenance = JSON.parse(readFileSync(join(input.parentRun.dir, "artifacts", "ideation", `${result.runId}.json`), "utf8"));
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(provenance.originalGoalSha256).toBe(hash(input.originalGoal));
  expect(provenance.userDirectionsSha256).toBe(hash(JSON.stringify(input.userDirections)));
  expect(provenance.userDirectionHashes).toEqual(input.userDirections.map(hash));
});

test("oversized user updates fail explicitly before creating a child or dispatching", async () => {
  const { input, dispatches } = fixture();
  for (const directions of [Array.from({ length: 17 }, () => "update"), ["x".repeat(32_769)]]) {
    input.userDirections = directions;
    await expect(invokeIdeation(input)).rejects.toThrow("user directions");
  }
  expect(existsSync(join(input.parentRun.dir, "artifacts"))).toBe(false);
  expect(dispatches()).toBe(0);
});

test("failed ideation resumes the same child without replaying completed research or resetting cost", async () => {
  const { input, dispatches } = fixture();
  const originalModels = input.models;
  const broken = createMockModel({ id: "generator", handler: () => ({ content: ["# Idea 1\n## Title\nIncomplete"], usage: { input: 100, output: 100, cost: { total: 0.0003 } } }) } as never);
  input.models = (role) => role === "generator" ? { model: broken as never, ref: "mock/generator" } : originalModels(role);
  const failed = await invokeIdeation(input);
  expect(failed.outcome).toMatchObject({ outcome: "failed", failureClass: "verify" });
  expect(failed.status.phase).toBe("ideate");
  const record = new RunRecord(join(failed.runDir, "record.jsonl"));
  const completedCount = () => record.read().filter((event) => event.t === "phase.end" && ["frame", "discover"].includes(event.phase)).length;
  expect(completedCount()).toBe(2);
  const sourceHashes = ["brief.md", "landscape.md"].map((file) => readFileSync(join(failed.runDir, file), "utf8"));
  input.models = originalModels; input.resumeRunId = failed.runId;
  const resumed = await invokeIdeation(input);
  expect(resumed.runId).toBe(failed.runId); expect(resumed.outcome).toEqual({ outcome: "ok" });
  expect(resumed.costUsd).toBeGreaterThan(failed.costUsd); expect(completedCount()).toBe(2);
  expect(["brief.md", "landscape.md"].map((file) => readFileSync(join(failed.runDir, file), "utf8"))).toEqual(sourceHashes);
  expect(record.read().filter((event) => event.t === "run.created")).toHaveLength(1);
  const beforeCalls = dispatches(); const beforeRecord = readFileSync(record.path, "utf8");
  const replay = await invokeIdeation(input);
  expect(replay.chosenId).toBe(resumed.chosenId); expect(replay.costUsd).toBe(resumed.costUsd);
  expect(dispatches()).toBe(beforeCalls); expect(readFileSync(record.path, "utf8")).toBe(beforeRecord);
}, 20_000);

test("recovery refuses changed identity or config before provider dispatch", async () => {
  const { input, dispatches } = fixture();
  const completed = await invokeIdeation(input);
  input.resumeRunId = completed.runId;
  const count = dispatches();
  await expect(invokeIdeation({ ...input, task: "A different task" })).rejects.toThrow("task or goal changed");
  await expect(invokeIdeation({ ...input, cfg: { ...input.cfg, effort: "low" } })).rejects.toThrow();
  expect(dispatches()).toBe(count);
});
