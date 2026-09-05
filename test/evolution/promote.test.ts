import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitRunner } from "../../src/build/git";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { candidatePath } from "../../src/core/paths";
import type { Candidate } from "../../src/evolution/candidate";
import { rollbackLatest } from "../../src/evolution/rollback";
import {
  archivedPlaybook,
  promotedPlaybook,
  promoteCandidate,
  promotionGate,
  PromoteError,
  type PromotionGateInput,
} from "../../src/evolution/promote";
import { playbookHash } from "../../src/evolution/playbook";
import { FakeGitRunner } from "../build/fake-git";

const at = "2026-09-05T15:00:00.000Z";

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "kiln-promote-")); initHome(path); return path;
}

function candidate(playbook: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    version: 1, kind: "playbook", playbookHash: playbookHash(playbook), author: "operator", createdAt: at,
    delta: { op: "edit", section: "build", id: "B1", text: "Keep each builder session narrowly testable.",
      why: "Failures remain replaceable.", evidence: [{ kind: "metric", ref: "features.passed" }] },
    ...patch,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stageCandidate(path: string, id: string, value: Candidate, report: Record<string, unknown> | false = reportFixture()): void {
  writeJson(candidatePath(path, id), value);
  if (report !== false) writeJson(join(path, "evolution", "reports", id, "eval.json"), {
    candidateId: id, candidate: value, playbookHash: value.playbookHash,
    class: value.delta?.section === "form" || value.prompt?.name === "critic" ? "form" : "build",
    ...report,
  });
}

function reportFixture(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "win", effortSwept: true, judgeCalibration: { status: "absent" },
    passes: { heldout: { rate: 0.625 } }, usdPerSuccess: { candidate: 16, champion: 10 }, ...patch,
  };
}

const manifestOk = () => ({ ok: true, changed: [], missing: [], extra: [] });
const noLeaks = () => ({ ok: true, rows: [], manifest: manifestOk() });

describe("promotion gate", () => {
  const good: PromotionGateInput = {
    manifestOk: true, dirty: false, locked: false, incompleteEval: false, reportExists: true,
    leak: false, activeBullets: 19, effortSwept: true, judgeBased: false,
    judgeCalibrationStatus: "absent", verdict: "win", heldoutRate: 0.6,
  };

  test("checks all ten refusal rungs in binding order", () => {
    const cases: Array<[Partial<PromotionGateInput>, number, string]> = [
      [{ manifestOk: false, dirty: true, locked: true, candidateError: "bad", reportExists: false }, 1, "integrity"],
      [{ dirty: true, locked: true, candidateError: "bad", reportExists: false }, 2, "dirty_tree"],
      [{ locked: true, candidateError: "bad", reportExists: false }, 3, "locked"],
      [{ incompleteEval: true, candidateError: "bad", reportExists: false }, 3, "incomplete_eval"],
      [{ candidateError: "stale_champion", reportExists: false }, 4, "stale_champion"],
      [{ candidateError: "malformed", reportExists: false }, 4, "invalid"],
      [{ reportExists: false, leak: true, activeBullets: 121, effortSwept: false }, 5, "missing_report"],
      [{ leak: true, activeBullets: 121, effortSwept: false }, 6, "leak"],
      [{ activeBullets: 121, effortSwept: false }, 7, "playbook_overflow"],
      [{ effortSwept: false, judgeBased: true }, 8, "unswept_effort"],
      [{ judgeBased: true, judgeCalibrationStatus: "agent" }, 9, "uncalibrated_judge"],
      [{ verdict: "lose", confirm: true }, 10, "lost_heldout"],
    ];
    for (const [patch, rung, reason] of cases) {
      const result = promotionGate({ ...good, ...patch });
      expect(result).toMatchObject({ ok: false, refusal: { rung, reason } });
    }
  });

  test("confirmation flips only not_evidence above 0.5 and cost is not a rung", () => {
    expect(promotionGate({ ...good, verdict: "not_evidence", heldoutRate: 0.5001, confirm: true })).toEqual({ ok: true, confirmed: true });
    expect(promotionGate({ ...good, verdict: "not_evidence", heldoutRate: 0.9, confirm: true, confirmEligible: false })).toMatchObject({ ok: false, refusal: { reason: "not_evidence" } });
    expect(promotionGate({ ...good, verdict: "not_evidence", heldoutRate: 0.5, confirm: true })).toMatchObject({ ok: false, refusal: { rung: 10 } });
    expect(promotionGate({ ...good, verdict: "censored", heldoutRate: 0.9, confirm: true })).toMatchObject({ ok: false, refusal: { reason: "censored" } });
    expect(promotionGate({ ...good, verdict: "win" })).toEqual({ ok: true, confirmed: false });
  });
});

describe("promotion counters", () => {
  const md = "## build\n- B1 [helpful:3 harmful:2] Legacy one.\n- B4 [helpful:1 harmful:0] Legacy four.\n";

  test("starts adds at helpful one, confirms edits, and marks harmful winning retirements", () => {
    const add = candidate(md, { delta: { op: "add", section: "build", text: "Verify the visible slice.", why: "Evidence stays local.", evidence: [] } });
    expect(promotedPlaybook(md, add, "add-candidate", at).text).toContain("B5 [helpful:1 harmful:0]");
    expect(promotedPlaybook(md, candidate(md), "edit-candidate", at).text).toContain("B1 [helpful:4 harmful:2]");
    const retire = candidate(md, { delta: { op: "retire", section: "build", id: "B1", text: "", evidence: [] } });
    expect(promotedPlaybook(md, retire, "retire-candidate", at).text).toContain("B1 [helpful:3 harmful:3] Legacy one. (retired");
  });

  test("a lost edit or retirement confirms the incumbent target only", () => {
    expect(archivedPlaybook(md, candidate(md), "lost_heldout")).toContain("B1 [helpful:4 harmful:2]");
    expect(archivedPlaybook(md, candidate(md), "invalid")).toBe(md);
    const add = candidate(md, { delta: { op: "add", section: "build", text: "New.", why: "Useful.", evidence: [] } });
    expect(archivedPlaybook(md, add, "lost_dev")).toBe(md);
  });
});

describe("promoteCandidate", () => {
  test("promotes despite a cost warning, journals, trailers, and archives other pending candidates", async () => {
    const path = home(); const git = new FakeGitRunner(); const playbookPath = join(path, "playbook", "playbook.md");
    const champion = readFileSync(playbookPath, "utf8");
    writeFileSync(playbookPath, champion.replace("B1 [helpful:0 harmful:0]", "B1 [helpful:7 harmful:2]"));
    const current = readFileSync(playbookPath, "utf8");
    stageCandidate(path, "winner", candidate(current), reportFixture({ verdict: "not_evidence", passes: { heldout: { rate: 0.9 } } })); stageCandidate(path, "other", candidate(current), false);
    const result = await promoteCandidate(path, { id: "winner", confirm: true }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at) });
    expect(result).toMatchObject({ id: "winner", confirmed: true, costFlag: { ratio: 1.6, flagged: true }, archived: ["other"], idempotent: false });
    expect(readFileSync(playbookPath, "utf8")).toContain("B1 [helpful:8 harmful:2]");
    expect(existsSync(candidatePath(path, "winner"))).toBe(false);
    expect(existsSync(join(path, "evolution", "promoted", "winner.json"))).toBe(true);
    expect(existsSync(join(path, "evolution", "archive", "other", "candidate.json"))).toBe(true);
    const journal = readFileSync(join(path, "evolution", "deltas.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(journal.at(-1)).toMatchObject({ operationId: result.operationId, candidateId: "winner", source: "operator" });
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.options.trailers).toMatchObject({ "Kiln-Candidate": "winner", "Kiln-Confirmed": "true", "Kiln-Cost-Ratio": 1.6 });
    expect(git.commits[0]!.options.paths).toEqual(expect.arrayContaining(["playbook/playbook.md", "evolution/promoted/winner.json", "evolution/reports/winner/eval.json", "evolution/archive/other/candidate.json", "evolution/archive/other/reason.json", "evolution/deltas.jsonl"]));
    const recovered = await promoteCandidate(path, { id: "winner" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at) });
    expect(recovered).toMatchObject({ operationId: result.operationId, confirmed: true, costFlag: { ratio: 1.6, flagged: true }, archived: ["other"], idempotent: true });
    expect(git.commits).toHaveLength(1);
  });

  test("archives a candidate-specific refusal and does not run later gates", async () => {
    const path = home(); const git = new FakeGitRunner(); const champion = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    stageCandidate(path, "no-report", candidate(champion), false);
    await expect(promoteCandidate(path, { id: "no-report" }, { git, config: defaultConfig(), verifyManifest: manifestOk,
      leakcheck: () => { throw new Error("later rung ran"); }, now: () => new Date(at) })).rejects.toMatchObject({ reason: "missing_report", rung: 5, archived: true });
    expect(existsSync(join(path, "evolution", "archive", "no-report", "reason.json"))).toBe(true);
    expect(git.commits[0]!.options.message).toBe("evolve(archive): no-report invalid");

    const missing = home(); const missingGit = new FakeGitRunner();
    await expect(promoteCandidate(missing, { id: "missing" }, { git: missingGit, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks }))
      .rejects.toMatchObject({ reason: "invalid", rung: 4, archived: false });
    expect(missingGit.commits).toHaveLength(0);
    await expect(promoteCandidate(missing, { id: "../escape" }, { git: missingGit, verifyManifest: manifestOk, leakcheck: noLeaks }))
      .rejects.toMatchObject({ reason: "invalid", rung: 4 });
  });

  test("archives a named incomplete eval as superseded in the promotion commit", async () => {
    const path = home(); const git = new FakeGitRunner(); const champion = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    stageCandidate(path, "winner", candidate(champion));
    stageCandidate(path, "abandoned", candidate(champion), reportFixture({ verdict: "incomplete" }));
    const result = await promoteCandidate(path, { id: "winner", abandonEvalId: "abandoned" }, {
      git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at),
    });
    expect(result.archived).toContain("abandoned");
    expect(JSON.parse(readFileSync(join(path, "evolution", "archive", "abandoned", "reason.json"), "utf8"))).toMatchObject({ reason: "superseded" });
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.options.paths).toContain("evolution/archive/abandoned/reason.json");
    const retry = await promoteCandidate(path, { id: "winner" }, {
      git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at),
    });
    expect(retry.idempotent).toBe(true);

    const nextChampion = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    stageCandidate(path, "next", candidate(nextChampion, { delta: { op: "edit", section: "build", id: "B2", text: "Keep inherited state explicit.", why: "Resumes stay auditable.", evidence: [] } }));
    const next = await promoteCandidate(path, { id: "next" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at) });
    expect(next.id).toBe("next");
  });

  test("never confirms form/checkpoint candidates and scopes dirty refusal to ruling 7", async () => {
    const path = home(); const git = new FakeGitRunner(); const champion = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    const form = candidate(champion, { delta: { op: "edit", section: "form", id: "FM1", text: "Refine plans only while evidence changes them.",
      why: "Unbounded refinement spends without signal.", evidence: [] } });
    stageCandidate(path, "form-candidate", form, reportFixture({ verdict: "not_evidence", passes: { heldout: { rate: 0.9 } } }));
    git.status = " M docs/operator-note.md\n M config.json\n"; git.diffText = "+ budgets.usd: 40\n";
    await expect(promoteCandidate(path, { id: "form-candidate", confirm: true }, {
      git, config: { ...defaultConfig(), evals: { ...defaultConfig().evals, sectionPhases: { ...defaultConfig().evals.sectionPhases,
        form: { through: "build", cloneAfter: "freeze" } } } }, verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at),
    })).rejects.toMatchObject({ reason: "not_evidence", rung: 10, archived: true });

    const protectedHome = home(); const protectedGit = new FakeGitRunner(); protectedGit.status = " M config.json\n"; protectedGit.diffText = "+ evals.judgeGate: removed\n";
    await expect(promoteCandidate(protectedHome, { id: "anything" }, {
      git: protectedGit, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks,
    })).rejects.toMatchObject({ reason: "dirty_tree", rung: 2 });

    const ideateHome = home(); const ideateGit = new FakeGitRunner(); const ideateChampion = readFileSync(join(ideateHome, "playbook", "playbook.md"), "utf8");
    stageCandidate(ideateHome, "frozen-ideate", candidate(ideateChampion), reportFixture({ class: "ideate", judgeCalibration: { status: "absent" } }));
    await expect(promoteCandidate(ideateHome, { id: "frozen-ideate" }, {
      git: ideateGit, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at),
    })).rejects.toMatchObject({ reason: "uncalibrated_judge", rung: 9, archived: true });

    const removedHome = home(); const removedGit = new FakeGitRunner(); const removedChampion = readFileSync(join(removedHome, "playbook", "playbook.md"), "utf8");
    stageCandidate(removedHome, "removed-gate", candidate(removedChampion), reportFixture({ class: "ideate", judgeCalibration: { status: "calibrated" } }));
    const removed = defaultConfig(); removed.evals.judgeGate = "removed";
    await expect(promoteCandidate(removedHome, { id: "removed-gate" }, {
      git: removedGit, config: removed, verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at),
    })).rejects.toMatchObject({ reason: "uncalibrated_judge", rung: 9, archived: true });
  });

  test("binds live candidate bytes to the exact evaluated candidate", async () => {
    const path = home(); const git = new FakeGitRunner(); const champion = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    const evaluated = candidate(champion); stageCandidate(path, "swapped", evaluated);
    const swapped = candidate(champion, { delta: { op: "edit", section: "build", id: "B2", text: "A different unevaluated lesson.", why: "This was swapped.", evidence: [] } });
    writeJson(candidatePath(path, "swapped"), swapped);
    await expect(promoteCandidate(path, { id: "swapped" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks,
      now: () => new Date(at) })).rejects.toMatchObject({ reason: "invalid", rung: 4, archived: true });
    expect(readFileSync(join(path, "playbook", "playbook.md"), "utf8")).toBe(champion);
  });

  test("uses raw NUL-delimited paths and keeps manifest verification first", async () => {
    const path = home(); const renamed = new FakeGitRunner(); renamed.statusZ = "R  docs/new.md\0prompts/old name.md\0";
    await expect(promoteCandidate(path, { id: "missing" }, { git: renamed, verifyManifest: manifestOk, leakcheck: noLeaks }))
      .rejects.toMatchObject({ reason: "dirty_tree", rung: 2 });
    const malformed = new FakeGitRunner(); malformed.statusZ = undefined; (malformed as unknown as { statusPorcelainZ?: unknown }).statusPorcelainZ = undefined;
    await expect(promoteCandidate(path, { id: "missing" }, { git: malformed, verifyManifest: manifestOk, leakcheck: noLeaks }))
      .rejects.toMatchObject({ reason: "git_contract", rung: 2 });
    await expect(promoteCandidate(path, { id: "../bad" }, { git: malformed,
      verifyManifest: () => ({ ok: false, changed: ["manifest.json"], missing: [], extra: [] }), leakcheck: noLeaks }))
      .rejects.toMatchObject({ reason: "integrity", rung: 1 });
  });

  test("retains a durable intent and every unrelated byte across commit failure, then resumes", async () => {
    class FailOnceGit extends RealGitRunner {
      failed = false;
      override async commit(dir: string, options: Parameters<RealGitRunner["commit"]>[1]): Promise<string> {
        if (!this.failed) { this.failed = true; throw new Error("injected commit failure"); }
        return super.commit(dir, options);
      }
    }
    const path = home(); const git = new FailOnceGit(); const playbook = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    const configPath = join(path, "config.json"); const changedConfig = readFileSync(configPath, "utf8").replace('"usd": 25', '"usd": 40');
    writeFileSync(configPath, changedConfig); const note = join(path, "operator-note.txt"); writeFileSync(note, "mine\n");
    stageCandidate(path, "winner", candidate(playbook));
    await expect(promoteCandidate(path, { id: "winner" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks,
      now: () => new Date(at) })).rejects.toThrow("injected commit failure");
    expect(readFileSync(configPath, "utf8")).toBe(changedConfig); expect(readFileSync(note, "utf8")).toBe("mine\n");
    expect(existsSync(join(path, "evolution", "reports", "winner", "eval.json"))).toBe(true);
    expect(existsSync(join(path, "evolution", "work", "transactions"))).toBe(true);
    const resumed = await promoteCandidate(path, { id: "winner", forceLock: true }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks,
      now: () => new Date(at) });
    expect(resumed).toMatchObject({ id: "winner", idempotent: false });
    expect(readFileSync(note, "utf8")).toBe("mine\n"); expect(readFileSync(configPath, "utf8")).toBe(changedConfig);
  });

  test("a hard pre-commit process exit resumes from its durable intent", () => {
    const path = home(); const playbook = readFileSync(join(path, "playbook", "playbook.md"), "utf8"); stageCandidate(path, "crash", candidate(playbook));
    const moduleUrl = new URL("../../src/evolution/promote.ts", import.meta.url).href;
    const configUrl = new URL("../../src/core/config.ts", import.meta.url).href;
    const gitUrl = new URL("../../src/build/git.ts", import.meta.url).href;
    const script = `
      const { promoteCandidate } = await import(${JSON.stringify(moduleUrl)});
      const { defaultConfig } = await import(${JSON.stringify(configUrl)});
      const { RealGitRunner } = await import(${JSON.stringify(gitUrl)});
      class KillGit extends RealGitRunner { async commit() { process.kill(process.pid, "SIGKILL"); return ""; } }
      await promoteCandidate(${JSON.stringify(path)}, { id: "crash" }, { git: new KillGit(), config: defaultConfig(),
        verifyManifest: () => ({ ok: true, changed: [], missing: [], extra: [] }),
        leakcheck: () => ({ ok: true, rows: [], manifest: { ok: true, changed: [], missing: [], extra: [] } }),
        now: () => new Date(${JSON.stringify(at)}) });`;
    const child = spawnSync(process.execPath, ["-e", script]); expect(child.signal).toBe("SIGKILL");
    const resume = Bun.spawnSync([process.execPath, "-e", `
      const { promoteCandidate } = await import(${JSON.stringify(moduleUrl)});
      const { defaultConfig } = await import(${JSON.stringify(configUrl)});
      const { RealGitRunner } = await import(${JSON.stringify(gitUrl)});
      const result = await promoteCandidate(${JSON.stringify(path)}, { id: "crash", forceLock: true }, { git: new RealGitRunner(), config: defaultConfig(),
        verifyManifest: () => ({ ok: true, changed: [], missing: [], extra: [] }),
        leakcheck: () => ({ ok: true, rows: [], manifest: { ok: true, changed: [], missing: [], extra: [] } }) });
      console.log(JSON.stringify(result));`]);
    expect(resume.exitCode, resume.stderr.toString()).toBe(0);
    expect(JSON.parse(resume.stdout.toString())).toMatchObject({ id: "crash", idempotent: false });
  });

  test("real Git rejects raw protected paths and excludes unrelated staged entries", async () => {
    const dirtyHome = home(); const dirtyGit = new RealGitRunner(); writeFileSync(join(dirtyHome, "prompts", "x y.md"), "protected\n");
    await expect(promoteCandidate(dirtyHome, { id: "missing" }, { git: dirtyGit, verifyManifest: manifestOk, leakcheck: noLeaks }))
      .rejects.toMatchObject({ reason: "dirty_tree", rung: 2 });

    const path = home(); const git = new RealGitRunner(); const champion = readFileSync(join(path, "playbook", "playbook.md"), "utf8");
    const notes = join(path, "operator-notes.txt"); writeFileSync(notes, "keep staged\n");
    expect(spawnSync("git", ["add", "operator-notes.txt"], { cwd: path }).status).toBe(0);
    stageCandidate(path, "scoped", candidate(champion));
    await promoteCandidate(path, { id: "scoped" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at) });
    const committed = spawnSync("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd: path, encoding: "utf8" }).stdout;
    expect(committed).not.toContain("operator-notes.txt");
    expect(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: path, encoding: "utf8" }).stdout.trim()).toBe("operator-notes.txt");
    expect(readFileSync(notes, "utf8")).toBe("keep staged\n");
  });

  test("real Git promotion and rollback are single clean commits with append-only journal history", async () => {
    const path = home(); const git = new RealGitRunner(); const playbookPath = join(path, "playbook", "playbook.md");
    const before = readFileSync(playbookPath, "utf8");
    stageCandidate(path, "first", candidate(before)); stageCandidate(path, "stale-other", candidate(before), false);
    const first = await promoteCandidate(path, { id: "first" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks, now: () => new Date(at) });
    expect(await git.statusPorcelain(path)).toBe("");
    expect(await git.hasTrailer(path, "Kiln-Operation", first.operationId)).toBe(true);
    expect(existsSync(join(path, "evolution", "archive", "stale-other", "candidate.json"))).toBe(true);

    const afterFirst = readFileSync(playbookPath, "utf8");
    const second = candidate(afterFirst, { delta: { op: "edit", section: "build", id: "B2", text: "Keep the environment as inherited state.",
      why: "Cross-session state stays explicit.", evidence: [] } });
    stageCandidate(path, "second", second);
    const promoted = await promoteCandidate(path, { id: "second" }, { git, config: defaultConfig(), verifyManifest: manifestOk, leakcheck: noLeaks,
      now: () => new Date("2026-09-05T15:30:00.000Z") });

    const rollback = await rollbackLatest(path, { confirm: true }, { git, now: () => new Date("2026-09-05T16:00:00.000Z") });
    expect(rollback).toMatchObject({ reverted: promoted.commit, candidateId: "second" });
    expect(readFileSync(playbookPath, "utf8")).toBe(afterFirst);
    expect(existsSync(join(path, "evolution", "promoted", "first.json"))).toBe(true);
    expect(existsSync(join(path, "evolution", "promoted", "second.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(path, "evolution", "archive", "second", "reason.json"), "utf8"))).toMatchObject({ reason: "rolled_back" });
    expect(existsSync(join(path, "evolution", "archive", "stale-other", "candidate.json"))).toBe(true);
    expect(readFileSync(join(path, "evolution", "deltas.jsonl"), "utf8").trim().split("\n")).toHaveLength(8);
    expect(await git.statusPorcelain(path)).toBe("");
    expect(await git.hasTrailer(path, "Kiln-Rollback-Of", promoted.commit!)).toBe(true);
    await expect(rollbackLatest(path, { confirm: true }, { git })).rejects.toMatchObject({ reason: "not_evolution_head" });
  });
});
