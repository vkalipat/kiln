import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../../src/brain/agent";
import { brainTools, type ToolContext } from "../../src/brain/tools";
import { defaultConfig } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { createRun } from "../../src/core/run";

function fixture(
  responses: unknown[],
  options: {
    effort?: string;
    getApiKey?: () => Promise<string | undefined>;
    model?: Record<string, unknown>;
    streamFn?: StreamFn;
    usdCap?: number;
    signal?: AbortSignal;
    finalizeWithoutTools?: () => boolean;
    turnCap?: number;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "kiln-brain-hardening-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record };
  const model = createMockModel({ id: "mock-brain", responses: responses as never, ...options.model });
  if (options.model?.thinking !== undefined) Object.assign(model, { thinking: options.model.thinking });
  const cfg = defaultConfig();
  const brain = createBrain({
    model: model as never,
    tools: brainTools(ctx, "frame"),
    systemPrompt: ["kernel"],
    pinned: "contract",
    record,
    role: "brain",
    phase: "frame",
    turnCap: options.turnCap ?? 5,
    usdCap: options.usdCap,
    signal: options.signal,
    finalizeWithoutTools: options.finalizeWithoutTools,
    effort: options.effort,
    getApiKey: options.getApiKey,
    streamFn: options.streamFn ?? streamMock as never,
    shaping: { cfg, runId: run.id },
  });
  return { brain, model, record };
}

const calls = (record: RunRecord) => record.read().filter((event) => event.t === "model.call");

describe("brain execution hardening", () => {
  test("cancellation interrupts a credential resolver that never settles", async () => {
    let resolverStarted = false;
    let releaseResolver!: () => void;
    const hangingCredential = new Promise<string | undefined>((resolve) => {
      releaseResolver = () => resolve(undefined);
    });
    const { brain, model } = fixture([{ content: ["must not dispatch"] }], {
      getApiKey: async () => {
        resolverStarted = true;
        return hangingCredential;
      },
    });
    const control = new RunControl();
    const pending = withRunControl(control, () => brain.run("go"));
    while (!resolverStarted) await Bun.sleep(1);

    control.cancel("operator stop during auth");
    const outcome = await Promise.race([
      pending.then(() => "resolved", (error) => error instanceof RunCancelledError ? "cancelled" : "rejected"),
      Bun.sleep(100).then(() => "timed_out"),
    ]);
    releaseResolver();
    await pending.catch(() => undefined);

    expect(outcome).toBe("cancelled");
    expect(model.calls).toHaveLength(0);
    const recovered = await brain.run("retry");
    expect(recovered.text).toBe("must not dispatch");
    expect(model.calls).toHaveLength(1);
  });

  test("a pre-aborted phase signal preserves its reason and never starts auth or dispatch", async () => {
    const deadline = new AbortController();
    const reason = new Error("phase wall deadline reached");
    deadline.abort(reason);
    let authCalls = 0;
    const { brain, model } = fixture([{ content: ["must not dispatch"] }], {
      signal: deadline.signal,
      getApiKey: async () => {
        authCalls += 1;
        return undefined;
      },
    });

    await expect(brain.run("go")).rejects.toBe(reason);
    expect(authCalls).toBe(0);
    expect(model.calls).toHaveLength(0);
  });

  test("an in-flight phase signal interrupts credential resolution before dispatch", async () => {
    const deadline = new AbortController();
    const reason = new Error("phase deadline during auth");
    let resolverStarted = false;
    let releaseResolver!: () => void;
    const hangingCredential = new Promise<string | undefined>((resolve) => {
      releaseResolver = () => resolve(undefined);
    });
    const { brain, model } = fixture([{ content: ["must not dispatch"] }], {
      signal: deadline.signal,
      getApiKey: async () => {
        resolverStarted = true;
        return hangingCredential;
      },
    });
    const pending = brain.run("go");
    while (!resolverStarted) await Bun.sleep(1);

    deadline.abort(reason);
    const outcome = await Promise.race([
      pending.then(() => "resolved", (error) => error === reason ? "deadline" : "rejected"),
      Bun.sleep(100).then(() => "timed_out"),
    ]);
    releaseResolver();
    await pending.catch(() => undefined);

    expect(outcome).toBe("deadline");
    expect(model.calls).toHaveLength(0);
  });

  test("an in-flight phase signal aborts provider work without becoming operator cancellation", async () => {
    const deadline = new AbortController();
    const reason = new Error("phase wall deadline reached");
    const { brain, model, record } = fixture([{ delayMs: 5_000, content: ["too late"] }], { signal: deadline.signal });
    const pending = brain.run("go");
    while (model.calls.length === 0) await Bun.sleep(1);

    deadline.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(reason).not.toBeInstanceOf(RunCancelledError);
    expect(calls(record)).toHaveLength(0);
  });

  test.each(["minimal", "max"])("dispatches a measured %s effort supported by the seated model", async (effort) => {
    const { brain, model, record } = fixture([{ content: ["done"] }], {
      effort,
      model: { thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] } },
    });

    await brain.run("go");

    expect(String(model.calls[0]?.options?.reasoning)).toBe(effort);
    expect(calls(record)[0]).toMatchObject({ effort, effortSent: effort });
  });

  test("preserves provider-attributed fallback cost instead of repricing the requested model", async () => {
    const providerCost = { input: 0.011, output: 0.019, cacheRead: 0.002, cacheWrite: 0.003, total: 0.035 };
    const { brain, record } = fixture([{
      content: [
        { type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
        "served by fallback",
      ],
      usage: { input: 1_000, output: 1_000, cacheRead: 1_000, cacheWrite: 1_000, cost: providerCost },
    }], {
      model: {
        id: "claude-fable-5-1",
        provider: "anthropic",
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      },
    });

    const result = await brain.run("go");
    const call = calls(record)[0];

    expect(result.costUsd).toBe(providerCost.total);
    expect(call).toMatchObject({ costUsd: providerCost.total, fallbackServed: true });
  });

  test("served-model rewrites use their attributed cost at the next budget boundary", async () => {
    const providerCost = { input: 0.009, output: 0.021, cacheRead: 0.002, cacheWrite: 0.003, total: 0.035 };
    const served = createMockModel({
      id: "claude-opus-5",
      provider: "anthropic",
      responses: [
        {
          content: [{ type: "toolCall", name: "note", arguments: { text: "one fallback turn" } }],
          usage: { input: 1_000, output: 1_000, cost: providerCost },
        },
        { content: ["must not dispatch"] },
      ] as never,
    });
    const { brain, record } = fixture([], {
      model: {
        id: "claude-fable-5-1",
        provider: "anthropic",
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      },
      streamFn: served.stream as never,
      usdCap: 0.03,
    });

    const result = await brain.run("go");
    const call = calls(record)[0];

    expect(result).toMatchObject({ stopped: "usd_cap", costUsd: providerCost.total });
    expect(call).toMatchObject({ model: "claude-opus-5", costUsd: providerCost.total, fallbackServed: true });
    expect(served.calls).toHaveLength(1);
  });

  test("reserves the final turns for tool-free synthesis without another retrieval", async () => {
    const { brain, model, record } = fixture([
      { content: [{ type: "toolCall", name: "note", arguments: { text: "first finding" } }] },
      { content: [{ type: "toolCall", name: "note", arguments: { text: "second finding" } }] },
      { content: ["synthesis from observed findings"] },
    ], { turnCap: 4, finalizeWithoutTools: () => false });

    const result = await brain.run("research, then synthesize");

    expect(result).toMatchObject({ stopped: "done", turns: 3, text: "synthesis from observed findings" });
    expect(model.calls).toHaveLength(3);
    expect(model.calls[0]?.context.tools?.length ?? 0).toBeGreaterThan(0);
    expect(model.calls[1]?.context.tools?.length ?? 0).toBeGreaterThan(0);
    expect(model.calls[2]?.context.tools).toHaveLength(0);
    expect(JSON.stringify(model.calls[2]?.context.messages)).toContain("Stop retrieving now");
    expect(record.read().filter((event) => event.t === "tool.call")).toHaveLength(2);
  });

  test("an exhausted retrieval allowance starts tool-free synthesis immediately", async () => {
    const { brain, model, record } = fixture([
      { content: [{ type: "toolCall", name: "note", arguments: { text: "last allowed retrieval" } }] },
      { content: ["bounded synthesis"] },
    ], { turnCap: 10, finalizeWithoutTools: () => true });

    const result = await brain.run("research, then synthesize");

    expect(result).toMatchObject({ stopped: "done", turns: 2, text: "bounded synthesis" });
    expect(model.calls[1]?.context.tools).toHaveLength(0);
    expect(record.read().filter((event) => event.t === "tool.call")).toHaveLength(1);
  });
});
