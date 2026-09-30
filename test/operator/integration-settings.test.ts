import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { initHome } from "../../src/core/home";
import { loadConfig, saveConfig } from "../../src/core/config";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime } from "../../src/operator/runtime";
import { createOmpSession } from "../../src/operator/session";
import { prepareStepRouting } from "../../src/operator/routing";
import { parseModelRef } from "../../src/providers/models";

const usage = { input: 20, output: 10 };
function fixture(enabled: boolean) {
  const home = mkdtempSync(join(tmpdir(), "kiln-integration-runtime-")); initHome(home, { plugAndPlay: true });
  const cfg = loadConfig(home); cfg.integrations = { ...cfg.integrations, jev: { workflows: enabled } }; saveConfig(home, cfg);
  const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("anthropic", "fake-model-key"); auth.setApiKey("typesafe", "fake-stored-jev");
  const { modelId } = parseModelRef(prepareStepRouting(cfg, new Set(["anthropic"]), "General task").selectedRoleRefs.brain);
  return { home, auth, modelId };
}
function cleanEnv() {
  const names = ["TYPESAFE_API_KEY", "KILN_JEV_ENABLED", "KILN_JEV_WORKFLOWS"];
  const prior = names.map(name => process.env[name]); names.forEach(name => delete process.env[name]);
  return () => names.forEach((name, i) => { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; });
}

test("persisted workflow setting and stored Jev key traverse native research tool without startup dispatch", async () => {
  const restore = cleanEnv(), f = fixture(true); let calls = 0, captures = 0;
  const model = createMockModel({ id: f.modelId, provider: "anthropic", responses: [
    { content: [{ type: "toolCall", name: "research_task", arguments: { question: "Was sample A measured?", requiredFields: [{ id: "measured", question: "Was sample A measured?" }], sources: ["https://docs.example.com/results"], allowedHosts: ["docs.example.com"] } }], usage },
    { content: ["Captured evidence; labels remain unverified."], usage },
  ] as never });
  const runtime = await createOperatorRuntime({ home: f.home, cwd: f.home, seed: "Collect evidence", auth: f.auth,
    jev: { mode: "boundaries", fetch: (async (_url, init) => {
      calls++; expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-stored-jev");
      const p = JSON.parse(String(init?.body));
      return Response.json({ model: p.model, answers: Object.fromEntries(Object.entries(p.questions).map(([id, q]: [string, any]) => {
        const choice = id.endsWith("coverage") ? "supports" : id.endsWith("support") ? "p0" : "none";
        return [id, { type: "choice", choice, confidence: 0.99, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
      })), usage: { input_tokens: 100, output_tokens: 5 } });
    }) as typeof fetch },
    workflows: { fetch: (async () => { captures++; return new Response("Sample A was measured.", { headers: { "content-type": "text/plain" } }); }) as unknown as typeof fetch },
    createSession: options => createOmpSession({ ...options, model: model as never, streamFn: streamMock as never, contextFiles: [] }),
  });
  try {
    expect(calls).toBe(0); expect(captures).toBe(0); expect(model.calls).toHaveLength(0);
    expect((await runtime.prompt("Collect the source evidence")).stopped).toBe("completed");
    expect(calls).toBe(1); expect(captures).toBe(1);
    const context = JSON.stringify(model.calls[0]!.context);
    expect(context).toContain("research_task"); expect(context).toContain("browser_task"); expect(context).not.toContain("fake-stored-jev");
    const metadata = readFileSync(join(runtime.run.dir, "operator.json"), "utf8");
    expect(JSON.parse(metadata).workflows).toMatchObject({ enabled: true, stats: { attempts: 1, inputTokens: 100 } });
    expect(metadata).not.toContain("fake-stored-jev");
  } finally { await runtime.dispose(); restore(); rmSync(f.home, { recursive: true, force: true }); }
}, 30000);

test("workflow disable overrides are invocation-local and resume retains saved policy", async () => {
  const restore = cleanEnv(), f = fixture(true);
  const start = async (runId?: string, enabled?: boolean) => {
    let toolNames: string[] = [];
    const model = createMockModel({ id: f.modelId, provider: "anthropic", responses: [{ content: ["Ready"], usage }] as never });
    const runtime = await createOperatorRuntime({ home: f.home, cwd: f.home, seed: "Keep saved policy", runId, auth: f.auth,
      jev: { mode: "boundaries", fetch: (() => { throw new Error("Unexpected Jev request"); }) as unknown as typeof fetch },
      workflows: enabled === undefined ? undefined : { enabled },
      createSession: async options => {
        const handle = await createOmpSession({ ...options, model: model as never, streamFn: streamMock as never, contextFiles: [] });
        toolNames = ["browser_task", "research_task"].filter(name => !!handle.session.getToolByName(name));
        return handle;
      },
    });
    await runtime.prompt("Describe local readiness");

    const saved = JSON.parse(readFileSync(join(runtime.run.dir, "operator.json"), "utf8"));
    await runtime.dispose(); return { id: runtime.run.id, toolNames, saved };
  };
  try {
    const initial = await start(); expect(initial.toolNames).toContain("research_task");
    const cfg = loadConfig(f.home); cfg.integrations = { ...cfg.integrations, jev: { workflows: false } }; saveConfig(f.home, cfg);
    const fresh = await start(); expect(fresh.toolNames).not.toContain("research_task");
    const override = await start(initial.id, false); expect(override.toolNames).not.toContain("research_task"); expect(override.saved.workflows.enabled).toBe(true);
    process.env.KILN_JEV_WORKFLOWS = "0";
    const disabled = await start(initial.id); expect(disabled.toolNames).not.toContain("browser_task"); expect(disabled.saved.workflows.enabled).toBe(true);
    delete process.env.KILN_JEV_WORKFLOWS;
    const resumed = await start(initial.id); expect(resumed.toolNames).toContain("browser_task"); expect(resumed.toolNames).toContain("research_task");
  } finally { restore(); rmSync(f.home, { recursive: true, force: true }); }
}, 30000);
