import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { integrationsCommand } from "../../src/cli/commands/integrations";
import { loadConfig } from "../../src/core/config";
import { AuthStore } from "../../src/providers/auth";

test("integration status is read-only and reports missing access without creating a home", async () => {
  const parent = mkdtempSync(join(tmpdir(), "kiln-integration-status-"));
  try {
    const home = join(parent, "absent"), output: string[] = [];
    expect(await integrationsCommand(["jev", "status"], { home, json: true }, { write: s => output.push(s) }, { env: {} })).toBe(0);
    expect(existsSync(home)).toBe(false);
    expect(JSON.parse(output.join(""))).toMatchObject({ credentialSource: "none", serviceChecked: false, nextStep: "kiln auth key jev" });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("persistent workflow policy preserves model choices, limits, and environment overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-integration-policy-"));
  try {
    const invoke = async (action: string, env: NodeJS.ProcessEnv = {}) => {
      const output: string[] = [];
      expect(await integrationsCommand(["jev", action], { home, json: true }, { write: s => output.push(s) }, { env })).toBe(0);
      return JSON.parse(output.join(""));
    };
    expect((await invoke("enable")).configuredWorkflows).toBe(true);
    const before = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("typesafe", "fixture-key-never-print");
    const overridden = await invoke("status", { KILN_JEV_WORKFLOWS: "0" });
    expect(overridden).toMatchObject({ configuredWorkflows: true, effective: { workflows: false }, credentialSource: "stored" });
    expect(JSON.stringify(overridden)).not.toContain("fixture-key-never-print");
    expect((await invoke("status", { KILN_JEV_ENABLED: "0" })).effective.enabled).toBe(false);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(JSON.stringify(before, null, 2) + "\n");
    expect((await invoke("disable")).configuredWorkflows).toBe(false);
    const after = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(after).toEqual({ ...before, integrations: { jev: { workflows: false } } });
    expect((await invoke("status", { KILN_JEV_WORKFLOWS: "1" })).effective.workflows).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("malformed integration settings and command flags cannot silently enable workflows", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-integration-invalid-"));
  try {
    for (const integrations of [null, [], "true", { jev: [] }, { jev: { workflows: "true" } }]) {
      writeFileSync(join(home, "config.json"), JSON.stringify({ integrations }));
      expect(() => loadConfig(home)).toThrow();
      expect(await integrationsCommand(["jev", "enable"], { home, extra: true }, { write: () => {} }, { env: {} })).toBe(2);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ integrations });
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
