import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { parseBrief, runFrame, stopFailure, type PhaseDeps } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { createRun, readStatus } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { initHome } from "../../src/core/home";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery";
const BRIEF = `# Brief\n\n## Problem\nBeekeepers lose hives to mites.\n\n## Constraints\n- solo developer\n\n## Search success\n- a novel monitoring approach\n\n## Non-goals\n- hardware\n\n## Shape\nproduct\n\n## Axes\n${AXES}\n\n## Discovery questions\n- What mite-monitoring products exist?\n- What has been tried and failed?\n`;

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

describe("runFrame", () => {
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
    useModel(d, createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["no domain given"] } }] }, { content: ["exited"] }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("honest_exit"); if (r.outcome === "honest_exit") expect(r.kind).toBe("underspecified");
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
  test("a model error is classified, not hardcoded transient", async () => {
    const d = deps([]);
    useModel(d, createMockModel({ id: "mock", responses: [{ throw: "policy: refused" }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("policy"); expect(r.message).toContain("policy: refused"); }
  });
  test("a rate-limit error still classifies as transient", async () => {
    const d = deps([]);
    useModel(d, createMockModel({ id: "mock", responses: [{ throw: "rate limit exceeded" }] as never }));
    const r = await runFrame(d);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.failureClass).toBe("transient");
  });
});
