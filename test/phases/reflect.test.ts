import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { loadPlaybook, loadPrompt } from "../../src/brain/prompts";
import { stripCounters, type PlaybookDelta } from "../../src/build/delta";
import { buildFail, buildHonest, buildStop, buildSuccess } from "../../src/build/loop-outcomes";
import type { Metrics } from "../../src/build/metrics";
import { saveConfig } from "../../src/core/config";
import type { RecordEvent } from "../../src/core/events";
import { candidatePath } from "../../src/core/paths";
import { hashInput } from "../../src/core/record";
import { readStatus, writeStatus } from "../../src/core/run";
import type { PhaseDeps } from "../../src/phases/frame";
import { runReflect, type ReflectDeps } from "../../src/phases/reflect";
import { setupLoop } from "../build/loop-fixture";

const GOOD: PlaybookDelta = {
  op: "edit", section: "build", id: "B1", text: "Keep one feature per fresh session; let the audit name what the next session needs.",
  why: "Failed attempts showed that inherited transcript context obscures recovery.", kind: "correction",
  evidence: [{ kind: "digest", ref: "Event counts" }, { kind: "metric", ref: "costByPhase.build" }, { kind: "file", ref: "spec.md" }],
};
const GOOD2: PlaybookDelta = { op: "add", section: "build", text: "Pick smaller features late in the phase when a budget stop would lose one.", why: "The recorded budget stop left the current feature unfinished.", kind: "correction", evidence: [{ kind: "metric", ref: "stopKind" }] };
const BAD: PlaybookDelta = { op: "add", section: "build", text: "x", evidence: [{ kind: "digest", ref: "Nope" }] };
const USAGE = { input: 1_000, output: 1_000 };
const CALL_COST = 0.018;

type Step = PlaybookDelta | PlaybookDelta[] | "text" | "error";

function reflector(script: Step[]) {
  let index = 0;
  return createMockModel({ id: "reflector", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, handler: () => {
    const step = script[Math.min(index++, script.length - 1)] ?? "text";
    if (step === "error") return { content: [], stopReason: "error" as const, errorMessage: "boom" };
    if (step === "text") return { content: ["no lesson"], usage: USAGE };
    const deltas = Array.isArray(step) ? step : [step];
    return { content: deltas.map((delta) => ({ type: "toolCall" as const, name: "playbook_delta", arguments: delta })), usage: USAGE };
  } } as never);
}

const builderCall = (costUsd: number): RecordEvent => ({ t: "model.call", role: "builder", provider: "p", model: "m", inputHash: "h", usage: { input: 2_000, output: 500, cacheRead: 100, cacheWrite: 50 }, costUsd, stopReason: "stop", excerpt: "" });

function setup(script: Step[], options: { usd?: number; spend?: number; now?: () => number } = {}) {
  const s = setupLoop();
  const model = reflector(script);
  s.deps.cfg.budgets.usd = options.usd ?? 25; saveConfig(s.home, s.deps.cfg);
  s.record.append({ t: "phase.start", phase: "build" });
  s.record.append(builderCall(options.spend ?? 1.5));
  const deps: ReflectDeps = { ...s.deps, now: options.now, models: (role) => role === "reflector" ? { model: model as never, ref: "mock/reflector" } : s.deps.models(role) };
  const metrics = () => JSON.parse(readFileSync(s.deps.run.metrics, "utf8")) as Metrics;
  const events = () => s.record.read();
  return { ...s, deps, model, metrics, events, candidate: candidatePath(s.home, s.deps.run.id) };
}

describe("runReflect context", () => {
  test("refuses held-out runs before a model or candidate can be created", async () => {
    const s = setup([GOOD]);
    writeStatus(s.deps.run, { seed: { id: "heldout-product-01", split: "heldout", sha256: "a".repeat(64) } });
    const result = await runReflect(s.deps);
    expect(result).toMatchObject({ outcome: "failed", failureClass: "policy" });
    expect(s.model.calls).toHaveLength(0);
    expect(existsSync(candidatePath(s.deps.home, s.deps.run.id))).toBe(false);
  });

  test("pins only the digest, bundle, whole playbook and metrics, and offers exactly the playbook_delta tool", async () => {
    const s = setup([GOOD]);
    s.record.append({ t: "note", text: "SENTINEL_RECORD" });
    mkdirSync(join(s.home, "evals", "seeds"), { recursive: true }); writeFileSync(join(s.home, "evals", "seeds", "s.md"), "SENTINEL_EVALS\n");
    writeFileSync(join(s.home, "prompts", "builder.md"), "SENTINEL_PROMPT\n");
    buildStop(s.deps, "budget");
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(s.model.calls).toHaveLength(1);
    const ctx = s.model.calls[0]!.context;
    expect((ctx.tools ?? []).map((tool) => tool.name)).toEqual(["playbook_delta"]);
    expect(ctx.systemPrompt).toHaveLength(3);
    expect(ctx.systemPrompt![0]).toBe(loadPrompt(s.home, "kernel"));
    expect(ctx.systemPrompt![1]).toBe(loadPrompt(s.home, "reflector"));
    const pinned = ctx.systemPrompt![2]!;
    const everything = [...ctx.systemPrompt!, JSON.stringify(ctx.messages)].join("\n");
    expect(pinned).toContain("## Event counts");
    expect(pinned).toContain("## spec.md");
    expect(pinned).toContain("A working artifact.");
    expect(pinned).toContain(loadPlaybook(s.home).trim());
    expect(pinned).toContain('"costByPhase"');
    for (const sentinel of ["SENTINEL_RECORD", "SENTINEL_EVALS", "SENTINEL_PROMPT"]) expect(everything).not.toContain(sentinel);
    expect(everything.toLowerCase()).not.toMatch(/turns? left|remaining budget|budget remaining/);
  });
});

describe("runReflect digest and candidate", () => {
  test("candidate hash ignores counters and retains rationale metadata", async () => {
    const proposal = { ...GOOD, why: "Repeated checks exposed the missing constraint.", kind: "correction" };
    const first = setup([proposal]);
    const second = setup([proposal]);
    const playbook = loadPlaybook(first.home);
    writeFileSync(join(second.home, "playbook", "playbook.md"), playbook.replace(/helpful:\d+ harmful:\d+/g, "helpful:99 harmful:7"));
    for (const s of [first, second]) {
      buildStop(s.deps, "budget");
      expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
      expect(JSON.parse(readFileSync(s.candidate, "utf8")).delta).toEqual(proposal);
    }
    expect(JSON.parse(readFileSync(first.candidate, "utf8")).playbookHash)
      .toBe(JSON.parse(readFileSync(second.candidate, "utf8")).playbookHash);
  });

  test("writes the digest and its typed event, then the candidate with every field on an accepted delta", async () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const s = setup([GOOD], { now: () => now });
    buildStop(s.deps, "budget");
    let cursorDuring: string | undefined;
    s.deps.onTool = (event) => { if (event.phase === "start") cursorDuring = readStatus(s.deps.run).cursor?.step; };
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(cursorDuring).toBe("reflect");
    const events = s.events();
    const digest = events.find((event) => event.t === "digest");
    expect(digest).toMatchObject({ t: "digest", hash: hashInput(readFileSync(s.deps.run.digest, "utf8")), bytes: Buffer.byteLength(readFileSync(s.deps.run.digest, "utf8")), truncated: false });
    const start = events.findLast((event) => event.t === "phase.start" && event.phase === "reflect")!;
    const call = events.find((event) => event.t === "model.call" && event.role === "reflector")!;
    expect(start.seq).toBeLessThan(digest!.seq);
    expect(start.seq).toBeLessThan(call.seq);
    expect(call).toMatchObject({ usage: { input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, costUsd: expect.closeTo(CALL_COST, 6) });
    expect(events.filter((event) => event.t === "tool.call")).toMatchObject([{ name: "playbook_delta", ok: true }]);
    expect(events.filter((event) => event.t === "delta")).toEqual([expect.objectContaining({ op: "edit", section: "build", id: "B1", accepted: true })]);
    expect(events.at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "ok" });
    expect(JSON.parse(readFileSync(s.candidate, "utf8"))).toEqual({
      runId: s.deps.run.id, digestHash: (digest as { hash: string }).hash, playbookHash: hashInput(stripCounters(loadPlaybook(s.home))),
      reflectorModelRef: "mock/reflector", delta: GOOD, createdAt: "2026-09-04T12:00:00.000Z",
    });
  });

  test("records a rejected delta with its reason, writes no candidate, and tells the model why", async () => {
    const s = setup([BAD, "text"]);
    buildStop(s.deps, "budget");
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(existsSync(s.candidate)).toBe(false);
    expect(s.events().filter((event) => event.t === "delta")).toEqual([expect.objectContaining({ op: "add", section: "build", accepted: false, reason: expect.stringContaining('digest ref "Nope"') })]);
    expect(s.events().filter((event) => event.t === "tool.call")).toMatchObject([{ name: "playbook_delta", ok: false, excerpt: expect.stringContaining("error:") }]);
    expect(s.model.calls).toHaveLength(2);
    expect(JSON.stringify(s.model.calls[1]!.context.messages.at(-1))).toContain('digest ref \\"Nope\\"');
    expect(s.metrics().deltaProposed).toEqual({ accepted: 0, rejected: 1 });
  });

  test("only the first accepted delta of a turn counts; a second call in the same turn is rejected and recorded", async () => {
    const s = setup([[GOOD, GOOD2]]);
    buildStop(s.deps, "budget");
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(s.model.calls).toHaveLength(1);
    expect(s.events().filter((event) => event.t === "delta")).toEqual([
      expect.objectContaining({ op: "edit", section: "build", id: "B1", accepted: true }),
      expect.objectContaining({ op: "add", section: "build", accepted: false, reason: "a delta was already accepted" }),
    ]);
    expect(s.events().filter((event) => event.t === "tool.call").map((event) => (event as { ok: boolean }).ok)).toEqual([true, false]);
    expect(JSON.parse(readFileSync(s.candidate, "utf8")).delta).toEqual(GOOD);
    expect(s.metrics().deltaProposed).toEqual({ accepted: 1, rejected: 1 });
  });

  test("returns ok without a delta when the reflector proposes nothing", async () => {
    const s = setup(["text"]);
    buildHonest(s.deps, ["cannot"]);
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(existsSync(s.candidate)).toBe(false);
    expect(s.events().some((event) => event.t === "delta")).toBe(false);
    expect(s.metrics().deltaProposed).toEqual({ accepted: 0, rejected: 0 });
  });
});

describe("runReflect metrics", () => {
  test("rewrites metrics after reflect so the reflector's spend and usage land in totals", async () => {
    const s = setup([GOOD]);
    buildStop(s.deps, "deadline");
    const before = s.metrics();
    expect(before.costByPhase.reflect).toBe(0);
    await runReflect(s.deps);
    const after = s.metrics();
    expect(after.costByPhase.reflect).toBeCloseTo(CALL_COST, 6);
    expect(after.costByRole.reflector).toBeCloseTo(CALL_COST, 6);
    expect(after.costUsd - before.costUsd).toBeCloseTo(CALL_COST, 6);
    expect(after.modelCalls).toBe(before.modelCalls + 1);
    expect(after.tokensByRole.reflector).toEqual({ input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 });
    expect(after.tokensByRole.builder).toEqual({ input: 2_000, output: 500, cacheRead: 100, cacheWrite: 50 });
    expect(after.deltaProposed).toEqual({ accepted: 1, rejected: 0 });
    expect(after.digestTruncated).toBe(false);
    expect(after.wallByPhase.reflect).toBeGreaterThanOrEqual(0);
    expect(after.stopKind).toBe("deadline");
    expect(after.censored).toBe(true);
  });

  test("runs on a zero or negative nominal remainder using the protected minimum and records the overshoot", async () => {
    const zero = setup([GOOD], { usd: 1.5, spend: 1.5 });
    buildStop(zero.deps, "budget");
    expect(zero.metrics().budgetOvershootUsd).toBe(0);
    expect(await runReflect(zero.deps)).toEqual({ outcome: "ok" });
    expect(existsSync(zero.candidate)).toBe(true);
    expect(zero.metrics().budgetOvershootUsd).toBeCloseTo(CALL_COST, 6);

    const negative = setup([GOOD], { usd: 1, spend: 1.5 });
    buildStop(negative.deps, "budget");
    expect(negative.metrics().budgetOvershootUsd).toBeCloseTo(0.5, 6);
    expect(await runReflect(negative.deps)).toEqual({ outcome: "ok" });
    expect(existsSync(negative.candidate)).toBe(true);
    expect(negative.metrics().budgetOvershootUsd).toBeCloseTo(0.5 + CALL_COST, 6);
    expect(readStatus(negative.deps.run)).toMatchObject({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: 1 } });
  });

  test("the reflect cap is the protected minimum, not the exhausted remainder, and a cap hit keeps the build's status", async () => {
    const capped = setup([BAD, GOOD], { usd: 1, spend: 1.5 });
    buildFail(capped.deps, "integrity", "acceptance lock mismatch");
    expect(await runReflect(capped.deps)).toMatchObject({ outcome: "failed", failureClass: "budget" });
    expect(capped.model.calls).toHaveLength(1);
    expect(existsSync(capped.candidate)).toBe(false);
    expect(capped.events().filter((event) => event.t === "delta")).toMatchObject([{ accepted: false }]);
    expect(capped.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "failed" });
    expect(capped.events().at(-2)).toMatchObject({ t: "failure", class: "budget" });
    expect(readStatus(capped.deps.run)).toMatchObject({ phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "integrity", message: "acceptance lock mismatch" }, cursor: { step: "reflected" } });
    expect(capped.metrics().costByPhase.reflect).toBeCloseTo(CALL_COST, 6);

    const roomy = setup([BAD, GOOD], { usd: 25, spend: 1.5 });
    buildFail(roomy.deps, "integrity", "acceptance lock mismatch");
    expect(await runReflect(roomy.deps)).toEqual({ outcome: "ok" });
    expect(roomy.model.calls).toHaveLength(2);
    expect(existsSync(roomy.candidate)).toBe(true);
  });
});

describe("runReflect status contract", () => {
  const terminal: Array<[string, (deps: PhaseDeps) => unknown, Record<string, unknown>]> = [
    ["stopped/budget", (deps) => buildStop(deps, "budget"), { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: 25, wallTargetSeconds: 14_400 } }],
    ["stopped/deadline", (deps) => buildStop(deps, "deadline"), { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "deadline", budgetTargetUsd: 25, wallTargetSeconds: 14_400 } }],
    ["failed/integrity", (deps) => buildFail(deps, "integrity", "acceptance lock mismatch"), { phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "integrity", message: "acceptance lock mismatch" } }],
    ["done/honest_exit", (deps) => buildHonest(deps, ["cannot"]), { phase: "build", state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied", reasons: ["cannot"] } }],
    ["success", (deps) => buildSuccess(deps), { phase: "reflect", state: "done", outcome: { kind: "success" } }],
  ];

  test.each(terminal)("reflects after %s and leaves the build's routing keys as the build left them", async (_name, finish, expected) => {
    const s = setup([GOOD]);
    finish(s.deps);
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(readStatus(s.deps.run)).toMatchObject({ ...expected, cursor: { step: "reflected" } });
    expect(readStatus(s.deps.run).pausedReason).toBeUndefined();
    expect(readStatus(s.deps.run).wakeAt).toBeUndefined();
    expect(s.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "ok" });
    expect(existsSync(s.candidate)).toBe(true);
  });

  test("a reflect failure after an honest exit leaves the run done/honest_exit, not failed", async () => {
    const s = setup(["error"]);
    buildHonest(s.deps, ["cannot"]);
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed", message: "boom" });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "build", state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied" }, cursor: { step: "reflected" } });
    expect(s.events().at(-2)).toMatchObject({ t: "failure", message: "boom" });
    expect(s.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "failed" });
    expect(existsSync(s.candidate)).toBe(false);
  });

  test("a reflect failure on the success path still closes the run as done/success", async () => {
    const s = setup(["error"]);
    buildSuccess(s.deps);
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed", message: "boom" });
    expect(s.events().at(-2)).toMatchObject({ t: "failure", message: "boom" });
    expect(s.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "failed" });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" }, cursor: { step: "reflected" } });
  });

  test("a changed idea shape on the success path fails reflect and still closes the run as done/success", async () => {
    const s = setup([GOOD]);
    buildSuccess(s.deps);
    writeStatus(s.deps.run, { shapeHash: "not-the-brief" });
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(s.events().at(-1)).toMatchObject({ t: "failure", class: "integrity" });
    expect(s.model.calls).toHaveLength(0);
  });

  test("a throw after phase.start is recorded as a failure, ends the phase, and closes the run on the success path", async () => {
    const corrupt = (home: string) => { rmSync(join(home, "playbook", "playbook.md")); mkdirSync(join(home, "playbook", "playbook.md")); };
    const s = setup([GOOD]);
    buildSuccess(s.deps); corrupt(s.home);
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed", failureClass: "verify", message: expect.stringContaining("EISDIR") });
    expect(s.events().at(-2)).toMatchObject({ t: "failure", class: "verify", message: expect.stringContaining("EISDIR") });
    expect(s.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "failed" });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" }, cursor: { step: "reflected" } });
    expect(s.model.calls).toHaveLength(0);
    expect(existsSync(s.candidate)).toBe(false);
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });

    const stopped = setup([GOOD]);
    buildStop(stopped.deps, "budget"); corrupt(stopped.home);
    expect(await runReflect(stopped.deps)).toMatchObject({ outcome: "failed", failureClass: "verify" });
    expect(stopped.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "failed" });
    expect(readStatus(stopped.deps.run)).toMatchObject({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget" }, cursor: { step: "reflected" } });
  });

  test("a zero wall minimum with the wall exhausted fails reflect as a deadline before any model call", async () => {
    const s = setup([GOOD]);
    s.deps.cfg.budgets.wallSeconds = 0; s.deps.cfg.budgets.share = { ...s.deps.cfg.budgets.share, frame: 0.025, reflect: 0 }; saveConfig(s.home, s.deps.cfg);
    buildStop(s.deps, "budget");
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed", failureClass: "deadline" });
    expect(s.model.calls).toHaveLength(0);
    expect(existsSync(s.deps.run.digest)).toBe(false);
    expect(s.events().at(-2)).toMatchObject({ t: "failure", class: "deadline" });
    expect(s.events().at(-1)).toMatchObject({ t: "phase.end", phase: "reflect", outcome: "failed" });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget" }, cursor: { step: "reflected" } });
  });

  test("a changed idea shape fails reflect without disturbing the build's terminal status", async () => {
    const s = setup([GOOD]);
    buildStop(s.deps, "budget");
    writeStatus(s.deps.run, { shapeHash: "not-the-brief" });
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed", failureClass: "integrity" });
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget" } });
    expect(s.events().at(-1)).toMatchObject({ t: "failure", class: "integrity" });
    expect(s.model.calls).toHaveLength(0);
    expect(existsSync(s.deps.run.digest)).toBe(false);
  });
});

describe("runReflect idempotency", () => {
  test("repairs status when a kill follows phase.end without another provider call", async () => {
    const s = setup([GOOD]);
    buildSuccess(s.deps);
    s.record.append({ t: "phase.start", phase: "reflect" });
    s.record.append({ t: "phase.end", phase: "reflect", outcome: "ok" });
    writeStatus(s.deps.run, { cursor: { step: "reflect" } });
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(readStatus(s.deps.run)).toMatchObject({ state: "done", outcome: { kind: "success" }, cursor: { step: "reflected" } });
    expect(s.model.calls).toHaveLength(0);
    const stable = readFileSync(s.deps.run.status, "utf8");
    await runReflect(s.deps);
    expect(readFileSync(s.deps.run.status, "utf8")).toBe(stable);
  });
  test("a second call is a no-op until a later build terminal makes a new reflect legitimate", async () => {
    const s = setup([GOOD, GOOD2]);
    buildStop(s.deps, "budget");
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    const count = s.events().length; const digest = readFileSync(s.deps.run.digest, "utf8"); const status = readFileSync(s.deps.run.status, "utf8");
    const candidate = readFileSync(s.candidate, "utf8");
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(s.events()).toHaveLength(count);
    expect(s.model.calls).toHaveLength(1);
    expect(readFileSync(s.deps.run.digest, "utf8")).toBe(digest);
    expect(readFileSync(s.deps.run.status, "utf8")).toBe(status);
    expect(readFileSync(s.candidate, "utf8")).toBe(candidate);

    s.record.append({ t: "phase.start", phase: "build" });
    s.record.append(builderCall(0.5));
    buildSuccess(s.deps);
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(s.model.calls).toHaveLength(2);
    expect(s.events().filter((event) => event.t === "phase.end" && event.phase === "reflect")).toHaveLength(2);
    expect(JSON.parse(readFileSync(s.candidate, "utf8")).delta).toEqual(GOOD2);
    expect(readStatus(s.deps.run)).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" }, cursor: { step: "reflected" } });
  });

  test("a failed reflect also counts as reflected", async () => {
    const s = setup(["error", GOOD]);
    buildStop(s.deps, "budget");
    expect(await runReflect(s.deps)).toMatchObject({ outcome: "failed" });
    expect(await runReflect(s.deps)).toEqual({ outcome: "ok" });
    expect(s.model.calls).toHaveLength(1);
  });
});
