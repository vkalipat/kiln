import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitRunner } from "../../src/build/git";
import { initHome } from "../../src/core/home";
import { applyOperatorDelta } from "../../src/evolution/operator";
import { rollbackLatest, RollbackError } from "../../src/evolution/rollback";
import { FakeGitRunner } from "../build/fake-git";

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "kiln-rollback-")); initHome(path); return path;
}

describe("rollback", () => {
  test("requires confirmation, a clean tree, and an evolution trailer on HEAD", async () => {
    const path = home(); const git = new FakeGitRunner();
    await expect(rollbackLatest(path, { confirm: false }, { git })).rejects.toMatchObject({ reason: "confirmation_required" });
    expect(git.calls).toHaveLength(0);
    git.status = " M playbook/playbook.md\n";
    await expect(rollbackLatest(path, { confirm: true }, { git })).rejects.toMatchObject({ reason: "dirty_tree" });
    git.status = "";
    await expect(rollbackLatest(path, { confirm: true }, { git })).rejects.toMatchObject({ reason: "not_evolution_head" });
    expect(git.calls.filter((call) => call.method === "revert")).toHaveLength(0);
    expect(existsSync(join(path, "evolution", "evolve.lock"))).toBe(false);
  });

  test("reverts an operator HEAD once, preserves its journal line, and adds one rollback commit", async () => {
    const path = home(); const git = new RealGitRunner(); const playbookPath = join(path, "playbook", "playbook.md");
    const before = readFileSync(playbookPath, "utf8");
    const applied = await applyOperatorDelta(path, {
      op: "edit", id: "B1", text: "Keep one observable feature in each fresh session.",
      why: "Failure recovery remains local.", reason: "Correct the active build guidance.",
    }, { git, arbiter: async (input) => ({ conflicts: false, against: input.againstId, reason: "compatible" }),
      now: () => new Date("2026-09-05T15:00:00.000Z") });
    const result = await rollbackLatest(path, { confirm: true }, { git, now: () => new Date("2026-09-05T16:00:00.000Z") });
    expect(result).toMatchObject({ reverted: applied.commit, operatorDeltaId: "B1" });
    expect(readFileSync(playbookPath, "utf8")).toBe(before);
    const lines = readFileSync(join(path, "evolution", "deltas.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(7);
    expect(lines.at(-2)).toMatchObject({ operationId: applied.operationId, op: "edit" });
    expect(lines.at(-1)).toMatchObject({ operationId: result.operationId, op: "revert", id: "B1" });
    expect(await git.statusPorcelain(path)).toBe("");
    expect(await git.hasTrailer(path, "Kiln-Rollback-Of", applied.commit!)).toBe(true);
  });

  test("surfaces the typed contract error when trailer discovery is unavailable", async () => {
    const path = home(); const fake = new FakeGitRunner();
    const git = { ...fake, statusPorcelain: fake.statusPorcelain.bind(fake), revParseHead: fake.revParseHead.bind(fake), trailerValues: undefined } as never;
    await expect(rollbackLatest(path, { confirm: true }, { git })).rejects.toBeInstanceOf(RollbackError);
  });
});
