import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { createOmpSession } from "../../src/operator/session";

describe("native OMP session adapter", () => {
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
    const model = createMockModel({ id: "omp-child", handler: async (context: { tools?: { name: string }[] }, request: { signal?: AbortSignal }) => {
      const child = context.tools?.some((t) => t.name === "yield");
      if (child && holdChild) {
        await new Promise<void>((resolve) => { request.signal!.addEventListener("abort", () => { childAborted = true; resolve(); }, { once: true }); started(); });
        throw request.signal!.reason;
      }
      return { content: child ? [{ type: "toolCall", name: "yield", arguments: { data: "NATIVE_CHILD_VERIFIED" } }] : ["Root ready"] };
    } } as never);
    const handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never, effort: "low", connectedProviders: [model.provider],
      auth: { apiKeyFor: async () => "synthetic", configuredProviders: (providers) => [...providers] }, streamFn: streamMock as never, contextFiles: [], signal: controller.signal,
      onModelMessage: (event, ctx) => { if (event.message.role === "assistant") observed.add(ctx.sessionManager.getSessionId()); },
      onBeforeModelCall: (ctx) => { guardedSessions.add(ctx.sessionManager.getSessionId()); return allowed; },
      factory: async (options) => {
        options.settings!.set("async.enabled", false);
        options.settings!.set("task.prewalk", false);
        options.settings!.set("modelRoles", { default: `${model.provider}/${model.id}`, smol: `${model.provider}/${model.id}` });
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
      const hub = handle.session.agent.state.tools.find((t) => t.name === "hub")!;
      const listed = await hub.execute("hub-contract", { op: "list" });
      expect(listed.isError).not.toBe(true);
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
        expect(sdkOptions!.settings!.get("edit.autoRepair.enabled")).toBe(false);
        expect(sdkOptions!.settings!.get("features.unexpectedStopDetection")).toBe("mechanical");
        expect(sdkOptions!.settings!.get("speech.enhanced")).toBe(false);
        expect(sdkOptions!.settings!.get("defaultThinkingLevel")).not.toBe("auto");
        expect(sdkOptions!.settings!.get("task.enableEffort")).toBe(true);
        expect(sdkOptions!.settings!.get("modelRoles")).toEqual(options.modelRoles);
        expect(sdkOptions!.settings!.get("compaction.enabled")).toBe(true);
        return createAgentSession(sdkOptions);
      },
    };
    const handle = await createOmpSession(options);
    const names = handle.session.getActiveToolNames();
    expect(names).toContain("task");
    expect(names).toContain("hub");
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
