import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { createOmpSession } from "../../src/operator/session";

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

describe("native OMP session adapter", () => {
  test("Sol uses native tools and resumes its exact model and effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-sol-session-"));
    const sol = getBundledModel("openai-codex", "gpt-6.1-sol")!;
    const mock = createMockModel({ id: "sol-native-contract", responses: [
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "printf sol-native-check > artifact.txt" } }] },
      { content: ["Sol tool path complete"] },
    ] } as never);
    const options = { cwd: root, stateDir: join(root, "state"), modelRef: "openai-codex/gpt-6.1-sol", effort: "max", connectedProviders: ["openai-codex"],
      auth: { apiKeyFor: async () => "synthetic-sol-key", configuredProviders: (providers: readonly string[]) => [...providers] }, contextFiles: [],
      streamFn: ((_model: unknown, context: Parameters<typeof streamMock>[1], streamOptions: Parameters<typeof streamMock>[2]) => streamMock(mock, context, streamOptions)) as never };
    const handle = await createOmpSession(options);
    try {
      expect(handle.session.model?.id).toBe(sol.id);
      expect(String(handle.session.thinkingLevel)).toBe("max");
      await handle.session.prompt("Write the synthetic artifact with the supplied bash tool.");
      expect(readFileSync(join(root, "artifact.txt"), "utf8")).toBe("sol-native-check");
      expect(mock.calls).toHaveLength(2);
    } finally { await handle.dispose(); }
    const resumed = await createOmpSession({ ...options, resumeFile: handle.sessionFile });
    try {
      expect(resumed.session.model?.id).toBe(sol.id);
      expect(String(resumed.session.thinkingLevel)).toBe("max");
      expect(JSON.stringify(resumed.session.messages)).toContain("Sol tool path complete");
    } finally { await resumed.dispose(); }
  }, 20_000);
  test("explicit empty or scoped context bypasses ambient project instructions", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-omp-context-"));
    writeFileSync(join(root, "AGENTS.md"), "AMBIENT_PROJECT_CONTEXT_MARKER");
    mkdirSync(join(root, ".omp", "skills", "unrequested"), { recursive: true });
    writeFileSync(join(root, ".omp", "skills", "unrequested", "SKILL.md"), "---\nname: unrequested\ndescription: UNREQUESTED_SKILL_MARKER\n---\nNever implicitly load this skill.\n");
    for (const contextFiles of [[], [{ path: join(root, "specific-policy.txt"), content: "EXPLICIT_CONTEXT_MARKER" }]]) {
      let prompt = "";
      const model = createMockModel({ id: "context-isolation", handler: (context: { systemPrompt?: string[] }) => { prompt = (context.systemPrompt ?? []).join("\n"); return { content: ["Synthetic context check"] }; } } as never);
      const handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never, effort: "low", connectedProviders: [model.provider],
        auth: { apiKeyFor: async () => "synthetic", configuredProviders: providers => [...providers] }, streamFn: streamMock as never, contextFiles });
      try {
        await handle.session.prompt("Synthetic context check only");
        expect(prompt).not.toContain("AMBIENT_PROJECT_CONTEXT_MARKER");
        expect(prompt).not.toContain("UNREQUESTED_SKILL_MARKER");
        expect(prompt.includes("EXPLICIT_CONTEXT_MARKER")).toBe(contextFiles.length > 0);
      } finally { await handle.dispose(); }
    }
  });
  test("credential resolution rejects cancellation after the host promise settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-omp-auth-cancel-"));
    const model = createMockModel({ id: "omp-auth-cancel" });
    let resolveKey!: (key: string) => void;
    const key = new Promise<string>((resolve) => { resolveKey = resolve; });
    let registry!: NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["modelRegistry"]>;
    const handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never, effort: "low", connectedProviders: [model.provider],
      auth: { apiKeyFor: () => key, configuredProviders: (providers) => [...providers] }, streamFn: streamMock as never, contextFiles: [],
      factory: async (options) => { registry = options.modelRegistry!; return createAgentSession(options); },
    });
    try {
      const cancellation = new AbortController();
      const pending = registry.getApiKeyForProvider(model.provider, handle.session.sessionManager.getSessionId(), { signal: cancellation.signal });
      resolveKey("synthetic-host-key");
      // Resolve Promise.race first, then abort before its finally/await continuation.
      queueMicrotask(() => cancellation.abort(new Error("credential owner cancelled")));
      await expect(pending).rejects.toThrow("credential owner cancelled");
      expect(model.calls).toHaveLength(0);
    } finally { await handle.dispose(); }
  });

  test("startup failure releases admission and rejects task aliases from project personas", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-omp-shadow-"));
    mkdirSync(join(root, ".omp", "agents"), { recursive: true });
    writeFileSync(join(root, ".omp", "agents", "alias.md"), "---\nname: task\ndescription: Unrequested custom persona\n---\nUse a different persona.\n");
    const model = createMockModel({ id: "omp-shadow" });
    const options = { cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never, effort: "low", connectedProviders: [model.provider],
      auth: { apiKeyFor: async () => "synthetic", configuredProviders: (providers: readonly string[]) => [...providers] }, streamFn: streamMock as never, contextFiles: [] };
    await expect(createOmpSession(options)).rejects.toThrow("persona");
    await expect(createOmpSession({ ...options, spawns: "task", factory: async () => { throw new Error("synthetic startup failure"); } })).rejects.toThrow("synthetic startup failure");
    const optedIn = await createOmpSession({ ...options, spawns: "task" });
    await optedIn.dispose();
    expect(model.calls).toHaveLength(0);
  });

  test("native task executes a child and inherited metering observes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-omp-child-"));
    const observed = new Set<string>();
    const guardedSessions = new Set<string>();
    let allowed = true;
    const controller = new AbortController();
    let holdChild = false, childAborted = false, started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    const prompts: { child: boolean; text: string }[] = [];
    const model = createMockModel({ id: "omp-child", handler: async (context: { tools?: { name: string }[]; systemPrompt?: string[] }, request: { signal?: AbortSignal }) => {
      const child = context.tools?.some((t) => t.name === "yield");
      prompts.push({ child: child === true, text: (context.systemPrompt ?? []).join("\n") });
      if (child && holdChild) {
        await new Promise<void>((resolve) => { request.signal!.addEventListener("abort", () => { childAborted = true; resolve(); }, { once: true }); started(); });
        throw request.signal!.reason;
      }
      return { content: child ? [{ type: "toolCall", name: "yield", arguments: { data: "NATIVE_CHILD_VERIFIED" } }] : ["Root ready"] };
    } } as never);
    const handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never, effort: "low", connectedProviders: [model.provider],
      auth: { apiKeyFor: async () => "synthetic", configuredProviders: (providers) => [...providers] }, streamFn: streamMock as never,
      contextFiles: [{ path: join(root, "task-policy.txt"), content: "EXPLICIT_SCOPED_CONTEXT_MARKER" }], signal: controller.signal,
      onModelMessage: (event, ctx) => { if (event.message.role === "assistant") observed.add(ctx.sessionManager.getSessionId()); },
      onBeforeModelCall: (ctx) => { guardedSessions.add(ctx.sessionManager.getSessionId()); return allowed; },
      factory: async (options) => {
        await nativeSetting(options.settings!, "async.enabled", false);
        await nativeSetting(options.settings!, "task.prewalk", false);
        await nativeSetting(options.settings!, "modelRoles", { default: `${model.provider}/${model.id}`, smol: `${model.provider}/${model.id}` });
        options.extensions!.push((extension) => extension.registerProvider(model.provider, { api: "mock", apiKey: "synthetic-test-only", baseUrl: "https://synthetic.invalid", models: [{ id: model.id, name: "Synthetic", input: ["text"], contextWindow: 32000, maxTokens: 2000 }],
          streamSimple: (_model: unknown, context: Parameters<typeof streamMock>[1], opts: Parameters<typeof streamMock>[2]) => streamMock(model, context, opts),
        } as never));
        return createAgentSession(options);
      },
    });
    try {
      await handle.session.prompt("Root ready check");
      const task = handle.session.agent.state.tools.find((t) => t.name === "task")!;
      const result = await task.execute("child-contract", { context: "Synthetic verification only", tasks: [{ agent: "task", name: "Verify", task: "Return NATIVE_CHILD_VERIFIED through yield without calling other tools" }] });
      expect((result.details as { results: { exitCode: number; output: string }[] }).results[0]).toMatchObject({ exitCode: 0 });
      expect((result.details as { results: { output: string }[] }).results[0]!.output).toContain("NATIVE_CHILD_VERIFIED");
      expect(observed.size).toBe(2);
      expect(prompts.some(p => p.child && p.text.includes("EXPLICIT_SCOPED_CONTEXT_MARKER"))).toBe(true);
      expect(prompts.some(p => !p.child && p.text.includes("EXPLICIT_SCOPED_CONTEXT_MARKER"))).toBe(true);
      const hub = handle.session.agent.state.tools.find((t) => t.name === "hub");
      if (hub) {
        const listed = await hub.execute("hub-contract", { op: "list" });
        expect(listed.isError).not.toBe(true);
      } else {
        expect(handle.session.agent.state.tools.some((t) => t.name === "wait")).toBe(true);
      }
      const beforeDenied = model.calls.length;
      allowed = false;
      await task.execute("guard-contract", { context: "Synthetic guard only", tasks: [{ agent: "task", name: "Guarded", task: "Must not dispatch" }] });
      expect(model.calls).toHaveLength(beforeDenied);
      expect(guardedSessions.size).toBeGreaterThanOrEqual(3);
      allowed = true;
      holdChild = true;
      const pending = task.execute("cancel-contract", { context: "Synthetic cancellation only", tasks: [{ agent: "task", name: "Wait", task: "Wait for cancellation" }] }, controller.signal);
      await childStarted;
      controller.abort("synthetic operator cancellation");
      const cancelled = await pending;
      expect(childAborted).toBe(true);
      expect((cancelled.details as { results: { aborted: boolean }[] }).results[0]!.aborted).toBe(true);
      await handle.awaitSettled();
    } finally { await handle.dispose(); }
  }, 20_000);

  test("real SDK creates native tools and a resumable transcript without credential files", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-omp-contract-"));
    const model = createMockModel({ id: "omp-contract", responses: [{ content: ["Provider-free native session response"] }] as never });
    const options = { cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never, effort: "low", connectedProviders: [model.provider],
      auth: { apiKeyFor: async () => "test-runtime-only-key", configuredProviders: (providers: readonly string[]) => [...providers] }, streamFn: streamMock as never, contextFiles: [],
      modelRoles: { default: `${model.provider}/${model.id}`, smol: `${model.provider}/${model.id}`, slow: `${model.provider}/${model.id}` },
      factory: async (sdkOptions: Parameters<typeof createAgentSession>[0]) => {
        expect(await nativeSetting(sdkOptions!.settings!, "edit.autoRepair.enabled")).toBe(false);
        expect(await nativeSetting(sdkOptions!.settings!, "features.unexpectedStopDetection")).toBe("mechanical");
        expect(await nativeSetting(sdkOptions!.settings!, "speech.enhanced")).toBe(false);
        expect(await nativeSetting(sdkOptions!.settings!, "defaultThinkingLevel")).not.toBe("auto");
        expect(await nativeSetting(sdkOptions!.settings!, "task.enableEffort")).toBe(true);
        expect(await nativeSetting(sdkOptions!.settings!, "modelRoles")).toEqual(options.modelRoles);
        expect(await nativeSetting(sdkOptions!.settings!, "compaction.enabled")).toBe(true);
        expect(await nativeSetting(sdkOptions!.settings!, "includeWorkspaceTree")).toBe(false);
        expect(await nativeSetting(sdkOptions!.settings!, "personality")).toBe("none");
        expect(sdkOptions!.skills).toEqual([]);
        expect(sdkOptions!.rules).toEqual([]);
        expect(sdkOptions!.promptTemplates).toEqual([]);
        expect(sdkOptions!.slashCommands).toEqual([]);
        return createAgentSession(sdkOptions);
      },
    };
    const handle = await createOmpSession(options);
    const names = handle.session.getActiveToolNames();
    expect(names).toContain("task");
    expect(names.includes("hub") || names.includes("wait")).toBe(true);
    expect(names).not.toContain("ask");
    expect(typeof handle.session.compact).toBe("function");
    expect(typeof handle.session.steer).toBe("function");
    expect(typeof handle.session.followUp).toBe("function");
    expect(existsSync(handle.sessionFile)).toBe(true);
    await expect(createOmpSession(options)).rejects.toThrow("already active");
    const events: string[] = [];
    const unsubscribe = handle.session.subscribe((event) => events.push(event.type));
    await handle.session.prompt("Respond with one short synthetic sentence.");
    unsubscribe();
    await handle.dispose();
    expect(events).toContain("message_end");
    expect(readFileSync(handle.sessionFile, "utf8")).toContain("Provider-free native session response");
    expect(readFileSync(handle.sessionFile, "utf8")).not.toContain("test-runtime-only-key");
    expect(existsSync(join(root, "state", "agent.db"))).toBe(false);
    const resumed = await createOmpSession({ ...options, resumeFile: handle.sessionFile });
    expect(resumed.sessionId).toBe(handle.sessionId);
    expect(JSON.stringify(resumed.session.messages)).toContain("Provider-free native session response");
    await resumed.dispose();
    const before = model.calls.length;
    let guarded = 0;
    const blocked = await createOmpSession({ ...options, onBeforeModelCall: () => { guarded++; return false; } });
    try { await blocked.session.prompt("This must not reach a provider").catch(() => {}); }
    finally { await blocked.dispose(); }
    expect(guarded).toBeGreaterThan(0);
    expect(model.calls).toHaveLength(before);
  }, 20_000);
});
