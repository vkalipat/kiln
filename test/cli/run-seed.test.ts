import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestDriftNote, resolveNewSeed } from "../../src/cli/commands/run-seed";
import { initHome } from "../../src/core/home";
import { HeldoutSeedError } from "../../src/evals/identity";
import { loadSeeds } from "../../src/evals/seeds";

describe("run seed input", () => {
  test("resolves registered and ordinary sources by eventual seed bytes", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-run-seed-")); initHome(home);
    const dev = loadSeeds(home, "dev")[0]!;
    expect(resolveNewSeed(home, [], { "seed-id": dev.id })).toEqual({ text: dev.text, identity: { id: dev.id, split: "dev", sha256: dev.sha256 } });
    expect(resolveNewSeed(home, ["ordinary", "request"], {})).toEqual({ text: "ordinary request", identity: undefined });
    expect(() => resolveNewSeed(home, ["ambiguous"], { "seed-id": dev.id })).toThrow(/exactly one/);
  });

  test("recognises held-out bytes independent of source spelling", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-run-seed-")); initHome(home);
    const heldout = loadSeeds(home, "heldout")[0]!;
    expect(() => resolveNewSeed(home, [], { "seed-file": heldout.path })).toThrow(HeldoutSeedError);
    expect(() => resolveNewSeed(home, [heldout.text], {})).toThrow(HeldoutSeedError);
  });

  test("formats stable manifest drift details", () => {
    expect(manifestDriftNote({ ok: true, changed: [], missing: [], extra: [] })).toBeUndefined();
    expect(manifestDriftNote({ ok: false, changed: ["b"], missing: ["a"], extra: ["c"] })).toBe("eval manifest drift: changed:b, missing:a, extra:c");
  });

  test("never follows a poisoned split path for an explicit seed id", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-run-seed-")); initHome(home);
    const splitPath = join(home, "evals", "split.json");
    const split = JSON.parse(readFileSync(splitPath, "utf8")); const id = split.seeds[0].id as string;
    split.seeds[0].file = "../../outside.md";
    writeFileSync(splitPath, `${JSON.stringify(split)}\n`);
    writeFileSync(join(home, "outside.md"), "must not be a seed\n");
    expect(() => resolveNewSeed(home, [], { "seed-id": id })).toThrow(/cannot safely resolve/);
  });
});
