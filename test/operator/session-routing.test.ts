import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import type { Model } from "@oh-my-pi/pi-catalog";
import { createOmpSession, switchOmpSessionModel } from "../../src/operator/session";

async function nativeSetting(settings: unknown, key: string, ...value: unknown[]): Promise<unknown> {
  const port = settings as { get?: (key: string) => unknown; set?: (key: string, value: unknown) => void };
  if (typeof port.get === "function" && typeof port.set === "function") {
    return value.length ? port.set(key, value[0]) : port.get(key);
  }
  const registryPath = "@oh-my-pi/pi-coding-agent/config/registry";
  const registry = await import(registryPath);
  if (typeof registry.lookup !== "function") throw new Error("Native settings registry is unavailable");
  const setting = registry.lookup(key);
  if (!setting || typeof setting.get !== "function" || typeof setting.set !== "function") throw new Error("Unsupported native setting: " + key);
  return value.length ? setting.set(settings, value[0]) : setting.get(settings);
}

test("owner-aware switching changes the next root/child request and never relaxes unowned auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-routing-prototype-"));
  const applied: string[] = [];
  let failRouting = false;
  const first = createMockModel({ provider: "routing-a", id: "model-a", handler: () => ({ content: [{ type: "toolCall", name: "switch_owned", arguments: { target: failRouting ? "missing" : "second" } }] }) } as never);
  const second = createMockModel({ provider: "routing-b", id: "model-b", reasoning: true, handler: (context: { tools?: { name: string }[] }) => ({ content:
    context.tools?.some((tool) => tool.name === "yield") ? [{ type: "toolCall", name: "yield", arguments: { data: "CHILD_ON_SECOND" } }] : ["ROOT_ON_SECOND"] }) } as never);
  (second as unknown as { thinking: unknown }).thinking = { mode: "effort", efforts: ["low", "high"] };
  const candidates = [first, second];
  const ref = `${first.provider}/${first.id}`;
  const handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: ref, model: first as never, effort: "low", contextFiles: [],
    connectedProviders: candidates.map((model) => model.provider), auth: { apiKeyFor: async () => "synthetic-owned-key", configuredProviders: (providers) => [...providers] },
    // Bound the synthetic failure case: never let a missing route spin through paid-style turns.
    onBeforeModelCall: () => first.calls.length + second.calls.length < 8,
    extensions: [(extension) => {
      extension.registerTool({ name: "switch_owned", label: "Switch owner", description: "Synthetic routing prototype", parameters: extension.arktype({ target: "string" }),
        async execute(_id, raw, _signal, _update, ctx) {
          const target = (raw as { target: string }).target === "second" ? second : { ...second, provider: "unconnected" };
          await switchOmpSessionModel(ctx, target as never, "low");
          applied.push(ctx.sessionManager.getSessionId());
          return { content: [{ type: "text", text: "Applied" }] };
        },
      });
    }],
    factory: async (options) => {
      await nativeSetting(options.settings!, "async.enabled", false);
      await nativeSetting(options.settings!, "modelRoles", { default: ref, smol: ref });
      // Native hasResolvableAuth already consults our local hasAuth inventory override.
      expect(options.modelRegistry!.hasConfiguredAuth(second as never)).toBe(true);
      options.extensions!.push((extension) => {
        for (const candidate of candidates) extension.registerProvider(candidate.provider, {
          api: "mock", apiKey: "synthetic-registration-only", baseUrl: "https://synthetic.invalid",
          models: [{ id: candidate.id, name: candidate.id, input: ["text"], contextWindow: 32000, maxTokens: 2000, thinking: (candidate as unknown as Model).thinking }],
          streamSimple: (model: Model, context: Parameters<typeof streamMock>[1], request: Parameters<typeof streamMock>[2]) => streamMock(candidates.find((candidate) => candidate.provider === model.provider)!, context, request),
        } as never);
      });
      return createAgentSession(options);
    },
  });
  try {
    await handle.session.prompt("Switch to second model and finish this root response");
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.options?.reasoning).toBe(Effort.Low);
    expect(handle.session.model?.provider).toBe(second.provider);
    expect(applied).toEqual([handle.sessionId]);
    expect(await handle.session.modelRegistry.getApiKey(second as never)).toBeUndefined();
    await handle.session.setModel(first as never);
    const task = handle.session.agent.state.tools.find((tool) => tool.name === "task")!;
    const result = await task.execute("nested-switch", { context: "Synthetic routing only", tasks: [{ agent: "task", name: "RouteChild", task: "Switch to second model then yield CHILD_ON_SECOND" }] });
    const child = (result.details as { results: { exitCode: number; output: string }[] }).results[0]!;
    expect(child.exitCode).toBe(0);
    expect(child.output).toContain("CHILD_ON_SECOND");
    expect(handle.session.model?.provider).toBe(first.provider);
    expect(applied).toHaveLength(2);
    expect(applied[1]).not.toBe(handle.sessionId);
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(2);
    failRouting = true;
    await handle.session.prompt("Try the unavailable route");
    expect(applied).toHaveLength(2);
    expect(handle.session.model?.provider).toBe(first.provider);
    expect(second.calls).toHaveLength(2);
  } finally { await handle.dispose(); }
}, 20_000);

test("native spawn routing associates parallel assignments and blocks failed dispatch guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-spawn-routing-"));
  const seen: { name?: string; text?: string; effort?: string }[] = [];
  let fail = false;
  let failStartup = true;
  const recovered: string[] = [];
  const planner = createMockModel({ provider: "spawn-parent", id: "parent", handler: () => ({ content: planner.calls.length <= 3 ? [
    { type: "toolCall", name: "task", arguments: { context: planner.calls.length === 1 ? "" : "Synthetic independent assignments", tasks: [
      { agent: "task", name: "assignment_alpha", task: "Produce alpha evidence", effort: "lo" },
      ...(planner.calls.length <= 2 ? [{ agent: "task", name: "assignment_beta", task: "Produce beta evidence" }] : []),
    ] } },
  ] : ["DONE"] }) } as never);
  const alpha = createMockModel({ provider: "spawn-alpha", id: "alpha", reasoning: true, handler: () => ({ content: [{ type: "toolCall", name: "yield", arguments: { data: "ALPHA" } }] }) } as never);
  const beta = createMockModel({ provider: "spawn-beta", id: "beta", reasoning: true, handler: () => ({ content: [{ type: "toolCall", name: "yield", arguments: { data: "BETA" } }] }) } as never);
  for (const model of [alpha, beta]) (model as unknown as { thinking: unknown }).thinking = { mode: "effort", efforts: ["low", "high"] };
  const candidates = [planner, alpha, beta];
  const ref = `${planner.provider}/${planner.id}`;
  const handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: ref, model: planner as never,
    effort: "low", contextFiles: [], connectedProviders: candidates.map((model) => model.provider),
    auth: { apiKeyFor: async () => "synthetic-owned-key", configuredProviders: (providers) => [...providers] },
    onBeforeModelCall: () => candidates.reduce((sum, model) => sum + model.calls.length, 0) < 10,
    onTaskDispatchFailure: (names) => { recovered.push(...names); },
    beforeSubagentSpawn: async (event) => {
      if (fail) throw new Error("synthetic routing failure");
      // Generic task inherits the parent selector without a role alias.
      expect(event.modelRole).toBeUndefined();
      expect(event.patterns).toEqual([ref]);
      seen.push({ name: event.taskName, text: event.taskText, effort: event.effort });
      const selected = event.taskName === "assignment_alpha" ? alpha : event.taskName === "assignment_beta" ? beta : undefined;
      if (event.taskName === "assignment_alpha" && failStartup) { failStartup = false; return { model: "unavailable-provider/missing-model" }; }
      return selected ? { model: `${selected.provider}/${selected.id}:high`, note: "Persisted assignment" } : { block: true, reason: "Missing assignment" };
    },
    factory: async (options) => {
      expect(await nativeSetting(options.settings!, "task.speculativeLaunch")).toBe(false);
      await nativeSetting(options.settings!, "async.enabled", false);
      await nativeSetting(options.settings!, "modelRoles", { default: ref, smol: ref });
      options.extensions!.push((extension) => {
        for (const candidate of candidates) extension.registerProvider(candidate.provider, {
          api: "mock", apiKey: "synthetic-registration-only", baseUrl: "https://synthetic.invalid",
          models: [{ id: candidate.id, name: candidate.id, input: ["text"], contextWindow: 32000, maxTokens: 2000, thinking: (candidate as unknown as Model).thinking, reasoning: true }],
          streamSimple: (model: Model, context: Parameters<typeof streamMock>[1], request: Parameters<typeof streamMock>[2]) => streamMock(candidates.find((candidate) => candidate.provider === model.provider)!, context, request),
        } as never);
      });
      return createAgentSession(options);
    },
  });
  try {
    await handle.session.prompt("Delegate the two independent assignments then finish");
    // Invalid first batch reuses both names; stale correlation must be cleaned.
    expect(JSON.stringify(handle.session.agent.state.messages)).toContain("Missing `context`");
    expect(seen.sort((a, b) => a.name!.localeCompare(b.name!))).toEqual([
      { name: "assignment_alpha", text: "Produce alpha evidence", effort: "lo" },
      { name: "assignment_alpha", text: "Produce alpha evidence", effort: "lo" },
      { name: "assignment_beta", text: "Produce beta evidence", effort: undefined },
    ]);
    expect(recovered).toEqual(["assignment_alpha"]);
    expect(alpha.calls).toHaveLength(1);
    expect(beta.calls).toHaveLength(1);
    expect(alpha.calls[0]!.options?.reasoning).toBe(Effort.Low);
    expect(beta.calls[0]!.options?.reasoning).toBe(Effort.High);
    expect(handle.session.model?.provider).toBe(planner.provider);
    fail = true;
    const task = handle.session.agent.state.tools.find((tool) => tool.name === "task")!;
    const result = await task.execute("blocked-spawn", { context: "Synthetic blocked assignment", tasks: [{ agent: "task", name: "assignment_alpha", task: "Should never dispatch" }] });
    expect(JSON.stringify(result)).toContain("dispatch guard failed");
    expect(alpha.calls).toHaveLength(1);
    expect(beta.calls).toHaveLength(1);
  } finally { await handle.dispose(); }
}, 20_000);
