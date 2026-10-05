import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHome } from "../../src/core/home";
import { loadConfig } from "../../src/core/config";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime } from "../../src/operator/runtime";
import type { OmpSessionHandle, OmpSessionOptions } from "../../src/operator/session";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-catalog-resume-")); initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("anthropic", "offline-key");
  const calls = { sessions: 0, prompts: 0, transport: 0, efforts: [] as string[] };
  const factory = async (options: OmpSessionOptions): Promise<OmpSessionHandle> => {
    calls.sessions++; calls.efforts.push(options.effort);
    return { sessionId: "catalog-parent", sessionFile: join(home, "fake.jsonl"), connectedProviders: ["anthropic"],
      session: { async prompt() { calls.prompts++; }, async abort() {}, setThinkingLevel() {}, agent: { steer() {} } } as never,
      sdk: {} as never, async awaitSettled() {}, async dispose() {} };
  };
  const options = { home, cwd: home, auth, seed: "Inspect the local artifact", createSession: factory,
    jev: { enabled: false, fetch: (() => { calls.transport++; throw new Error("unexpected transport"); }) as unknown as typeof fetch } };
  return { home, options, calls };
}

test("catalog fingerprint drift refuses resume before native session or transport and preserves metadata", async () => {
  const f = fixture(); const runtime = await createOperatorRuntime(f.options);
  const runId = runtime.run.id, path = join(runtime.run.dir, "operator.json");
  try {
    await runtime.dispose();
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    expect(metadata.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
    metadata.catalogSha256 = "0".repeat(64);
    const tampered = JSON.stringify(metadata); writeFileSync(path, tampered);
    await expect(createOperatorRuntime({ ...f.options, runId, seed: undefined })).rejects.toThrow("admitted model catalog");
    expect(f.calls.sessions).toBe(0); expect(f.calls.transport).toBe(0); expect(f.calls.prompts).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(tampered);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});

test("effort changes survive reopening without changing catalog identity; legacy missing hash gains baseline", async () => {
  const f = fixture(); let runtime = await createOperatorRuntime(f.options);
  try {
    const runId = runtime.run.id, path = join(runtime.run.dir, "operator.json");
    const initialHash = JSON.parse(readFileSync(path, "utf8")).catalogSha256;
    expect((await runtime.prompt("Inspect the local artifact")).stopped).toBe("completed");
    await runtime.setEffort("low"); await runtime.dispose();
    runtime = await createOperatorRuntime({ ...f.options, runId, seed: undefined });
    expect((await runtime.prompt("Continue with the saved effort")).stopped).toBe("completed");
    expect(f.calls.efforts.at(-1)).toBe("low");
    expect(JSON.parse(readFileSync(path, "utf8")).catalogSha256).toBe(initialHash);
    await runtime.dispose();
    const legacy = JSON.parse(readFileSync(path, "utf8")); delete legacy.catalogSha256; writeFileSync(path, JSON.stringify(legacy));
    runtime = await createOperatorRuntime({ ...f.options, runId, seed: undefined });
    expect(JSON.parse(readFileSync(path, "utf8")).catalogSha256).toBe(initialHash);
    expect(f.calls.transport).toBe(0);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});


test("restoring automatic effort preserves frozen models, allocation and resume identity without transport", async () => {
  const f = fixture(); let runtime = await createOperatorRuntime(f.options);
  try {
    const runId = runtime.run.id, path = join(runtime.run.dir, "operator.json"), configDir = join(runtime.run.dir, "operator");
    const initial = JSON.parse(readFileSync(path, "utf8")), initialConfig = loadConfig(configDir);
    await runtime.setEffort("low"); expect(loadConfig(configDir).routing?.effort).toBe("fixed");
    await runtime.setEffort("auto");
    const automatic = loadConfig(configDir), metadata = JSON.parse(readFileSync(path, "utf8"));
    expect(automatic.routing?.effort).toBe("adaptive");
    expect(automatic.roles).toEqual(initialConfig.roles); expect(JSON.stringify(automatic.budgets)).toBe(JSON.stringify(initialConfig.budgets));
    expect(metadata.catalogSha256).toBe(initial.catalogSha256);
    expect([metadata.budgetUsd, metadata.wallSeconds]).toEqual([initial.budgetUsd, initial.wallSeconds]);
    await runtime.dispose(); runtime = await createOperatorRuntime({ ...f.options, runId, seed: undefined });
    expect(loadConfig(configDir).routing?.effort).toBe("adaptive");
    expect(f.calls.sessions).toBe(0); expect(f.calls.prompts).toBe(0); expect(f.calls.transport).toBe(0);
  } finally { await runtime.dispose(); rmSync(f.home, { recursive: true, force: true }); }
});
