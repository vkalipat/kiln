import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { initHome } from "../../src/core/home";
import { candidatePath, writeAtomic } from "../../src/core/paths";
import { runProcess } from "../../src/core/process";
import { playbookHash } from "../../src/evolution/playbook";

const cwd = join(import.meta.dir, "../..");
function snapshot(home: string): Record<string, string> {
  const held: Record<string, string> = {};
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else held[relative(home, path)] = readFileSync(path).toString("base64");
  };
  for (const name of ["config.json", "evals", "prompts", "playbook"]) visit(join(home, name));
  return held;
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-bin-evolve-")); initHome(home);
  const id = "binary-fixture";
  writeAtomic(candidatePath(home, id), JSON.stringify({ version: 1, kind: "prompt", author: "operator", createdAt: "2026-09-05T12:00:00.000Z", playbookHash: playbookHash(readFileSync(join(home, "playbook", "playbook.md"), "utf8")), prompt: { name: "brain", text: "# Brain\nPrefer concrete mechanisms and state their testable assumptions.\n" } }));
  return { home, id };
}
const invoke = (home: string, id: string, budget?: string) => runProcess({
  cmd: process.execPath, cwd, args: ["--preload", join(import.meta.dir, "helpers/evolve-cli-fixture.ts"), "bin/kiln.ts", "evolve", "eval", id, "--home", home, "--json", ...(budget ? ["--budget", budget] : [])],
  timeoutMs: 20_000, maxOutputBytes: 2_000_000,
});

test("real bin executes and resumes a two-seed fixture evaluation without changing protected inputs", async () => {
  const { home, id } = fixture(); const before = snapshot(home);
  const first = await invoke(home, id, "100");
  expect(first.stderr).toBe(""); expect(first.exitCode).toBe(1); // two seeds cannot meet the fixed evidence floors
  const report = JSON.parse(first.stdout);
  expect(report).toMatchObject({ candidateId: id, verdict: "not_evidence", passes: { dev: { seeds: 1 }, heldout: { seeds: 1 } } });
  expect(report.runs).toHaveLength(4);
  const reportPath = join(home, "evolution", "reports", id);
  expect(JSON.parse(readFileSync(join(reportPath, "eval.json"), "utf8"))).toEqual(report);
  const lines = readFileSync(join(reportPath, "judged.jsonl"), "utf8"); expect(lines.trim().split("\n")).toHaveLength(16);
  const calls = join(home, "evolution", "work", "fixture-calls.jsonl"); const firstCalls = readFileSync(calls, "utf8");
  expect(firstCalls.trim().split("\n")).toHaveLength(6);
  const repeated = await invoke(home, id, "100"); expect(repeated.exitCode).toBe(1); expect(repeated.stderr).toBe("");
  expect(readFileSync(calls, "utf8")).toBe(firstCalls); expect(readFileSync(join(reportPath, "judged.jsonl"), "utf8")).toBe(lines);
  expect(snapshot(home)).toEqual(before);
  expect(existsSync(join(home, "evolution", "evolve.lock"))).toBe(false);
  for (const arm of ["champion", "candidate"]) expect(existsSync(join(home, "evolution", "work", id, arm, "auth.json"))).toBe(false);
}, 30_000);

test("real bin refuses a budget-less evaluation before entering either fixture vehicle", async () => {
  const { home, id } = fixture(); const result = await invoke(home, id);
  expect(result.exitCode).toBe(2); expect(result.stderr).toContain("--budget");
  expect(existsSync(join(home, "evolution", "work", "fixture-calls.jsonl"))).toBe(false);
});
