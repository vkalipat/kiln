import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { frameExitAcceptance, parseBrief, runFrame, stopFailure, type PhaseDeps } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { createRun, readStatus } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { initHome } from "../../src/core/home";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery";
const BRIEF = `# Brief\n\n## Problem\nBeekeepers lose hives to mites.\n\n## Constraints\n- solo developer\n\n## Search success\n- a novel monitoring approach\n\n## Non-goals\n- hardware\n\n## Shape\nproduct\n\n## Axes\n${AXES}\n\n## Discovery questions\n- What mite-monitoring products exist?\n- What has been tried and failed?\n`;
const BROAD_BRIEF = `# Brief

## Problem
Find a defensible, high-upside venture direction and produce an executable first artifact without claiming a guaranteed financial outcome.

## Constraints
- assume a capable generalist founder until evidence favors a specialist wedge
- prefer an initially capital-light path that can be falsified cheaply

## Search success
- credible evidence of a large or rapidly expanding value pool
- a painful unmet need with a reachable first buyer
- a differentiated wedge and a cheap demand test

## Non-goals
- guaranteeing wealth or market success
- committing irreversibly to an invented founder profile

## Shape
product

## Axes
- who it serves: business operators | scientific teams | healthcare organizations
- mechanism class: workflow software | data product | managed service
- where value appears: new revenue | avoided cost | faster decisions

## Discovery questions
- Which large value pools combine urgent demand with weak incumbent workflows?
- Which opportunities admit a cheap demand or feasibility test before major capital?
`;

function deps(responses: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
  const run = createRun(home, "an app for beekeepers"); const record = new RunRecord(run.record);
  const model = createMockModel({ id: "mock", responses: responses as never }) as unknown as Model;
  const cfg = defaultConfig();
  const d: PhaseDeps = { home, run, record, cfg, models: () => ({ model, ref: "mock/mock" }), apiKeyFor: async () => "k", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(2) };
  return d;
}

/** Swap in a differently scripted model without rebuilding the run directory. */
function useModel(d: PhaseDeps, model: unknown) {
  d.models = () => ({ model: model as Model, ref: "mock/mock" });
}

describe("parseBrief", () => {
  test("extracts sections, shape, questions, and axes with their values", () => {
    const b = parseBrief(BRIEF);
    expect(b.missing).toEqual([]); expect(b.shape).toBe("product"); expect(b.questions.length).toBe(2);
    expect(b.axes.map((a) => a.name)).toEqual(["who it serves", "mechanism class", "where the value shows up"]);
    expect(b.axes[0]!.values).toEqual(["hobbyists", "sideliners", "commercial"]);
  });
  test("reports missing sections", () => { expect(parseBrief("# Brief\n## Problem\nx").missing).toContain("Shape"); });
});

describe("stopFailure", () => {
  test("classifies from the structured status, not the message wording", () => {
    const r = stopFailure("frame", 10, { text: "", turns: 1, costUsd: 0, stopped: "error", error: "the server said no", errorStatus: 429 });
    expect(r?.outcome).toBe("failed");
    expect(r && r.outcome === "failed" ? r.failureClass : "").toBe("transient");
  });
  test("maps the turn-boundary dollar cap to budget", () => {
    const result = stopFailure("form", 30, { text: "", turns: 2, costUsd: 1.4, stopped: "usd_cap" });
    expect(result).toEqual({ outcome: "failed", failureClass: "budget", message: "dollar cap reached in form" });
  });
  test("maps a structured refusal to the refusal class and names its category", () => {
    const result = stopFailure("frame", 10, {
      text: "", turns: 1, costUsd: 0, stopped: "refused",
      stopDetails: { type: "refusal", category: "safety" },
    });
    expect(result).toEqual({ outcome: "failed", failureClass: "refusal", message: "model refused in frame: safety" });
  });
});

describe("frameExitAcceptance", () => {
  test("allows one correction for a nonempty underspecified seed but never delays safety exits", () => {
    expect(frameExitAcceptance("Find a major opportunity and ship it", "underspecified", 0)).toMatchObject({ accepted: false });
    expect(frameExitAcceptance("Find a major opportunity and ship it", "underspecified", 1)).toEqual({ accepted: true });
    expect(frameExitAcceptance("Find a major opportunity and ship it", "cannot_be_satisfied", 0)).toEqual({ accepted: true });
    expect(frameExitAcceptance("  ", "underspecified", 0)).toEqual({ accepted: true });
  });
});

describe("runFrame", () => {
  test("frames a broad commercial ambition into a bounded brief and advances", async () => {
    const d = deps([]);
    writeFileSync(d.run.seed, "Find an idea that will make me a billionaire and ship it.\n");
    const customKernel = "# operator kernel\n\nPreserve this initialized-home customization.\n";
    const customBrain = "# operator brain\n\nPreserve this role customization too.\n";
    writeFileSync(join(d.home, "prompts", "kernel.md"), customKernel);
    writeFileSync(join(d.home, "prompts", "brain.md"), customBrain);
    const model = createMockModel({
      id: "mock",
      handler: async (ctx: unknown) => {
        const contract = JSON.stringify(ctx);
        if (!contract.includes("A nonempty broad goal is actionable")) {
          return { content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["no founder profile", "no domain"] } }] };
        }
        if (existsSync(d.run.brief)) return { content: ["brief written"] };
        return { content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BROAD_BRIEF } }] };
      },
    } as never);
    useModel(d, model);

    const result = await runFrame(d);

    expect(result).toEqual({ outcome: "ok" });
    expect(readStatus(d.run)).toMatchObject({ phase: "discover", state: "running", shape: "product" });
    expect(readFileSync(d.run.brief, "utf8")).toContain("without claiming a guaranteed financial outcome");
    expect(readFileSync(join(d.home, "prompts", "kernel.md"), "utf8")).toBe(customKernel);
    expect(readFileSync(join(d.home, "prompts", "brain.md"), "utf8")).toBe(customBrain);
    expect(model.calls).toHaveLength(2);
    expect(d.record.read().some((event) => event.t === "tool.call" && event.name === "write" && event.ok)).toBe(true);
  });

  test("corrects one premature underspecified exit without recording a false outcome", async () => {
    const d = deps([]);
    writeFileSync(d.run.seed, "Find an idea that will make me a billionaire and ship it.\n");
    const model = createMockModel({ id: "mock", responses: [
      { content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["no founder profile", "no domain"] } }] },
      { content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BRIEF } }] },
      { content: ["brief written"] },
    ] as never });
    useModel(d, model);

    const result = await runFrame(d);

    expect(result).toEqual({ outcome: "ok" });
    expect(model.calls).toHaveLength(3);
    expect(d.record.read().filter((event) => event.t === "honest_exit")).toHaveLength(0);
    expect(d.record.read().find((event) => event.t === "tool.call" && event.name === "exit")).toMatchObject({ ok: false });
  });

  test("still accepts an immediate safety exit for a request with no safe artifact", async () => {
    const d = deps([]);
    const model = createMockModel({ id: "mock", responses: [{ content: [{
      type: "toolCall", name: "exit", arguments: {
        kind: "cannot_be_satisfied",
        reasons: ["the requested artifact would require unsafe operational biological instructions"],
      },
    }] }] as never });
    useModel(d, model);

    const result = await runFrame(d);

    expect(result).toMatchObject({ outcome: "honest_exit", kind: "cannot_be_satisfied" });
    expect(model.calls).toHaveLength(1);
    expect(readStatus(d.run)).toMatchObject({ state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied" } });
  });

  test("writes brief through the write tool, records the shape, and advances the phase", async () => {
    const d = deps([]);
    useModel(d, createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BRIEF } }] }, { content: ["brief written"] }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("ok"); expect(readFileSync(d.run.brief, "utf8")).toBe(BRIEF); expect(readStatus(d.run).phase).toBe("discover");
    expect(readStatus(d.run).shape).toBe("product");
    expect(readStatus(d.run).shapeHash).toBe(shapeHash(parseBrief(BRIEF)));
    expect(d.record.read().some((e) => e.t === "phase.end" && e.phase === "frame")).toBe(true);
  });
  test("re-prompts once on missing sections, then fails", async () => {
    const d = deps([]);
    useModel(d, createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: "# Brief\n## Problem\nx" } }] }, { content: ["done"] }, { content: ["still done"] }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed"); if (r.outcome === "failed") expect(r.failureClass).toBe("verify");
  });
  test("a brief whose axes have no values is a verify failure after one re-ask", async () => {
    const d = deps([]);
    const bare = BRIEF.replace(AXES, "- who it serves\n- mechanism class\n- where the value shows up");
    useModel(d, createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: bare } }] }, { content: ["done"] }, { content: ["still done"] }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("verify"); expect(r.message).toMatch(/3 to 6/); }
    expect(readStatus(d.run).shape).toBeUndefined();
  });
  test("an unknown shape is rejected", async () => {
    const d = deps([]);
    const odd = BRIEF.replace("## Shape\nproduct", "## Shape\nstartup");
    useModel(d, createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: odd } }] }, { content: ["done"] }, { content: ["still done"] }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.message).toMatch(/research, product, creative/);
  });
  test("honest exit is returned as such", async () => {
    const d = deps([]);
    const model = createMockModel({ id: "mock", responses: [
      { content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["no domain given"] } }] },
      { content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["a decisive fact remains unavailable"] } }] },
    ] as never });
    useModel(d, model);
    const r = await runFrame(d);
    expect(r.outcome).toBe("honest_exit"); if (r.outcome === "honest_exit") expect(r.kind).toBe("underspecified");
    expect(model.calls).toHaveLength(2);
    expect(d.record.read().filter((event) => event.t === "honest_exit")).toHaveLength(1);
    expect(readStatus(d.run).state).toBe("done");
  });
  test("exhausting the turn cap is a budget failure with no corrective re-prompt", async () => {
    const d = deps([]);
    d.cfg.budgets.turns.frame = 3;
    const model = createMockModel({ id: "mock", handler: async () => ({ content: [{ type: "toolCall", name: "note", arguments: { text: "again" } }] }) } as never);
    useModel(d, model);
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("budget"); expect(r.message).toBe("turn cap 3 reached in frame"); }
    const events = d.record.read();
    expect(events.filter((e) => e.t === "phase.start").length).toBe(1);
    // The corrective "rewrite the whole file" prompt must not run after a cap. The pre-model gate
    // refuses the fourth dispatch, so provider and journal both stop after three turns.
    expect(events.filter((e) => e.t === "model.call").length).toBe(3);
    expect(model.calls.length).toBe(3);
    expect(readStatus(d.run).state).toBe("failed");
    expect(readStatus(d.run).outcome?.failureClass).toBe("budget");
  });
  test("a valid brief written on the final allowed turn completes without another provider call", async () => {
    const d = deps([]); d.cfg.budgets.turns.frame = 1;
    const model = createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BRIEF } }] }] as never });
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "ok" });
    expect(model.calls).toHaveLength(1);
    expect(readStatus(d.run)).toMatchObject({ phase: "discover", shape: "product" });
  });
  test("terminal status carries the frame journal's actual cost", async () => {
    const d = deps([]); d.cfg.budgets.turns.frame = 1;
    const model = createMockModel({
      id: "paid", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BRIEF } }], usage: { input: 1_000_000, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } }] as never,
    });
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "ok" });
    expect(d.record.costUsd()).toBeCloseTo(1);
    expect(readStatus(d.run).usdSpent).toBeCloseTo(d.record.costUsd());
  });
  test("an exhausted run target stops before frame dispatch and records the target", async () => {
    const d = deps([]); d.cfg.budgets.usd = 0;
    const model = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 0 });
    expect(model.calls).toHaveLength(0);
    expect(readStatus(d.run)).toMatchObject({ phase: "frame", state: "stopped", outcome: { stopKind: "budget", budgetTargetUsd: 0 } });
  });
  test("an exhausted wall target stops before frame dispatch", async () => {
    const d = deps([]); d.cfg.budgets.wallSeconds = 0;
    const model = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0 });
    expect(model.calls).toHaveLength(0);
    expect(readStatus(d.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0 } });
  });
  test("frame aborts an in-flight provider call at the remaining run wall deadline", async () => {
    const d = deps([]); d.cfg.budgets.wallSeconds = 0.03;
    const model = createMockModel({ id: "slow", handler: async () => ({ delayMs: 5_000, content: ["late"] }) } as never);
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0.03 });
    expect(model.calls).toHaveLength(1);
    expect(readStatus(d.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0.03 } });
  });
  test("a crossing frame turn may finish but the next corrective dispatch is blocked by the run target", async () => {
    const d = deps([]); d.cfg.budgets.usd = 1;
    const model = createMockModel({
      id: "crossing", cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
      handler: async () => {
        writeFileSync(d.run.brief, "invalid");
        return { content: ["invalid draft written"], usage: { input: 1_000_000, cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } } };
      },
    });
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 1 });
    expect(model.calls).toHaveLength(1);
    expect(d.record.costUsd()).toBeCloseTo(2);
  });
  test("a contract-valid brief from a crossing dollar-cap turn is accepted without another call", async () => {
    const d = deps([]); d.cfg.budgets.usd = 1;
    const model = createMockModel({
      id: "crossing-valid", cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
      responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BRIEF } }], usage: { input: 1_000_000, cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } } }] as never,
    });
    useModel(d, model);
    expect(await runFrame(d)).toMatchObject({ outcome: "ok" });
    expect(model.calls).toHaveLength(1); expect(d.record.costUsd()).toBeCloseTo(2);
  });
  test("a model error is classified, not hardcoded transient", async () => {
    const d = deps([]);
    useModel(d, createMockModel({ id: "mock", responses: [{ throw: "policy: refused" }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("policy"); expect(r.message).toContain("policy: refused"); }
  });
  test("a rate-limit error still classifies as transient", async () => {
    const d = deps([]);
    const model = createMockModel({ id: "mock", responses: [{ throw: "rate limit exceeded" }] as never });
    useModel(d, model);
    const r = await runFrame(d);
    expect(r).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(model.calls).toHaveLength(1);
    expect(readStatus(d.run)).toMatchObject({ phase: "frame", state: "stopped", outcome: { stopKind: "transient", message: expect.stringContaining("rate limit") } });
  });
  test("a resumed frame shares its durable turn cap while accepting a valid final-turn brief", async () => {
    const d = deps([]); d.cfg.budgets.turns.frame = 2;
    const first = createMockModel({ id: "first", handler: async () => ({ throw: "rate limit exceeded" }) } as never);
    useModel(d, first);
    expect(await runFrame(d)).toMatchObject({ outcome: "stopped", stopKind: "transient" });

    const resumed = createMockModel({ id: "resumed", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: d.run.brief, content: BRIEF } }] }] as never });
    useModel(d, resumed);
    expect(await runFrame(d)).toMatchObject({ outcome: "ok" });
    expect(resumed.calls).toHaveLength(1);
    expect(d.record.read().filter((event) => event.t === "turn" && event.phase === "frame" && event.role === "brain")).toHaveLength(2);
  });
});
