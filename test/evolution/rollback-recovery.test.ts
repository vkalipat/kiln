import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitRunner, type GitCommitOptions } from "../../src/build/git";
import { initHome } from "../../src/core/home";
import { applyOperatorDelta } from "../../src/evolution/operator";
import { rollbackLatest } from "../../src/evolution/rollback";
import { listIntents, replaceIntent } from "../../src/evolution/transaction";

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-rollback-recovery-")); initHome(home);
  const git = new RealGitRunner(); writeFileSync(join(home, "operator-note.md"), "base\n"); await git.commit(home, { message: "operator note baseline" });
  const before = readFileSync(join(home, "playbook", "playbook.md"), "utf8");
  await applyOperatorDelta(home, { op: "edit", id: "B1", text: "Keep one observable feature in each fresh session.", why: "Failure recovery remains local.", reason: "Exercise durable rollback." },
    { git, arbiter: async () => ({ conflicts: false, against: null, reason: "compatible" }) });
  return { home, before, git };
}

test("rollback resumes after the inverse and preserves unrelated staged and unstaged bytes", async () => {
  const { home, before } = await fixture(); let reverts = 0;
  class Interrupted extends RealGitRunner {
    override async revert(dir: string, sha: string, options: { noCommit: true }): Promise<void> {
      reverts += 1; await super.revert(dir, sha, options); throw new Error("interrupted after inverse");
    }
  }
  const git = new Interrupted();
  await expect(rollbackLatest(home, { confirm: true }, { git })).rejects.toThrow("interrupted after inverse");
  expect(listIntents(home, "rollback")).toHaveLength(1);
  writeFileSync(join(home, "operator-note.md"), "staged\n");
  expect(Bun.spawnSync(["git", "add", "operator-note.md"], { cwd: home }).exitCode).toBe(0);
  writeFileSync(join(home, "operator-note.md"), "unstaged\n");
  const result = await rollbackLatest(home, { confirm: true }, { git });
  expect(reverts).toBe(1); expect(result.commit).toBeString();
  expect(readFileSync(join(home, "playbook", "playbook.md"), "utf8")).toBe(before);
  expect(Bun.spawnSync(["git", "show", ":operator-note.md"], { cwd: home }).stdout.toString()).toBe("staged\n");
  expect(Bun.spawnSync(["git", "show", "HEAD:operator-note.md"], { cwd: home }).stdout.toString()).toBe("base\n");
  expect(readFileSync(join(home, "operator-note.md"), "utf8")).toBe("unstaged\n");
  expect(listIntents(home, "rollback")).toHaveLength(0);
});

test("rollback recovers a lost commit acknowledgement without a second revert or journal entry", async () => {
  const { home, before } = await fixture(); let commits = 0;
  class LostAck extends RealGitRunner {
    override async commit(dir: string, options: GitCommitOptions): Promise<string> {
      commits += 1; await super.commit(dir, options); throw new Error("lost rollback acknowledgement");
    }
  }
  const git = new LostAck();
  await expect(rollbackLatest(home, { confirm: true }, { git })).rejects.toThrow("lost rollback acknowledgement");
  const journal = readFileSync(join(home, "evolution", "deltas.jsonl"), "utf8"); const head = await git.revParseHead(home);
  const recovered = await rollbackLatest(home, { confirm: true }, { git });
  expect(recovered.commit).toBe(head); expect(commits).toBe(1);
  expect(readFileSync(join(home, "evolution", "deltas.jsonl"), "utf8")).toBe(journal);
  expect(readFileSync(join(home, "playbook", "playbook.md"), "utf8")).toBe(before);
  expect(await git.statusPorcelain(home)).toBe("");
});

test("unsafe trailer identifiers are refused before a revert or any cleanup", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-rollback-id-")); initHome(home); const git = new RealGitRunner();
  writeFileSync(join(home, "keep.txt"), "keep\n"); await git.commit(home, { message: "unrelated", trailers: { "Kiln-Candidate": "../outside" } });
  const head = await git.revParseHead(home);
  await expect(rollbackLatest(home, { confirm: true }, { git })).rejects.toMatchObject({ reason: "git_contract" });
  expect(await git.revParseHead(home)).toBe(head); expect(readFileSync(join(home, "keep.txt"), "utf8")).toBe("keep\n");
  expect(await git.statusPorcelain(home)).toBe("");
});

test("tampered recovery metadata cannot expand a rollback write set", async () => {
  const { home } = await fixture();
  class Interrupted extends RealGitRunner { override async revert(): Promise<void> { throw new Error("before inverse"); } }
  const git = new Interrupted();
  await expect(rollbackLatest(home, { confirm: true }, { git })).rejects.toThrow("before inverse");
  const held = listIntents<any>(home, "rollback")[0]!;
  replaceIntent(home, held, { ...held, result: { ...held.result, paths: [...held.result.paths, "operator-note.md"] } });
  const before = readFileSync(join(home, "playbook", "playbook.md"), "utf8");
  await expect(rollbackLatest(home, { confirm: true }, { git })).rejects.toMatchObject({ reason: "git_contract" });
  expect(readFileSync(join(home, "playbook", "playbook.md"), "utf8")).toBe(before);
  expect(readFileSync(join(home, "operator-note.md"), "utf8")).toBe("base\n");
});
