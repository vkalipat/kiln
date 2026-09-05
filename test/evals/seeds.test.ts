import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trigramJaccard } from "../../src/ideation/novelty";
import { loadSeeds, verifySplit } from "../../src/evals/seeds";

const bundledHome = join(import.meta.dir, "../..");

describe("bundled eval seeds", () => {
  test("satisfy the split, shape, hash, and mechanical rubric", () => {
    const verification = verifySplit(bundledHome);
    expect(verification.errors).toEqual([]);
    expect(verification.missing).toEqual([]);
    expect(verification.extra).toEqual([]);
    expect(verification.changed).toEqual([]);
    expect(verification.ok).toBe(true);

    const seeds = loadSeeds(bundledHome);
    expect(seeds).toHaveLength(24);
    expect(seeds.filter((seed) => seed.split === "dev")).toHaveLength(12);
    expect(seeds.filter((seed) => seed.split === "heldout")).toHaveLength(12);
    for (const split of ["dev", "heldout"] as const) {
      for (const shape of ["research", "product", "creative"] as const) {
        expect(seeds.filter((seed) => seed.split === split && seed.shape === shape)).toHaveLength(4);
      }
    }

    let maxPair = 0;
    let maxCross = 0;
    for (let left = 0; left < seeds.length; left += 1) {
      for (let right = left + 1; right < seeds.length; right += 1) {
        const a = seeds[left]!;
        const b = seeds[right]!;
        const score = trigramJaccard(a.text, b.text);
        maxPair = Math.max(maxPair, score);
        if (a.split !== b.split) maxCross = Math.max(maxCross, score);
        expect(score).toBeLessThan(0.3);
        if (a.split !== b.split) expect(score).toBeLessThan(0.25);
      }
    }
    console.info(`eval seed trigram maxima: all=${maxPair.toFixed(4)} dev-heldout=${maxCross.toFixed(4)}`);
    expect(verification.maxPairwiseJaccard).toBeCloseTo(maxPair, 12);
    expect(verification.maxCrossSplitJaccard).toBeCloseTo(maxCross, 12);
  });

  test("detects a byte change and a directory file absent from split.json", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-seeds-"));
    cpSync(join(bundledHome, "evals"), join(home, "evals"), { recursive: true });
    const seed = join(home, "evals", "seeds", "heldout", "heldout-research-01.md");
    writeFileSync(seed, `${readFileSync(seed, "utf8")}Changed.\n`);
    writeFileSync(join(home, "evals", "seeds", "dev", "unlisted.md"), "not listed\n");
    const result = verifySplit(home);
    expect(result.ok).toBe(false);
    expect(result.changed).toContain("seeds/heldout/heldout-research-01.md");
    expect(result.extra).toContain("seeds/dev/unlisted.md");
  });
});
