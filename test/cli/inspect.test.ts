import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCommand } from "../../src/cli/commands/inspect";
import { initHome } from "../../src/core/home";
import { loadConfig } from "../../src/core/config";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";

test("disk inspection exposes all events and roles without model calls", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-inspect-")); initHome(home);
  const run = createRun(home, "seed"); const record = new RunRecord(run.record);
  for (let index = 0; index < 12; index++) record.append({ t: "note", text: String(index) });
  let output = ""; const io = { write: (s: string) => { output += s; } };
  expect(inspectCommand(["run", "record", run.id], { home, json: true }, io)).toBe(0);
  expect(JSON.parse(output)).toHaveLength(12);
  output = "";
  expect(inspectCommand(["model", "roles"], { home, json: true }, io)).toBe(0);
  expect(JSON.parse(output).some((row: { role: string }) => row.role === "builder")).toBe(true);
});

test("explicit effort changes persist, ultra is xhigh, invalid input does not write", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-mode-")); const io = { write: () => {} };
  expect(inspectCommand(["mode", "set", "ultra"], { home }, io)).toBe(0);
  expect(loadConfig(home).effort).toBe("xhigh");
  expect(inspectCommand(["mode", "set", "nonsense"], { home }, io)).toBe(2);
  expect(loadConfig(home).effort).toBe("xhigh");
  expect(inspectCommand(["mode", "toggle"], { home }, io)).toBe(0);
  expect(loadConfig(home).effort).toBe("low");
});

test("routing mode changes persist and invalid input leaves the config untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-routing-mode-")); const io = { write: () => {} };
  expect(inspectCommand(["model", "routing", "adaptive"], { home }, io)).toBe(0);
  expect(loadConfig(home).routing).toEqual({ mode: "adaptive" });
  const before = readFileSync(join(home, "config.json"), "utf8");
  expect(inspectCommand(["model", "routing", "automatic"], { home }, io)).toBe(2);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  expect(inspectCommand(["model", "routing", "manual"], { home }, io)).toBe(0);
  expect(loadConfig(home).routing).toEqual({ mode: "manual" });
});

test("adaptive plan preview is offline and leaves config and runs untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-routing-preview-")); initHome(home);
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    anthropic: { type: "api_key", provider: "anthropic", key: "offline-test-key" },
    "openai-codex": { type: "api_key", provider: "openai-codex", key: "offline-test-key" },
  }));
  const beforeConfig = readFileSync(join(home, "config.json"), "utf8");
  const beforeRuns = readdirSync(join(home, "runs"));
  let output = ""; const io = { write: (s: string) => { output += s; } };
  expect(inspectCommand(["model", "plan", "Find", "a", "business", "idea"], { home, json: true }, io)).toBe(0);
  expect(JSON.parse(output).status).toBe("ready");
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(beforeConfig);
  expect(readdirSync(join(home, "runs"))).toEqual(beforeRuns);
});

test("benchmark import requires reviewed fresh evidence and rejects unverified, stale, or future snapshots", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-routing-evidence-")); initHome(home);
  const source = join(home, "candidate.json");
  const bundled = JSON.parse(readFileSync(join(import.meta.dir, "../../src/routing/evidence-2026-09-08.json"), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  bundled.asOf = today; bundled.verification.verifiedAt = today;
  for (const item of bundled.sources) item.observedAt = today;
  let bundledOutput = ""; const bundledIo = { write: (s: string) => { bundledOutput += s; } };
  expect(inspectCommand(["model", "benchmarks", "show"], { home, json: true }, bundledIo)).toBe(0);
  expect(JSON.parse(bundledOutput).rankings.length).toBeGreaterThan(0);
  writeFileSync(source, JSON.stringify(bundled));
  const io = { write: () => {} };
  expect(inspectCommand(["model", "benchmarks", "import", source], { home }, io)).toBe(2);
  expect(existsSync(join(home, "routing", "benchmarks.json"))).toBe(false);
  bundled.verification.status = "unverified";
  writeFileSync(source, JSON.stringify(bundled));
  expect(inspectCommand(["model", "benchmarks", "import", source], { home, reviewed: true }, io)).toBe(2);
  expect(existsSync(join(home, "routing", "benchmarks.json"))).toBe(false);

  bundled.verification.status = "verified";
  for (const date of ["2000-01-01", new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)]) {
    bundled.asOf = date; bundled.verification.verifiedAt = date; bundled.maxAgeDays = 1;
    for (const item of bundled.sources) item.observedAt = date;
    writeFileSync(source, JSON.stringify(bundled));
    expect(inspectCommand(["model", "benchmarks", "import", source], { home, reviewed: true }, io)).toBe(2);
    expect(existsSync(join(home, "routing", "benchmarks.json"))).toBe(false);
  }

  bundled.asOf = today; bundled.verification.verifiedAt = today; bundled.maxAgeDays = 90;
  for (const item of bundled.sources) item.observedAt = today;
  writeFileSync(source, JSON.stringify(bundled));
  expect(inspectCommand(["model", "benchmarks", "import", source], { home, reviewed: true }, io)).toBe(0);
  let output = ""; const showIo = { write: (s: string) => { output += s; } };
  expect(inspectCommand(["model", "benchmarks", "show"], { home, json: true }, showIo)).toBe(0);
  expect(JSON.parse(output).id).toBe(bundled.id);
});
