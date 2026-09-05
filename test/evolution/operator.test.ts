import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitRunner } from "../../src/build/git";
import { initHome } from "../../src/core/home";
import { applyOperatorDelta, OperatorApplyError, type ConflictInput } from "../../src/evolution/operator";
import { FakeGitRunner } from "../build/fake-git";

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "kiln-operator-"));
  initHome(path);
  return path;
}

const request = {
  op: "edit" as const,
  id: "B1",
  text: "Keep one feature in each fresh builder session.",
  why: "Isolated context makes failed attempts easier to replace.",
  reason: "Correct the durable build procedure after observed retries.",
};

describe("operator delta", () => {
  test("validates, checks prompt and siblings, resets counters, journals once, and commits once", async () => {
    const path = home();
    const playbookPath = join(path, "playbook", "playbook.md");
    writeFileSync(playbookPath, readFileSync(playbookPath, "utf8").replace("B1 [helpful:0 harmful:0]", "B1 [helpful:7 harmful:2]"));
    // Keep the real home baseline clean; the fake is the unit-test commit seam.
    Bun.spawnSync(["git", "add", "playbook/playbook.md"], { cwd: path });
    Bun.spawnSync(["git", "commit", "-q", "-m", "test counters"], { cwd: path });
    const git = new FakeGitRunner();
    const calls: ConflictInput[] = [];
    const arbiter = async (input: ConflictInput) => {
      calls.push(input);
      return { conflicts: false, against: input.againstId, reason: "compatible" };
    };

    const result = await applyOperatorDelta(path, request, { git, arbiter, now: () => new Date("2026-09-05T12:00:00.000Z") });
    expect(result.idempotent).toBe(false);
    expect(result.operationId).toMatch(/^operator-[a-f0-9]{20}$/);
    expect(calls).toHaveLength(4); // role prompt plus B2-B4
    expect(calls[0]).toMatchObject({ kind: "role_prompt", againstId: null });
    expect(calls.slice(1).every((call) => call.kind === "sibling")).toBe(true);
    expect(readFileSync(playbookPath, "utf8")).toContain("B1 [helpful:0 harmful:0] Keep one feature in each fresh builder session. Why: Isolated context makes failed attempts easier to replace.");

    const lines = readFileSync(join(path, "evolution", "deltas.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry).toMatchObject({ seq: 6, operationId: result.operationId, source: "operator", op: "edit", section: "build", id: "B1", author: "operator" });
    expect(entry.commit).toBeUndefined();
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.options.trailers).toMatchObject({ "Kiln-Operator-Delta": "B1", "Kiln-Operation": result.operationId });

    const repeated = await applyOperatorDelta(path, request, { git, arbiter });
    expect(repeated).toMatchObject({ operationId: result.operationId, idempotent: true });
    expect(repeated.commit).toBeUndefined();
    expect(git.commits).toHaveLength(1);
    expect(readFileSync(join(path, "evolution", "deltas.jsonl"), "utf8").trim().split("\n")).toHaveLength(6);
  });

  test("retires against the actual counter metric, including zero, and separately refuses manifest drift", async () => {
    const path = home(); const git = new FakeGitRunner(); let calls = 0;
    const arbiter = async (input: ConflictInput) => { calls += 1; return { conflicts: false, against: input.againstId, reason: "ok" }; };
    await applyOperatorDelta(path, { op: "retire", id: "B2", reason: "Conflicts with the current operator contract." }, { git, arbiter });
    expect(calls).toBe(4);
    const entry = JSON.parse(readFileSync(join(path, "evolution", "deltas.jsonl"), "utf8").trim().split("\n").at(-1)!);
    expect(entry.evidence).toEqual([{ kind: "metric", ref: "operator.target.harmful" }]);

    const drifted = home(); const other = new FakeGitRunner();
    writeFileSync(join(drifted, "evals", "judge-rubric.md"), "drift\n");
    await expect(applyOperatorDelta(drifted, request, { git: other, arbiter })).rejects.toMatchObject({ reason: "integrity" });
    expect(other.commits).toHaveLength(0);
  });

  test("refuses a recorded semantic conflict before touching the playbook", async () => {
    const path = home(); const git = new FakeGitRunner();
    const before = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    const arbiter = async (input: ConflictInput) => ({ conflicts: input.kind === "sibling", against: input.againstId, reason: "contradicts held guidance" });
    await expect(applyOperatorDelta(path, request, { git, arbiter })).rejects.toBeInstanceOf(OperatorApplyError);
    expect(readFileSync(join(path, "playbook", "playbook.md"), "utf8")).toBe(before);
    expect(git.commits).toHaveLength(0);
  });

  test("real Git stores the journal and playbook in the operator commit and can stage a revert", async () => {
    const path = home(); const git = new RealGitRunner();
    const initial = await git.revParseHead(path);
    const result = await applyOperatorDelta(path, request, {
      git,
      arbiter: async (input) => ({ conflicts: false, against: input.againstId, reason: "compatible" }),
    });
    expect(result.commit).not.toBe(initial);
    expect(await git.statusPorcelain(path)).toBe("");
    expect(await git.hasTrailer(path, "Kiln-Operation", result.operationId)).toBe(true);
    expect(Bun.spawnSync(["git", "show", "--format=", "--name-only", result.commit!], { cwd: path }).stdout.toString()).toContain("evolution/deltas.jsonl");

    await git.revert(path, result.commit!, { noCommit: true });
    expect(await git.revParseHead(path)).toBe(result.commit!);
    expect(await git.statusPorcelain(path)).not.toBe("");
  });
});
