import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvolutionTransactionError,
  applyIntent,
  assertTransactionPaths,
  cleanupIntentArtifacts,
  listIntents,
  readIntent,
  removeIntent,
  replaceIntent,
  rollbackIntent,
  writeIntent,
  type EvolutionIntent,
} from "../../src/evolution/transaction";

function home(): string { return mkdtempSync(join(tmpdir(), "kiln-transaction-")); }

function intent(): EvolutionIntent<{ confirmed: boolean }> {
  return {
    version: 1, kind: "promote", id: "candidate-a", operationId: "promote-abc", head: "a".repeat(40),
    transitions: [
      { path: "playbook/playbook.md", before: "before\n", after: "after\n" },
      { path: "evolution/candidates/candidate-a.json", before: "candidate\n", after: null },
      { path: "evolution/promoted/candidate-a.json", before: null, after: "candidate\n" },
      { path: "evolution/reports/candidate-a/eval.json", before: "report\n", after: "report\n" },
    ], result: { confirmed: true },
  };
}

function seed(path: string): void {
  writeFileSync(join(path, "seed.tmp"), "seed");
  for (const item of intent().transitions) if (item.before !== null) {
    const target = join(path, item.path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, item.before);
  }
}

describe("evolution transaction", () => {
  test("persists, resumes a partial application, and rolls back exact owned bytes", () => {
    const path = home(); seed(path); const value = intent();
    const stored = writeIntent(path, value);
    expect(readIntent(path, "promote", "candidate-a")).toEqual(value);
    expect(listIntents(path, "promote")).toEqual([value]);
    // Simulate a kill after only the first published mutation.
    writeFileSync(join(path, "playbook", "playbook.md"), "after\n");
    applyIntent(path, value); applyIntent(path, value);
    expect(readFileSync(join(path, "evolution", "promoted", "candidate-a.json"), "utf8")).toBe("candidate\n");
    expect(existsSync(join(path, "evolution", "candidates", "candidate-a.json"))).toBe(false);
    rollbackIntent(path, value); rollbackIntent(path, value);
    expect(readFileSync(join(path, "playbook", "playbook.md"), "utf8")).toBe("before\n");
    expect(readFileSync(join(path, "evolution", "candidates", "candidate-a.json"), "utf8")).toBe("candidate\n");
    expect(existsSync(join(path, "evolution", "promoted", "candidate-a.json"))).toBe(false);
    expect(existsSync(stored)).toBe(true); removeIntent(path, "promote", "candidate-a"); expect(existsSync(stored)).toBe(false);
  });

  test("a conflicting owned byte refuses before any mutation and leaves unrelated work alone", () => {
    const path = home(); seed(path); const value = intent(); const note = join(path, "operator-note.txt"); writeFileSync(note, "mine\n");
    mkdirSync(join(path, "evolution", "promoted"), { recursive: true });
    writeFileSync(join(path, "evolution", "promoted", "candidate-a.json"), "foreign\n");
    expect(() => applyIntent(path, value)).toThrow(EvolutionTransactionError);
    expect(readFileSync(join(path, "playbook", "playbook.md"), "utf8")).toBe("before\n");
    expect(readFileSync(note, "utf8")).toBe("mine\n");
  });

  test("rejects duplicate, escaping, and symlink-routed intent paths", () => {
    const path = home(); seed(path);
    for (const transitions of [
      [{ path: "../victim", before: null, after: "x" }],
      [{ path: "config.json", before: null, after: "x" }],
      [{ path: "prompts/a", before: null, after: "x" }, { path: "prompts/a", before: null, after: "y" }],
      [{ path: "evolution/archive/a", before: null, after: "x" }, { path: "evolution/archive/a/reason.json", before: null, after: "y" }],
    ]) expect(() => writeIntent(path, { ...intent(), transitions })).toThrow(/invalid_intent/);
    const outside = mkdtempSync(join(tmpdir(), "kiln-transaction-outside-")); symlinkSync(outside, join(path, "prompts"));
    expect(() => applyIntent(path, { ...intent(), transitions: [{ path: "prompts/a.md", before: null, after: "x" }] })).toThrow(/unsafe ancestor/);
    expect(existsSync(join(outside, "a.md"))).toBe(false);
  });

  test("refuses dangling leaf links and non-serializable results", () => {
    const path = home(); seed(path); const outside = join(path, "missing-target");
    mkdirSync(join(path, "evolution", "promoted"), { recursive: true });
    symlinkSync(outside, join(path, "evolution", "promoted", "dangling.json"));
    expect(() => applyIntent(path, { ...intent(), transitions: [{ path: "evolution/promoted/dangling.json", before: null, after: "x" }] })).toThrow(/not a real file/);
    expect(() => writeIntent(path, { ...intent(), result: undefined })).toThrow(/finite JSON values/);
    expect(() => writeIntent(path, { ...intent(), result: { cost: Number.NaN } })).toThrow(/finite JSON values/);
  });

  test("cleans only owned atomic-write residue and atomically advances phases", () => {
    const path = home(); seed(path); const first = intent(); const stored = writeIntent(path, first);
    const child = spawnSync("/bin/echo", ["done"]); const deadPid = child.pid!;
    const residue = `${stored}.${deadPid}.${Date.now()}.tmp`; const live = `${stored}.${process.pid}.${Date.now() + 1}.tmp`;
    writeFileSync(residue, "partial"); writeFileSync(live, "in flight");
    expect(listIntents(path, "promote")).toEqual([first]); expect(existsSync(residue)).toBe(false); expect(existsSync(live)).toBe(true);
    assertTransactionPaths(path, first.transitions.map((item) => item.path));
    const target = join(path, "playbook", "playbook.md"); const targetResidue = `${target}.${deadPid}.${Date.now()}.tmp`;
    writeFileSync(targetResidue, "partial target"); cleanupIntentArtifacts(path, first); expect(existsSync(targetResidue)).toBe(false);
    const next = { ...first, result: { confirmed: false } };
    replaceIntent(path, first, next); expect(readIntent(path, "promote", first.id)).toEqual(next);
    expect(() => replaceIntent(path, first, { ...next, operationId: "changed" })).toThrow(/transaction identity/);
  });
});
