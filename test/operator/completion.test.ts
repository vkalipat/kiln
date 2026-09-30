import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { loadConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { readStatus } from "../../src/core/run";
import { AuthStore } from "../../src/providers/auth";
import { parseModelRef } from "../../src/providers/models";
import { prepareStepRouting } from "../../src/operator/routing";
import { createOperatorRuntime, type OperatorEvent, type OperatorRuntimeOptions } from "../../src/operator/runtime";
import { createOmpSession } from "../../src/operator/session";

const usage = { input: 20, output: 10 };
const seed = "Inspect the local task.";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-completion-"));
  initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json"));
  auth.setApiKey("anthropic", "synthetic-test-key");
  const prepared = prepareStepRouting(loadConfig(home), new Set(["anthropic"]), seed);
  const { modelId } = parseModelRef(prepared.selectedRoleRefs.brain);
  return { home, auth, modelId };
}
function native(f: ReturnType<typeof fixture>, responses: unknown[], extra: Partial<OperatorRuntimeOptions> = {}) {
  const model = createMockModel({ id: f.modelId, provider: "anthropic", responses: responses as never });
  // Preserve real admission exposure: the SDK mock defaults to zero-priced metadata.
  const admitted = getBundledModel("anthropic", f.modelId)!;
  Object.assign(model, { cost: admitted.cost, maxTokens: admitted.maxTokens, contextWindow: admitted.contextWindow });
  let sessionSignal: AbortSignal | undefined;
  return { model, signal: () => sessionSignal, runtime: createOperatorRuntime({ home: f.home, cwd: f.home, auth: f.auth, seed,
    jev: { enabled: false }, workflows: { enabled: false }, ...extra,
    createSession: options => { sessionSignal = options.signal; return createOmpSession({ ...options, model: model as never, streamFn: streamMock as never, contextFiles: [] }); },
  }) };
}
const stored = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("unlimited operator policy survives spend, home-default changes, and resumed accounting", async () => {
  const f = fixture();
  const cfg = loadConfig(f.home);
  cfg.budgets.usd = 0.000001;
  cfg.operator = { budgetUsd: null, wallSeconds: null };
  saveConfig(f.home, cfg);
  const first = native(f, [{ content: ["First checked response."], usage }]);
  const runtime = await first.runtime;
  let spent = 0;
  try {
    const result = await runtime.prompt(seed);
    expect(result.stopped).toBe("completed");
    expect(result.taskQualityValidated).toBe(false);
    expect(result.costUsd).toBeGreaterThan(cfg.budgets.usd);
    spent = result.costUsd;
    expect(stored(runtime.run.dir, "operator.json")).toMatchObject({ budgetUsd: null, wallSeconds: null });
    expect(stored(runtime.run.dir, "operator-meter.json")).toMatchObject({ limitUsd: null, chargedUsd: spent });
  } finally { await runtime.dispose(); }
  const changed = loadConfig(f.home);
  changed.operator = { budgetUsd: 0.000001, wallSeconds: 0.001 };
  saveConfig(f.home, changed);
  const resumed = await native(f, [{ content: ["Resumed checked response."], usage }], { runId: runtime.run.id }).runtime;
  try {
    const result = await resumed.prompt("Continue the local task.");
    expect(result.stopped).toBe("completed");
    expect(result.costUsd).toBeGreaterThan(spent);
    expect(stored(resumed.run.dir, "operator.json")).toMatchObject({ budgetUsd: null, wallSeconds: null });
    const meter = stored(resumed.run.dir, "operator-meter.json");
    expect(meter.limitUsd).toBeNull();
    expect(meter.chargedUsd).toBe(result.costUsd);
    expect(meter.rows.length).toBeGreaterThanOrEqual(2);
  } finally { await resumed.dispose(); }
  await expect(native(f, [], { runId: runtime.run.id, budgetUsd: 1 }).runtime).rejects.toThrow(/allocation|resume/i);
  await expect(native(f, [], { runId: runtime.run.id, wallSeconds: 10 }).runtime).rejects.toThrow(/allocation|resume/i);
}, 30_000);

test("explicit finite caps still refuse provider dispatch under an unlimited home policy", async () => {
  const f = fixture(); const cfg = loadConfig(f.home);
  cfg.operator = { budgetUsd: null, wallSeconds: null }; saveConfig(f.home, cfg);
  const { runtime: pending, model } = native(f, [{ content: ["must not run"], usage }], { budgetUsd: 0.000001 });
  const runtime = await pending;
  try {
    expect((await runtime.prompt(seed)).stopped).not.toBe("completed");
    expect(model.calls).toHaveLength(0);
    expect(stored(runtime.run.dir, "operator.json").budgetUsd).toBe(0.000001);
    expect(stored(runtime.run.dir, "operator-meter.json").limitUsd).toBe(0.000001);
  } finally { await runtime.dispose(); }
}, 30_000);

test("unlimited is represented by null, never non-finite option values", async () => {
  const f = fixture();
  for (const value of [Infinity, -Infinity, NaN, 0, -1]) {
    await expect(native(f, [], { budgetUsd: value }).runtime).rejects.toThrow(/positive|finite|budget/i);
    await expect(native(f, [], { wallSeconds: value }).runtime).rejects.toThrow(/positive|finite|wall/i);
  }
});

test("repeated identical native tool failures pause resumably within six calls without claiming completion", async () => {
  const f = fixture(); const events: OperatorEvent[] = [];
  const cfg = loadConfig(f.home); cfg.operator = { budgetUsd: null, wallSeconds: null }; saveConfig(f.home, cfg);
  const responses = Array.from({ length: 8 }, () => ({ content: [{ type: "toolCall", name: "read", arguments: { path: "missing-evidence.txt" } }], usage }));
  let descendantStarted = false, descendantCancelled = false;
  const running = native(f, [...responses, { content: ["False completion sentinel"], usage }], { onEvent: event => {
    events.push(event);
    if (event.type === "tool_start" && !descendantStarted) {
      // A synthetic active descendant observes the exact shared session signal.
      // This verifies propagation, not native task-spawn lifecycle behavior.
      descendantStarted = true;
      running.signal()!.addEventListener("abort", () => { descendantCancelled = true; }, { once: true });
    }
  } });
  const { runtime: pending, model } = running;
  const runtime = await pending;
  try {
    const result = await runtime.prompt(seed);
    expect(result.stopped).toBe("paused");
    expect(result.taskQualityValidated).toBe(false);
    expect(result.text).not.toContain("False completion sentinel");
    const calls = events.filter(event => event.type === "tool_start" && event.name === "read");
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(model.calls.length).toBeLessThanOrEqual(6);
    expect(events.some(event => event.type === "compute_notice" && event.notice.severity === "pause")).toBe(true);
    expect(readStatus(runtime.run).state).toBe("paused");
    expect(readStatus(runtime.run).outcome?.kind).not.toBe("success");
    expect(descendantStarted).toBe(true);
    expect(descendantCancelled).toBe(true);
    expect(running.signal()?.aborted).toBe(true);
  } finally { await runtime.dispose(); }
  const resumed = await native(f, [{ content: ["Missing evidence acknowledged; no unsupported claim."], usage }], { runId: runtime.run.id }).runtime;
  try {
    expect((await resumed.prompt("Stop retrying the missing path and report the missing evidence.")).stopped).toBe("completed");
  } finally { await resumed.dispose(); }
}, 30_000);

test("ordinary successful multi-tool work is not mistaken for a failure loop", async () => {
  const f = fixture(); const events: OperatorEvent[] = [];
  writeFileSync(join(f.home, "input.txt"), "verified fixture input");
  const { runtime: pending } = native(f, [
    { content: [{ type: "toolCall", name: "read", arguments: { path: "input.txt" } }], usage },
    { content: [{ type: "toolCall", name: "write", arguments: { path: "result.txt", content: "verified fixture output" } }], usage },
    { content: [{ type: "toolCall", name: "read", arguments: { path: "result.txt" } }], usage },
    { content: ["The checked artifact is ready."], usage },
  ], { budgetUsd: null, wallSeconds: null, onEvent: event => events.push(event) });
  const runtime = await pending;
  try {
    expect((await runtime.prompt(seed)).stopped).toBe("completed");
    expect(readFileSync(join(f.home, "result.txt"), "utf8")).toBe("verified fixture output");
    expect(events.filter(event => event.type === "tool_end" && event.ok)).toHaveLength(3);
    expect(readStatus(runtime.run).state).toBe("done");
  } finally { await runtime.dispose(); }
}, 30_000);

test("omitted operator policy inherits finite legacy allocations and freezes them for resume", async () => {
  const f = fixture(); const cfg = loadConfig(f.home);
  delete cfg.operator; cfg.budgets.usd = 50; cfg.budgets.wallSeconds = 120; saveConfig(f.home, cfg);
  const runtime = await native(f, [{ content: ["Allocation recorded."], usage }]).runtime;
  try {
    expect((await runtime.prompt(seed)).stopped).toBe("completed");
    expect(stored(runtime.run.dir, "operator.json")).toMatchObject({ budgetUsd: 50, wallSeconds: 120 });
  } finally { await runtime.dispose(); }
  const changed = loadConfig(f.home); changed.operator = { budgetUsd: null, wallSeconds: null }; saveConfig(f.home, changed);
  const resumed = await native(f, [], { runId: runtime.run.id }).runtime;
  try {
    expect(stored(resumed.run.dir, "operator.json")).toMatchObject({ budgetUsd: 50, wallSeconds: 120 });
  } finally { await resumed.dispose(); }
  await expect(native(f, [], { runId: runtime.run.id, budgetUsd: null }).runtime).rejects.toThrow(/allocation|resume/i);
});

test("explicit finite wall allocation interrupts startup and records a resumable pause", async () => {
  const f = fixture(); let initializationStarted = false;
  const runtime = await createOperatorRuntime({ home: f.home, cwd: f.home, auth: f.auth, seed,
    budgetUsd: null, wallSeconds: 0.05, jev: { enabled: false }, workflows: { enabled: false },
    createSession: async options => {
      initializationStarted = true;
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(options.signal?.reason ?? new Error("cancelled"));
        if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
      });
      throw new Error("unreachable");
    },
  });
  try {
    const result = await runtime.prompt(seed);
    expect(initializationStarted).toBe(true);
    expect(result.stopped).toBe("paused");
    expect(result.costUsd).toBe(0);
    expect(readStatus(runtime.run).state).toBe("paused");
    expect(stored(runtime.run.dir, "operator.json")).toMatchObject({ budgetUsd: null, wallSeconds: 0.05 });
  } finally { await runtime.dispose(); }
}, 5_000);

test("invalid persisted operator allocations fail closed instead of becoming unlimited", () => {
  const f = fixture();
  const cfg = loadConfig(f.home);
  for (const value of [0, -1, "unlimited", "Infinity", {}, []]) {
    for (const field of ["budgetUsd", "wallSeconds"]) {
      writeFileSync(join(f.home, "config.json"), JSON.stringify({ ...cfg, operator: { [field]: value } }));
      expect(() => loadConfig(f.home)).toThrow();
    }
  }
});

test("uncapped native sessions persist unlimited Jev aggregates while explicit classifier limits stay finite", async () => {
  for (const finite of [false, true]) {
    const f = fixture(); const cfg = loadConfig(f.home);
    cfg.operator = { budgetUsd: null, wallSeconds: null }; saveConfig(f.home, cfg);
    let externalCalls = 0;
    const blockedFetch = (async () => { externalCalls++; throw new Error("No external request permitted in this fixture"); }) as unknown as typeof fetch;
    const runtime = await native(f, [{ content: ["Local fixture inspected."], usage }], {
      jev: { enabled: true, mode: "boundaries", fetch: blockedFetch, ...(finite ? { maxCalls: 3, maxTokens: 99 } : {}) },
      workflows: { enabled: true, fetch: blockedFetch, ...(finite ? { maxCalls: 4, maxInputTokens: 101 } : {}) },
    }).runtime;
    try {
      expect((await runtime.prompt(seed)).stopped).toBe("completed");
      const metadata = stored(runtime.run.dir, "operator.json");
      expect(metadata.jev).toMatchObject({ enabled: true, maxCalls: finite ? 3 : null, maxTokens: finite ? 99 : null });
      expect(metadata.workflows).toMatchObject({ enabled: true, maxCalls: finite ? 4 : null, maxInputTokens: finite ? 101 : null });
      expect(externalCalls).toBe(0);
    } finally { await runtime.dispose(); }
  }
}, 30_000);

test("native wait polling produces advice without falsely pausing a valid continuing turn", async () => {
  const f = fixture(); const events: OperatorEvent[] = [];
  const responses = Array.from({ length: 7 }, () => ({ content: [{ type: "toolCall", name: "wait", arguments: {} }], usage }));
  const { runtime: pending } = native(f, [...responses, { content: ["No workers remain; polling stopped."], usage }], {
    budgetUsd: null, wallSeconds: null, onEvent: event => events.push(event),
  });
  const runtime = await pending;
  try {
    expect((await runtime.prompt(seed)).stopped).toBe("completed");
    expect(events.filter(event => event.type === "tool_start" && event.name === "wait")).toHaveLength(7);
    expect(events.some(event => event.type === "compute_notice" && event.notice.severity === "warning")).toBe(true);
    expect(events.some(event => event.type === "compute_notice" && event.notice.severity === "pause")).toBe(false);
    expect(readStatus(runtime.run).state).toBe("done");
  } finally { await runtime.dispose(); }
}, 30_000);
