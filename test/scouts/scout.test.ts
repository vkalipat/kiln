import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { runScout } from "../../src/scouts/scout";
import { scoutTools, type ToolContext } from "../../src/brain/tools";
import { defaultConfig } from "../../src/core/config";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";

const cfg = defaultConfig();

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record };
  return { home, run, record, ctx };
}

describe("runScout", () => {
  test("returns capped findings and records the call", async () => {
    const { home, run, record, ctx } = setup();
    const model = createMockModel({ id: "mock-scout", responses: [{ content: ["- fact one (https://a)\n" + "x".repeat(7000)] }] as never });
    const r = await runScout({ question: "what exists?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id, streamFn: streamMock as never });
    expect(r.findings.startsWith("- fact one")).toBe(true); expect(r.findings.length).toBeLessThanOrEqual(6000);
    expect(r.stopped).toBe("done"); expect(r.error).toBeUndefined(); expect(r.searchHealth).toEqual([]);
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "scout").length).toBe(1);
  });

  test("returns only the network-search health collected for this scout", async () => {
    const { home, run, record, ctx } = setup();
    const health = ["blocked", "ok"] as const;
    const model = createMockModel({ id: "mock-scout", responses: [{ content: ["done"] }] as never });
    const r = await runScout({
      question: "q?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id,
      searchHealth: [...health], streamFn: streamMock as never,
    });
    expect(r.searchHealth).toEqual(["blocked", "ok"]);
    health satisfies readonly (typeof r.searchHealth)[number][];
  });

  test("a looping scout is stopped at the default 20-turn cap", async () => {
    const { home, run, record, ctx } = setup();
    const model = createMockModel({ id: "mock-scout", handler: async () => ({ content: [{ type: "toolCall", name: "search", arguments: { pattern: "x" } }] }) } as never);
    const r = await runScout({ question: "loop?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id, streamFn: streamMock as never });
    expect(r.stopped).toBe("turn_cap");
    // The pre-model gate refuses turn 21 before it opens, so provider and journal both stop at 20.
    expect(r.turns).toBe(20);
    expect(model.calls).toHaveLength(20);
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "scout").length).toBe(20);
  });

  test("an explicit turnCap overrides the default", async () => {
    const { home, run, record, ctx } = setup();
    const model = createMockModel({ id: "mock-scout", handler: async () => ({ content: [{ type: "toolCall", name: "search", arguments: { pattern: "x" } }] }) } as never);
    const r = await runScout({ question: "loop?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id, turnCap: 3, streamFn: streamMock as never });
    expect(r.stopped).toBe("turn_cap");
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "scout").length).toBe(3);
  });

  test("a failing scout reports stopped=error with the provider message", async () => {
    const { home, run, record, ctx } = setup();
    const model = createMockModel({ id: "mock-scout", responses: [{ throw: "boom" }] as never });
    const r = await runScout({ question: "q?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id, streamFn: streamMock as never });
    expect(r.stopped).toBe("error"); expect(r.error).toContain("boom"); expect(r.findings).toBe("");
  });

  test("propagates structured refusal details to the caller", async () => {
    const { home, run, record, ctx } = setup();
    const model = createMockModel({ id: "mock-scout", responses: [{
      stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" },
    }] as never });
    const r = await runScout({ question: "q?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id, streamFn: streamMock as never });
    expect(r).toMatchObject({ stopped: "refused", stopDetails: { type: "refusal", category: "safety" }, findings: "" });
  });

  test("an explicit role, phase, and role effort override are what the journal records", async () => {
    const { home, run, record, ctx } = setup();
    const model = Object.assign(createMockModel({ id: "mock-scout", responses: [{ content: ["- a prior-art finding"] }] as never }), {
      thinking: { mode: "effort" as const, efforts: ["low", "medium", "high"] as const },
    });
    const configured = { ...cfg, effortByRole: { ...cfg.effortByRole, arbiter: "medium" as const } };
    const r = await runScout({ question: "has this been done?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg: configured, runId: run.id, role: "arbiter", phase: "ideate", turnCap: 6, streamFn: streamMock as never });
    expect(r.stopped).toBe("done");
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "arbiter" && e.effort === "medium").length).toBe(1);
    expect(record.read().filter((e) => e.t === "turn" && e.role === "arbiter" && e.phase === "ideate").length).toBe(1);
  });

  test("role and phase default to a discover-phase scout", async () => {
    const { home, run, record, ctx } = setup();
    const model = createMockModel({ id: "mock-scout", responses: [{ content: ["- x"] }] as never });
    await runScout({ question: "q?", brief: "brief", model: model as never, tools: scoutTools(ctx), record, home, cfg, runId: run.id, streamFn: streamMock as never });
    expect(record.read().some((e) => e.t === "turn" && e.role === "scout" && e.phase === "discover")).toBe(true);
  });
});
