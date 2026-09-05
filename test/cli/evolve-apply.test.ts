import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evolveApplyCommand } from "../../src/cli/commands/evolve-apply";
import { initHome } from "../../src/core/home";
import { FakeGitRunner } from "../build/fake-git";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-apply-cli-")); initHome(home);
  const output: string[] = []; const errors: string[] = [];
  const io = { write: (text: string) => output.push(text), error: (text: string) => errors.push(text), ask: async () => "yes" };
  const git = new FakeGitRunner();
  const deps = { operatorApply: { git, arbiter: async () => ({ conflicts: false, against: null, reason: "compatible" }) } };
  const flags = { home, op: "edit", id: "B1", text: "Keep one feature in each fresh builder session.", why: "Isolated context makes failed attempts easier to replace.", reason: "Correct the durable build procedure after observed retries.", json: true };
  return { home, output, errors, io, git, deps, flags };
}

test("operator CLI applies and returns the actual journal result", async () => {
  const f = setup();
  expect(await evolveApplyCommand(f.flags, f.io, f.deps)).toBe(0);
  expect(JSON.parse(f.output.join(""))).toMatchObject({ id: "B1", idempotent: false });
  expect(f.git.commits).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("operator CLI refuses usage and manifest drift before model work", async () => {
  const f = setup();
  expect(await evolveApplyCommand({ ...f.flags, op: "add" }, f.io, f.deps)).toBe(2);
  const before = readFileSync(join(f.home, "playbook", "playbook.md"), "utf8");
  writeFileSync(join(f.home, "evals", "judge-rubric.md"), "drift");
  expect(await evolveApplyCommand(f.flags, f.io, f.deps)).toBe(1);
  expect(f.errors.join("")).toContain("integrity");
  expect(f.git.commits).toHaveLength(0);
  expect(readFileSync(join(f.home, "playbook", "playbook.md"), "utf8")).toBe(before);
});

test("operator CLI respects a declined confirmation", async () => {
  const f = setup();
  expect(await evolveApplyCommand({ ...f.flags, json: false }, { ...f.io, ask: async () => "no" }, f.deps)).toBe(1);
  expect(f.git.commits).toHaveLength(0);
});
