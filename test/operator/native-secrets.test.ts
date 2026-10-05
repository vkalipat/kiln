import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { createOmpSession } from "../../src/operator/session";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

test("native subprocesses cannot inherit credentials and tool results are scrubbed before storage and model dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-native-secrets-"));
  const name = "KILN_TEST_NATIVE_API_KEY", previous = process.env[name], sentinel = "SYNTHETIC_NATIVE_SECRET_123456789";
  process.env[name] = sentinel;
  writeFileSync(join(root, "fixture.txt"), sentinel);
  const model = createMockModel({ id: "secret-boundary", responses: [
    { content: [{ type: "toolCall", name: "bash", arguments: { command: 'printf "credential-length=%s" "${#KILN_TEST_NATIVE_API_KEY}"' } }] },
    { content: [{ type: "toolCall", name: "read", arguments: { path: "fixture.txt" } }] },
    { content: [{ type: "toolCall", name: "eval", arguments: { language: "js", code: 'console.log("eval-credential-length=" + String((process.env.KILN_TEST_NATIVE_API_KEY ?? "").length));' } }] },
    { content: ["Synthetic verification complete"] },
  ] } as never);
  const keepAlive = setInterval(() => {}, 100);
  let handle: Awaited<ReturnType<typeof createOmpSession>> | undefined;
  try {
    handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never,
      effort: "low", connectedProviders: [model.provider], auth: { apiKeyFor: async () => "synthetic-owned-key", configuredProviders: providers => [...providers] },
      streamFn: streamMock as never, contextFiles: [], signal: AbortSignal.timeout(8000) });
    await handle.session.prompt("Execute only the synthetic credential boundary fixture");
    await handle.awaitSettled();
    const contexts = JSON.stringify(model.calls.map(call => call.context.messages)), messages = JSON.stringify(handle.session.agent.state.messages);
    expect(model.calls).toHaveLength(4);
    expect(contexts.includes("credential-length=0")).toBe(true);
    expect(contexts.includes("eval-credential-length=0")).toBe(true);
    expect(contexts.includes("[REDACTED]")).toBe(true);
    expect(contexts.includes(sentinel)).toBe(false); expect(messages.includes(sentinel)).toBe(false);
    expect(readFileSync(handle.sessionFile, "utf8").includes(sentinel)).toBe(false);
  } finally {
    await handle?.dispose();
    clearInterval(keepAlive);
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("native task children protect shell, tool results and the JS eval Worker fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-child-secrets-")), name = "KILN_TEST_CHILD_API_KEY", previous = process.env[name];
  const sentinel = "SYNTHETIC_CHILD_SECRET_123456789";
  process.env[name] = sentinel; writeFileSync(join(root, "fixture.txt"), sentinel);
  let childCalls = 0;
  const model = createMockModel({ id: "child-secret-boundary", handler: (context: { tools?: { name: string }[] }) => {
    if (!context.tools?.some(tool => tool.name === "yield")) return { content: ["Root ready"] };
    childCalls++;
    if (childCalls === 1) return { content: [{ type: "toolCall", name: "bash", arguments: { command: 'printf "child-credential-length=%s" "${#KILN_TEST_CHILD_API_KEY}"' } }] };
    if (childCalls === 2) return { content: [{ type: "toolCall", name: "read", arguments: { path: join(root, "fixture.txt") } }] };
    if (childCalls === 3) return { content: [{ type: "toolCall", name: "eval", arguments: { language: "js", code: 'console.log("child-eval-credential-length=" + String((process.env.KILN_TEST_CHILD_API_KEY ?? "").length));' } }] };
    return { content: [{ type: "toolCall", name: "yield", arguments: { data: "Child fixture complete" } }] };
  } } as never);
  const keepAlive = setInterval(() => {}, 100);
  const spawn = Bun.spawn.bind(Bun); let fallbackSpawns = 0;
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    const command = Array.isArray(args[0]) ? args[0] : args[0]?.cmd;
    if (command?.includes("__omp_worker_js_eval_process")) { fallbackSpawns++; throw new Error("Synthetic eval process spawn failure"); }
    return Reflect.apply(spawn, Bun, args);
  }) as typeof Bun.spawn);
  let handle: Awaited<ReturnType<typeof createOmpSession>> | undefined;
  try {
    handle = await createOmpSession({ cwd: root, stateDir: join(root, "state"), modelRef: `${model.provider}/${model.id}`, model: model as never,
    effort: "low", connectedProviders: [model.provider], auth: { apiKeyFor: async () => "synthetic", configuredProviders: providers => [...providers] },
    streamFn: streamMock as never, contextFiles: [], signal: AbortSignal.timeout(10000), factory: async options => {
      const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
      lookup("async.enabled")!.set(options.settings!, false);
      lookup("modelRoles")!.set(options.settings!, { default: `${model.provider}/${model.id}`, smol: `${model.provider}/${model.id}` });
      options.extensions!.push(extension => extension.registerProvider(model.provider, { api: "mock", apiKey: "synthetic-test-only", baseUrl: "https://synthetic.invalid",
        models: [{ id: model.id, name: "Synthetic", input: ["text"], contextWindow: 32000, maxTokens: 2000 }],
        streamSimple: (_model: unknown, context: Parameters<typeof streamMock>[1], opts: Parameters<typeof streamMock>[2]) => streamMock(model, context, opts),
      } as never));
      return createAgentSession(options);
    } });
    await handle.session.prompt("Root fixture ready check");
    const task = handle.session.agent.state.tools.find(tool => tool.name === "task")!;
    const result = await task.execute("child-secret-fixture", { context: "Synthetic verification only", tasks: [{ agent: "task", name: "Verify", task: "Run the scripted credential fixture and yield" }] });
    expect(result.isError).not.toBe(true); expect(childCalls).toBe(4); expect(fallbackSpawns).toBeGreaterThan(0);
    const contexts = JSON.stringify(model.calls.map(call => call.context.messages));
    expect(contexts.includes("child-credential-length=0")).toBe(true);
    expect(contexts.includes("child-eval-credential-length=0")).toBe(true);
    expect(contexts.includes("[REDACTED]")).toBe(true); expect(contexts.includes(sentinel)).toBe(false);
  } finally {
    spawnSpy.mockRestore(); await handle?.dispose(); clearInterval(keepAlive);
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);


test("native Python environment filtering excludes credential-shaped prefixed aliases", async () => {
  const { filterEnv } = await import("@oh-my-pi/pi-coding-agent/eval/py/runtime");
  const input = { HOME: "/tmp/synthetic", PATH: "/usr/bin", PI_WORKER_CONFIG: "ok", PI_TEST_API_KEY: "synthetic-key", PI_TEST_TOKEN: "synthetic-token", OPENAI_API_KEY: "synthetic-openai" };
  const env = filterEnv(input);
  expect(env).toEqual({ HOME: input.HOME, PATH: input.PATH, PI_WORKER_CONFIG: "ok" });
  expect(input.PI_TEST_API_KEY).toBe("synthetic-key");
});
