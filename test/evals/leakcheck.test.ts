import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvalsManifest } from "../../src/evals/manifest";
import { leakcheck, sharesWordShingle, wordShingles } from "../../src/evals/leakcheck";
import { loadSeeds } from "../../src/evals/seeds";

const bundledHome = join(import.meta.dir, "../..");

/** Avoid macOS clonefileat: under parallel Bun workers cpSync can block here for tens of seconds. */
function copyFixtureTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name); const to = join(target, name); const stat = lstatSync(from);
    if (stat.isDirectory()) copyFixtureTree(from, to);
    else if (stat.isFile()) writeFileSync(to, readFileSync(from));
    else throw new Error(`fixture source must contain only real files and directories: ${from}`);
  }
}

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "kiln-leaks-"));
  copyFixtureTree(join(bundledHome, "evals"), join(home, "evals"));
  mkdirSync(join(home, "playbook"), { recursive: true });
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(join(home, "evolution", "candidates"), { recursive: true });
  writeFileSync(join(home, "playbook", "playbook.md"), "## build\n- B1 [helpful:0 harmful:0] Keep checks small.\n");
  writeFileSync(join(home, "prompts", "brain.md"), "Work from evidence.\n");
  const manifest = buildEvalsManifest(home, { generatedAt: "2026-09-05T00:00:00.000Z" });
  writeFileSync(join(home, "evals", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return home;
}

describe("leak primitives", () => {
  test("normalises punctuation and matches exact eight-word windows", () => {
    expect(wordShingles("One two three four five six seven eight nine")).toEqual(new Set([
      "one two three four five six seven eight",
      "two three four five six seven eight nine",
    ]));
    expect(sharesWordShingle("Before, one two three four five six seven eight!", "one two three four five six seven eight after")).toBe(true);
    expect(sharesWordShingle("one two three four five six seven", "one two three four five six seven")).toBe(false);
  });
});

describe("leakcheck", () => {
  test("finds quoting, a shared shingle, a held-out run candidate, and manifest drift", () => {
    const home = fixture();
    expect(leakcheck(home)).toEqual({ ok: true, rows: [], manifest: { ok: true, changed: [], missing: [], extra: [] } });
    const seed = loadSeeds(home, "heldout")[0]!;
    writeFileSync(join(home, "playbook", "playbook.md"), `## build\n- B1 [helpful:0 harmful:0] ${seed.text.trim()}\n`);
    writeFileSync(join(home, "prompts", "brain.md"), `${seed.text.split(/\s+/).slice(0, 8).join(" ")} unrelated ending.\n`);

    const runId = "heldout-run";
    mkdirSync(join(home, "runs", runId), { recursive: true });
    writeFileSync(join(home, "runs", runId, "status.json"), `${JSON.stringify({
      seed: { id: seed.id, split: "heldout", sha256: seed.sha256 },
    })}\n`);
    writeFileSync(join(home, "evolution", "candidates", `${runId}.json`), `${JSON.stringify({
      runId,
      delta: { text: seed.text },
    })}\n`);
    writeFileSync(join(home, "evals", "unexpected.md"), "drift\n");

    const result = leakcheck(home);
    expect(result.ok).toBe(false);
    const row = (kind: string, source: string) => result.rows.find((candidate) => candidate.kind === kind && candidate.source === source);
    expect(row("trigram", "playbook/playbook.md#B1")?.seedId).toBe(seed.id);
    expect(row("shingle", "prompts/brain.md#paragraph-1")?.seedId).toBe(seed.id);
    expect(row("heldout_candidate", `evolution/candidates/${runId}.json`)?.seedId).toBe(seed.id);
    expect(row("manifest", "extra:unexpected.md")).toEqual({ kind: "manifest", source: "extra:unexpected.md", seedId: "", score: 1 });
    expect(result.manifest.extra).toEqual(["unexpected.md"]);
  });

  test("falls back from a candidate run to seed.md identity", () => {
    const home = fixture();
    const seed = loadSeeds(home, "heldout")[1]!;
    const runId = "fallback-run";
    mkdirSync(join(home, "runs", runId), { recursive: true });
    writeFileSync(join(home, "runs", runId, "seed.md"), seed.text);
    writeFileSync(join(home, "evolution", "candidates", `${runId}.json`), `${JSON.stringify({ runId, delta: { text: "unrelated" } })}\n`);
    expect(leakcheck(home).rows).toContainEqual({
      kind: "heldout_candidate",
      source: `evolution/candidates/${runId}.json`,
      seedId: seed.id,
      score: 1,
    });
  });

  test("covers archived and promoted candidate layouts", () => {
    const home = fixture();
    const seed = loadSeeds(home, "heldout")[2]!;
    for (const [runId, candidatePath] of [
      ["archived-run", join(home, "evolution", "archive", "archived", "candidate.json")],
      ["promoted-run", join(home, "evolution", "promoted", "promoted.json")],
    ] as const) {
      mkdirSync(join(home, "runs", runId), { recursive: true });
      writeFileSync(join(home, "runs", runId, "status.json"), `${JSON.stringify({
        seed: { id: seed.id, split: seed.split, sha256: seed.sha256 },
      })}\n`);
      mkdirSync(join(candidatePath, ".."), { recursive: true });
      writeFileSync(candidatePath, `${JSON.stringify({ runId, delta: { text: "unrelated candidate lesson" } })}\n`);
    }
    const heldoutSources = leakcheck(home).rows
      .filter((row) => row.kind === "heldout_candidate")
      .map((row) => row.source);
    expect(heldoutSources).toEqual([
      "evolution/archive/archived/candidate.json",
      "evolution/promoted/promoted.json",
    ]);
  });
});
