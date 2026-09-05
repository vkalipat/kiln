import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitRunner, type GitCommitOptions } from "../../src/build/git";
import { initHome } from "../../src/core/home";
import { applyOperatorDelta } from "../../src/evolution/operator";
import { listIntents } from "../../src/evolution/transaction";

const request = { op: "edit" as const, id: "B1", text: "Keep one feature in each fresh builder session.", why: "Isolated context makes failed attempts easier to replace.", reason: "Recover this observed operator correction." };
const fresh = () => { const home = mkdtempSync(join(tmpdir(), "kiln-operator-recovery-")); initHome(home); return home; };

test("a failed operator commit retains a resumable intent and never deletes unrelated new files", async () => {
  const home = fresh(); const journal = join(home, "evolution", "deltas.jsonl");
  const originalLines = readFileSync(journal, "utf8").trim().split("\n").length;
  let fail = true; let decisions = 0;
  class FailingGit extends RealGitRunner {
    override async commit(dir: string, options: GitCommitOptions): Promise<string> {
      if (fail) throw new Error("simulated commit failure");
      return super.commit(dir, options);
    }
  }
  const git = new FailingGit();
  const arbiter = async () => { decisions += 1; writeFileSync(join(home, "operator-note.md"), "keep my concurrent work\n"); return { conflicts: false, against: null, reason: "compatible" }; };
  await expect(applyOperatorDelta(home, request, { git, arbiter })).rejects.toThrow("simulated commit failure");
  expect(readFileSync(join(home, "operator-note.md"), "utf8")).toBe("keep my concurrent work\n");
  expect(listIntents(home, "operator")).toHaveLength(1);
  const count = decisions; fail = false;
  const recovered = await applyOperatorDelta(home, request, { git, arbiter });
  expect(recovered.commit).toBeString(); expect(decisions).toBe(count);
  expect(listIntents(home, "operator")).toHaveLength(0);
  expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(originalLines + 1);
  expect(await git.statusPorcelain(home)).toContain("operator-note.md");
  const repeated = await applyOperatorDelta(home, request, { git, arbiter });
  expect(repeated).toMatchObject({ idempotent: true, championBefore: recovered.championBefore, championAfter: recovered.championAfter, conflictChecks: recovered.conflictChecks });
});

test("lost commit acknowledgement recovers once without re-buying semantic checks", async () => {
  const home = fresh(); let committed = false; let decisions = 0;
  class LostAckGit extends RealGitRunner {
    override async commit(dir: string, options: GitCommitOptions): Promise<string> {
      const sha = await super.commit(dir, options); committed = true; throw new Error(`lost acknowledgement ${sha}`);
    }
  }
  const git = new LostAckGit();
  const arbiter = async () => { decisions += 1; return { conflicts: false, against: null, reason: "compatible" }; };
  await expect(applyOperatorDelta(home, request, { git, arbiter })).rejects.toThrow("lost acknowledgement");
  expect(committed).toBe(true); const count = decisions;
  const head = await git.revParseHead(home);
  const result = await applyOperatorDelta(home, request, { git, arbiter });
  expect(result.idempotent).toBe(true); expect(decisions).toBe(count);
  expect(await git.revParseHead(home)).toBe(head);
  expect(listIntents(home, "operator")).toHaveLength(0);
});

test("a diverged owned file fails closed while keeping the pending intent and user bytes", async () => {
  const home = fresh();
  class FailingGit extends RealGitRunner { override async commit(): Promise<string> { throw new Error("crash"); } }
  const git = new FailingGit(); const arbiter = async () => ({ conflicts: false, against: null, reason: "compatible" });
  await expect(applyOperatorDelta(home, request, { git, arbiter })).rejects.toThrow("crash");
  const playbook = join(home, "playbook", "playbook.md"); writeFileSync(playbook, "operator changed this after interruption\n");
  await expect(applyOperatorDelta(home, request, { git, arbiter })).rejects.toThrow("transaction_conflict");
  expect(readFileSync(playbook, "utf8")).toBe("operator changed this after interruption\n");
  expect(existsSync(join(home, "evolution", "deltas.jsonl"))).toBe(true);
  expect(listIntents(home, "operator")).toHaveLength(1);
});

test("an already matching correction still guards its playbook and journals the new operator reason", async () => {
  const home = fresh(); const git = new RealGitRunner(); const arbiter = async () => ({ conflicts: false, against: null, reason: "compatible" });
  const first = await applyOperatorDelta(home, request, { git, arbiter });
  const repeatedText = await applyOperatorDelta(home, { ...request, reason: "Independently reconfirm this already matching correction." }, { git, arbiter });
  expect(repeatedText.championBefore).toBe(first.championAfter);
  expect(repeatedText.championAfter).toBe(first.championAfter);
  expect(repeatedText.commit).not.toBe(first.commit);
  expect(await git.statusPorcelain(home)).toBe("");
});

test("recovery rejects tampered result, trailer, or hash bindings before another side effect", async () => {
  const cases: Array<[string, (intent: any) => void]> = [
    ["trailers", (intent) => { intent.result.trailers = {}; }],
    ["result shape", (intent) => { intent.result.value.conflictChecks = ["not a verdict"]; }],
    ["result hash", (intent) => { intent.result.value.championAfter = "0".repeat(64); }],
    ["transition hash", (intent) => { intent.transitions.find((item: any) => item.path === "playbook/playbook.md").after += "tampered\n"; }],
  ];
  for (const [label, tamper] of cases) {
    const home = fresh(); let fail = true; let commitAttempts = 0;
    class FailingGit extends RealGitRunner {
      override async commit(dir: string, options: GitCommitOptions): Promise<string> {
        commitAttempts += 1;
        if (fail) throw new Error("prepare pending intent");
        return super.commit(dir, options);
      }
    }
    const git = new FailingGit(); const arbiter = async () => ({ conflicts: false, against: null, reason: "compatible" });
    await expect(applyOperatorDelta(home, request, { git, arbiter })).rejects.toThrow("prepare pending intent");
    const dir = join(home, "evolution", "work", "transactions"); const path = join(dir, readdirSync(dir)[0]!);
    const intent = JSON.parse(readFileSync(path, "utf8")); tamper(intent); writeFileSync(path, `${JSON.stringify(intent, null, 2)}\n`);
    const playbook = readFileSync(join(home, "playbook", "playbook.md")); const journal = readFileSync(join(home, "evolution", "deltas.jsonl"));
    fail = false;
    await expect(applyOperatorDelta(home, request, { git, arbiter })).rejects.toThrow(`incomplete_operation`);
    expect(commitAttempts, label).toBe(1);
    expect(readFileSync(join(home, "playbook", "playbook.md")).equals(playbook), label).toBe(true);
    expect(readFileSync(join(home, "evolution", "deltas.jsonl")).equals(journal), label).toBe(true);
    expect(existsSync(path), label).toBe(true);
  }
});

test("real-file guards reject model-bound symlinks before the arbiter sees their bytes", async () => {
  for (const relative of ["playbook/playbook.md", "prompts/builder.md", "prompts/kernel.md"]) {
    const home = fresh(); const target = join(home, relative); const original = readFileSync(target);
    const outside = join(mkdtempSync(join(tmpdir(), "kiln-operator-input-")), "outside.md");
    writeFileSync(outside, relative.startsWith("playbook/") ? original : Buffer.from(`EXTERNAL ${relative}\n`));
    unlinkSync(target); symlinkSync(outside, target);
    const committed = Bun.spawnSync(["git", "add", "--", relative], { cwd: home });
    expect(committed.exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "commit", "-q", "-m", `test symlink ${relative}`], { cwd: home }).exitCode).toBe(0);
    let decisions = 0;
    await expect(applyOperatorDelta(home, request, {
      git: new RealGitRunner(),
      arbiter: async () => { decisions += 1; return { conflicts: false, against: null, reason: "must not run" }; },
    })).rejects.toMatchObject({ reason: "integrity" });
    expect(decisions).toBe(0);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside).equals(relative.startsWith("playbook/") ? original : Buffer.from(`EXTERNAL ${relative}\n`))).toBe(true);
    expect(listIntents(home, "operator")).toEqual([]);
  }
});
