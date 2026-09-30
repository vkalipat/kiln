import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../../src/cli/main";
import { doctorCommand } from "../../src/cli/commands/doctor";
import { initHome } from "../../src/core/home";
import { loadConfig, saveConfig } from "../../src/core/config";
import { AuthStore } from "../../src/providers/auth";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-doctor-")); initHome(home);
  const auth = new AuthStore(join(home, "auth.json"), { getEnvApiKey: () => undefined, onWarn: () => {} });
  auth.setApiKey("anthropic", "synthetic-native-secret");
  return { home, auth };
}
async function run(home: string, auth?: AuthStore, env: Record<string, string | undefined> = {}, extra: Record<string, string | boolean> = {}) {
  const out: string[] = [];
  const code = await doctorCommand([], { home, cwd: home, json: true, ...extra }, { write: s => out.push(s) }, { auth, env });
  return { code, text: out.join(""), report: JSON.parse(out.join("")) };
}

test("doctor missing home reports setup required without creating any files", async () => {
  const parent = mkdtempSync(join(tmpdir(), "kiln-doctor-missing-")), home = join(parent, "absent");
  const result = await run(home);
  expect(result.code).toBe(1); expect(result.report.blockers).toEqual(["home_needs_setup"]);
  expect(existsSync(home)).toBe(false); expect(readdirSync(parent)).toEqual([]);
});

test("doctor reports native compatibility and optional warnings without changing config or credentials", async () => {
  const f = fixture(); const cfg = loadConfig(f.home); cfg.operator = { budgetUsd: null, wallSeconds: null }; saveConfig(f.home, cfg);
  const before = ["config.json", "auth.json"].map(p => readFileSync(join(f.home, p), "utf8"));
  const result = await run(f.home, f.auth);
  expect(result.code).toBe(0); expect(result.report.native.configured).toBe(true);
  expect(Object.values(result.report.native.roles).every((r: any) => r.compatible)).toBe(true);
  expect(result.report.operator).toMatchObject({ budgetUsd: null, wallSeconds: null, computeMonitor: { codeAvailable: true }, scopedTeams: { codeAvailable: true } });
  expect(result.report.warnings).toContain("jev_not_configured"); expect(result.report.warnings).toContain("hindsight_not_configured");
  expect(result.report.liveChecked).toBe(false); expect(result.text).not.toContain("synthetic-native-secret");
  expect(["config.json", "auth.json"].map(p => readFileSync(join(f.home, p), "utf8"))).toEqual(before);
  expect(readdirSync(join(f.home, "runs"))).toEqual([]);
});

test("required Jev checks configured key and workflow policy including authoritative disable flags", async () => {
  const f = fixture(); f.auth.setApiKey("typesafe", "synthetic-jev-secret");
  const cfg = loadConfig(f.home); cfg.integrations = { jev: { workflows: true } }; saveConfig(f.home, cfg);
  expect((await run(f.home, f.auth, {}, { require: "jev" })).code).toBe(0);
  for (const env of [{ KILN_JEV_ENABLED: "0" }, { KILN_JEV_WORKFLOWS: "0" }]) {
    const result = await run(f.home, f.auth, env, { require: "jev" });
    expect(result.code).toBe(1); expect(result.report.blockers).toContain("jev_not_configured");
    expect(result.text).not.toContain("synthetic-jev-secret");
  }
  const empty = new AuthStore(join(f.home, "absent-auth.json"), { getEnvApiKey: () => undefined });
  const result = await run(f.home, empty, { TYPESAFE_API_KEY: "synthetic-env-secret", KILN_JEV_WORKFLOWS: "1" }, { require: "jev" });
  expect(result.report.jev.configured).toBe(true);
  expect(result.report.blockers).toContain("native_credentials_missing");
  expect(result.text).not.toContain("synthetic-env-secret");
});

test("required Hindsight validates endpoint and bank offline and never emits secrets or private identities", async () => {
  const f = fixture();
  const local = await run(f.home, f.auth, { KILN_HINDSIGHT_URL: "http://127.0.0.1:8888/private-path", KILN_HINDSIGHT_BANK: "private-bank" }, { require: "hindsight" });
  expect(local.code).toBe(0); expect(local.report.hindsight.credentialConfigured).toBe(false);
  expect(local.text).not.toContain("private-path"); expect(local.text).not.toContain("private-bank");
  const remote = { KILN_HINDSIGHT_URL: "https://private-host.example/secret-path", KILN_HINDSIGHT_BANK: "private-bank" };
  expect((await run(f.home, f.auth, remote, { require: "hindsight" })).code).toBe(1);
  f.auth.setApiKey("hindsight", "synthetic-memory-secret");
  const ready = await run(f.home, f.auth, remote, { require: "hindsight" });
  expect(ready.code).toBe(0); expect(ready.text).not.toContain("private-host"); expect(ready.text).not.toContain("synthetic-memory-secret");
  for (const url of ["https://user:password@example.com", "https://example.com/?token=secret-value", "http://remote.example", "not-a-url"]) {
    const result = await run(f.home, f.auth, { ...remote, KILN_HINDSIGHT_URL: url }, { require: "hindsight" });
    expect(result.code).toBe(1); expect(result.text).not.toContain(url); expect(result.text).not.toContain("secret-value");
  }
  expect((await run(f.home, f.auth, { ...remote, KILN_HINDSIGHT_BANK: "../invalid" }, { require: "hindsight" })).code).toBe(1);
});

test("doctor rejects unknown or malformed requirements before filesystem access", async () => {
  for (const require of ["other", "jev,", "jev,jev", "jev hindsight"]) {
    const output: string[] = [];
    expect(await doctorCommand([], { require, home: "/absent-fixture" }, { write: s => output.push(s) })).toBe(2);
    expect(output.join("")).toContain("usage:");
  }
});

test("doctor contains malformed local config errors without disclosing its path or contents", async () => {
  const f = fixture(); writeFileSync(join(f.home, "config.json"), '{"secret-value":');
  const result = await run(f.home, f.auth);
  expect(result.code).toBe(1); expect(result.report.blockers).toEqual(["local_configuration_invalid"]);
  expect(result.text).not.toContain(f.home); expect(result.text).not.toContain("secret-value");
});


test("doctor main dispatch remains read-only on missing homes and never constructs an operator", async () => {
  const parent = mkdtempSync(join(tmpdir(), "kiln-doctor-entry-")), home = join(parent, "absent");
  let calls = 0; const output: string[] = [];
  expect(await main(["doctor", "--home", home, "--json"], { write: s => output.push(s) }, {
    createOperatorRuntime: async (): Promise<never> => { calls++; throw new Error("must not dispatch"); },
  })).toBe(1);
  expect(calls).toBe(0); expect(existsSync(home)).toBe(false); expect(readdirSync(parent)).toEqual([]);
  expect(JSON.parse(output.join("")).blockers).toEqual(["home_needs_setup"]);
});

test("doctor uses credential presence without invoking live resolution even for stored OAuth", async () => {
  const f = fixture();
  f.auth.set({ type: "oauth", provider: "anthropic", access: "synthetic-access-secret", refresh: "synthetic-refresh-secret", expires: 1 });
  let resolutions = 0;
  f.auth.apiKeyFor = async () => { resolutions++; throw new Error("refresh forbidden"); };
  const result = await run(f.home, f.auth);
  expect(result.code).toBe(0); expect(result.report.native.credentialConfigured).toBe(true);
  expect(result.report.native.liveChecked).toBe(false); expect(resolutions).toBe(0);
  expect(result.text).not.toContain("synthetic-access-secret"); expect(result.text).not.toContain("synthetic-refresh-secret");
});
