import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { createMockModel, streamMock, Effort } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { createOmpSession, switchOmpSessionModel } from "../../src/operator/session";

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
      options.settings!.set("async.enabled", false);
      options.settings!.set("modelRoles", { default: ref, smol: ref });
      // Native hasResolvableAuth already consults our local hasAuth inventory override.
      expect(options.authStorage!.hasResolvableAuth(second.provider)).toBe(true);
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
