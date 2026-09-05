import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
