import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalInProgress, HeldoutSeedError, requireHeldoutEval, seedIdentity, seedIdentityFromSplit } from "../../src/evals/identity";
import { loadSeeds, loadSplit } from "../../src/evals/seeds";

const bundledHome = join(import.meta.dir, "../..");

describe("seed identity", () => {
  test("recognises file and pasted forms by the seed.md byte hash", () => {
    const seed = loadSeeds(bundledHome, "heldout")[0]!;
    expect(seedIdentity(bundledHome, seed.text)).toEqual({ id: seed.id, split: "heldout", sha256: seed.sha256 });
    expect(seedIdentity(bundledHome, seed.text.replace(/\n$/, ""))).toEqual({ id: seed.id, split: "heldout", sha256: seed.sha256 });
    expect(seedIdentityFromSplit(seed.text, loadSplit(bundledHome))).toEqual({ id: seed.id, split: "heldout", sha256: seed.sha256 });
    expect(seedIdentity(seed.text, loadSplit(bundledHome))).toEqual({ id: seed.id, split: "heldout", sha256: seed.sha256 });
    expect(seedIdentity(bundledHome, "an unrelated seed")).toBeUndefined();
    expect(readFileSync(join(bundledHome, "evals", seed.file), "utf8")).toBe(seed.text);
  });

  test("requires an existing real eval work directory only for held-out seeds", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-heldout-"));
    const heldout = loadSeeds(bundledHome, "heldout")[0]!;
    const dev = loadSeeds(bundledHome, "dev")[0]!;
    expect(() => requireHeldoutEval(home, { id: dev.id, split: dev.split, sha256: dev.sha256 })).not.toThrow();
    expect(() => requireHeldoutEval(home, { id: heldout.id, split: heldout.split, sha256: heldout.sha256 })).toThrow(HeldoutSeedError);
    expect(() => requireHeldoutEval(home, { id: heldout.id, split: heldout.split, sha256: heldout.sha256 }, "../escape")).toThrow(/requires --eval/);
    mkdirSync(join(home, "evolution", "work", "eval-1"), { recursive: true });
    mkdirSync(join(home, "evolution", "reports", "eval-1"), { recursive: true });
    writeFileSync(join(home, "evolution", "reports", "eval-1", "eval.json"), '{"evalId":"eval-1","verdict":"incomplete"}\n');
    expect(evalInProgress(home, "eval-1")).toBe(true);
    expect(() => requireHeldoutEval(home, { id: heldout.id, split: heldout.split, sha256: heldout.sha256 }, "eval-1")).not.toThrow();
    writeFileSync(join(home, "evolution", "reports", "eval-1", "eval.json"), '{"evalId":"eval-1","verdict":"win"}\n');
    expect(evalInProgress(home, "eval-1")).toBe(false);
    expect(() => requireHeldoutEval(home, { id: heldout.id, split: heldout.split, sha256: heldout.sha256 }, "eval-1")).toThrow(/in progress/);
  });
});
