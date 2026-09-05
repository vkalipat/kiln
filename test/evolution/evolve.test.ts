import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type IdeaShape } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { candidatePath, writeAtomic } from "../../src/core/paths";
import { createRun, readStatus, writeStatus, type RunStatus } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { evalPairFloor, evolveEval, candidatePlan, cloneEvolutionRun, type EvolveEvalDeps } from "../../src/evolution/evolve";
import { playbookHash } from "../../src/evolution/playbook";
import type { Candidate } from "../../src/evolution/candidate";
import type { RunExecutorSpec, RunSummary } from "../../src/evals/executor";
import { loadSeeds } from "../../src/evals/seeds";
import { FakeGitRunner } from "../build/fake-git";

function fixture(prompt = "brain") {
  const home = mkdtempSync(join(tmpdir(), "kiln-evolve-")); initHome(home);
  const cfg = defaultConfig(); const id = "candidate-1";
  const hash = playbookHash(readFileSync(join(home, "playbook", "playbook.md"), "utf8"));
  const candidate: Candidate = { version: 1, kind: "prompt", playbookHash: hash, author: "operator", createdAt: "2026-09-05T12:00:00.000Z",
    prompt: { name: prompt as never, text: `# Replacement ${prompt}\n\nUse the fixture instruction.\n` } };
  writeAtomic(candidatePath(home, id), `${JSON.stringify(candidate)}\n`);
  return { home, cfg, id, candidate };
}

function summary(spec: RunExecutorSpec, costUsd = 0, kind: "success" | "failure" | "honest_exit" = "success"): RunSummary {
  const outcome = kind === "success" ? { kind } as const : kind === "failure"
    ? { kind, failureClass: "verify" as const, message: "fixture failure" }
    : { kind, exitKind: "no_idea_clears_bar", reasons: ["fixture"] };
  const status: RunStatus = { id: spec.runId, phase: spec.through === "ideate" ? "ideate" : "build", state: kind === "failure" ? "failed" : "done",
    outcome, usdSpent: costUsd, turns: {}, seed: spec.seedIdentity, createdAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z" };
  return { runId: spec.runId, seedId: spec.seedIdentity.id, split: spec.seedIdentity.split, shape: "unknown", arm: spec.arm, status, outcome, costUsd, metrics: {} };
}

function dependencies(overrides: Partial<EvolveEvalDeps> = {}) {
  const git = new FakeGitRunner(); const calls: RunExecutorSpec[] = []; const archived: Array<{ reason: string; detail: string }> = []; let judgeCalls = 0;
  const deps: EvolveEvalDeps = {
    git,
    executor: async (spec) => { calls.push(spec); return summary(spec); },
    judge: async ({ seed }) => { judgeCalls += 1; return Array.from({ length: 4 }, () => ({ score: 0.5, seedId: seed.id })); },
    arbiter: async () => ({ conflicts: false, against: null, reason: "independent" }),
    archive: async (reason, detail) => { archived.push({ reason, detail }); },
    models: (role) => ({ model: { id: role, provider: "mock", thinking: { efforts: ["low", "medium", "high", "xhigh"] } } as never, ref: `mock/${role}` }),
    clone: () => {},
    boundaryReady: () => true,
    ...overrides,
  };
  return { deps, git, calls, archived, judgeCalls: () => judgeCalls };
}

describe("evolution plan and floor", () => {
  test("maps prompt and playbook classes through configured clone boundaries", () => {
    const cfg = defaultConfig();
    expect(candidatePlan(fixture("brain").candidate, cfg)).toMatchObject({ class: "ideate", role: "brain", plan: { through: "ideate", cloneAfter: "none" } });
    expect(candidatePlan(fixture("critic").candidate, cfg)).toMatchObject({ class: "form", role: "critic", plan: { through: "build", cloneAfter: "checkpoint" } });
    expect(candidatePlan(fixture("builder").candidate, cfg)).toMatchObject({ class: "build", role: "builder", plan: { through: "build", cloneAfter: "freeze" } });
  });

  test("derives the pre-registered one-pair ceilings", () => {
    const cfg = defaultConfig(); expect(evalPairFloor(cfg, "ideate")).toBeCloseTo(23.24); expect(evalPairFloor(cfg, "build")).toBeCloseTo(49.5);
    cfg.evals.runBudgetUsd = 50;
    expect(evalPairFloor(cfg, "ideate")).toBeCloseTo(46.24);
    expect(evalPairFloor(cfg, "build")).toBeCloseTo(99);
  });
});

describe("evolveEval", () => {
  test("a clear dev loss archives and never executes held-out", async () => {
    const f = fixture(); const d = dependencies({ judge: async ({ seed }) => Array.from({ length: 4 }, () => ({ score: 0, seedId: seed.id })) });
    const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 600 }, d.deps);
    expect(report).toMatchObject({ verdict: "lose", stoppedEarly: "lost_dev", passes: { dev: { pairs: 48, wins: 0 } } });
    expect(d.calls).toHaveLength(24); expect(new Set(d.calls.map((call) => call.seedIdentity.split))).toEqual(new Set(["dev"]));
    expect(d.archived[0]?.reason).toBe("lost_dev");
  });

  test("a marginal dev pass runs held-out and persists each run before judging", async () => {
    const f = fixture(); let reportHadBothRows = true; const d = dependencies();
    d.deps.judge = async ({ evalDir, seed }) => {
      const report = JSON.parse(readFileSync(join(evalDir, "eval.json"), "utf8"));
      reportHadBothRows &&= report.runs.filter((row: { seedId: string }) => row.seedId === seed.id).length === 2;
      return Array.from({ length: 4 }, () => ({ score: 0.5, seedId: seed.id }));
    };
    const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 600 }, d.deps);
    expect(report.passes.dev.pairs).toBe(48); expect(report.passes.heldout.pairs).toBe(48);
    expect(d.calls).toHaveLength(48); expect(reportHadBothRows).toBe(true); expect(report.verdict).toBe("lose");
    expect(d.calls[0]?.effort).toMatchObject({ brain: { level: "high", source: "config" }, generator: { level: "medium", source: "config" }, judge: { level: "medium", source: "config" } });
  });

  test("failed arms are recorded and excluded without calling the judge", async () => {
    const f = fixture(); const d = dependencies({ executor: async (spec) => summary(spec, 0, spec.arm === "candidate" ? "failure" : "success") });
    const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 600 }, d.deps);
    expect(d.judgeCalls()).toBe(0); expect(report.verdict).toBe("censored"); expect(report.runs.some((row) => row.failedClass === "verify")).toBe(true);
  });

  test("persists durable censor history and restores it without judging on resume", async () => {
    const f = fixture(); const d = dependencies({
      executor: async (spec) => { d.calls.push(spec); return { ...summary(spec), censorStops: ["budget"] }; },
      judge: async () => { throw new Error("censored pairs must not be judged"); },
    });
    const first = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 600 }, d.deps);
    expect(first.verdict).toBe("censored");
    expect(first.runs.every((row) => row.censorStops?.includes("budget") && row.pairCensoredBy.includes("budget"))).toBe(true);
    const calls = d.calls.length;
    const resumed = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 600 }, d.deps);
    expect(resumed.verdict).toBe("censored"); expect(d.calls).toHaveLength(calls);
  });

  test("build candidates use paired feature outcomes and form candidates remain not_evidence", async () => {
    const build = fixture("builder"); const bd = dependencies({ buildPairs: ({ seed }) => Array.from({ length: 4 }, () => ({ score: 1, seedId: seed.id })) });
    const built = await evolveEval(build.home, build.id, build.cfg, { budgetUsd: 1300 }, bd.deps);
    expect(built.class).toBe("build"); expect(built.passes.heldout.pairs).toBe(48); expect(built.verdict).toBe("win");
    expect(bd.calls).toHaveLength(72);

    const form = fixture("critic"); const fd = dependencies();
    const formed = await evolveEval(form.home, form.id, form.cfg, { budgetUsd: 1300 }, fd.deps);
    expect(formed.class).toBe("form"); expect(formed.passes.heldout.pairs).toBe(12); expect(formed.verdict).toBe("not_evidence");
  });

  test("build candidates score durable feature outcomes when one post-clone arm honestly exits", async () => {
    const f = fixture("builder"); let pairCalls = 0;
    const d = dependencies({
      executor: async (spec) => {
        d.calls.push(spec);
        return summary(spec, 0, spec.through === "build" && spec.arm === "candidate" ? "honest_exit" : "success");
      },
      buildPairs: ({ seed }) => { pairCalls += 1; return Array.from({ length: 4 }, () => ({ score: 0, seedId: seed.id })); },
    });
    const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 1300 }, d.deps);
    expect(report).toMatchObject({ verdict: "lose", stoppedEarly: "lost_dev", passes: { dev: { pairs: 48, wins: 0 } } });
    expect(pairCalls).toBe(12);
  });

  test("freezes effective per-run overrides and records them on every run row", async () => {
    const f = fixture(); f.cfg.evals.runBudgetUsd = 50; f.cfg.evals.runWallSeconds = 9_000;
    const d = dependencies();
    const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 1_200 }, d.deps);
    expect(report.projection.pairFloorUsd).toBeCloseTo(46.24);
    expect(report.frozen.budgets).toMatchObject({ usd: 50, wallSeconds: 9_000 });
    expect(report.runs.every((row) => row.runBudgetUsd === 50 && row.runWallSeconds === 9_000)).toBe(true);
    const calls = d.calls.length; f.cfg.evals.runBudgetUsd = 51;
    await expect(evolveEval(f.home, f.id, f.cfg, { budgetUsd: 1_200 }, d.deps)).rejects.toThrow("frozen config changed: budgets");
    expect(d.calls).toHaveLength(calls);
  });

  test("remaining budget starts exactly five complete seed pairs and resumes against frozen config", async () => {
    const f = fixture(); const floor = evalPairFloor(f.cfg, "ideate"); const d = dependencies({ executor: async (spec) => { d.calls.push(spec); return summary(spec, floor / 2); } });
    const first = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: floor * 5.5 }, d.deps);
    expect(first).toMatchObject({ verdict: "incomplete", stoppedReason: "budget", passes: { dev: { seeds: 5 } } });
    expect(d.calls).toHaveLength(10);
    const changed = defaultConfig(); changed.evals.pairsPerSeed = 8;
    await expect(evolveEval(f.home, f.id, changed, { budgetUsd: 600 }, d.deps)).rejects.toThrow("frozen config changed: k");
    expect(d.archived).toHaveLength(0); expect(d.calls).toHaveLength(10);
  });

  test("archive terminality precedes candidate-not-found and unrelated config diffs do not false-block", async () => {
    const terminal = fixture(); mkdirSync(join(terminal.home, "evolution", "archive", terminal.id), { recursive: true }); unlinkSync(candidatePath(terminal.home, terminal.id));
    const td = dependencies(); await expect(evolveEval(terminal.home, terminal.id, terminal.cfg, { budgetUsd: 600 }, td.deps)).rejects.toThrow("archive is terminal");

    const allowed = fixture(); const ad = dependencies(); ad.git.status = " M config.json\n"; ad.git.diffText = '-  "usd": 25\n+  "usd": 30\n';
    await evolveEval(allowed.home, allowed.id, allowed.cfg, { budgetUsd: 600 }, ad.deps); expect(ad.calls).toHaveLength(48);
    const blocked = fixture(); const dd = dependencies(); dd.git.status = " M config.json\n"; dd.git.diffText = '-  "judgeGate": "calibrated"\n+  "judgeGate": "removed"\n';
    await expect(evolveEval(blocked.home, blocked.id, blocked.cfg, { budgetUsd: 600 }, dd.deps)).rejects.toThrow("judgeGate differs"); expect(dd.calls).toHaveLength(0);
  });

  test("rejects a budget below one pair before any arbiter or executor work", async () => {
    const f = fixture(); let arbiterCalls = 0; const d = dependencies({ arbiter: async () => { arbiterCalls += 1; return { conflicts: false, against: null, reason: "ok" }; } });
    await expect(evolveEval(f.home, f.id, f.cfg, { budgetUsd: 1 }, d.deps)).rejects.toThrow("below one pair ceiling");
    expect(arbiterCalls).toBe(0); expect(d.calls).toHaveLength(0);
  });

  test("runs the role-prompt plus five-nearest conflict checks and archives a semantic conflict", async () => {
    const f = fixture(); const seed = loadSeeds(f.home, "dev")[0]!; const source = createRun(f.home, seed.text, { id: "source-run" });
    writeStatus(source, { seed: { id: seed.id, split: seed.split, sha256: seed.sha256 }, shape: seed.shape });
    writeAtomic(source.digest, "# Digest\n\n## Summary\n\nA completed run.\n");
    const candidate: Candidate = { version: 1, kind: "playbook", playbookHash: f.candidate.playbookHash, author: "reflector", createdAt: f.candidate.createdAt,
      runId: source.id, digestHash: "digest", reflectorModelRef: "mock/reflector", seed: { id: seed.id, split: seed.split, sha256: seed.sha256 },
      delta: { op: "add", section: "ideate", text: "Test the weakest causal assumption before expanding any surviving candidate.", why: "Early falsification prevents wasted expansion.",
        kind: "correction", evidence: [{ kind: "digest", ref: "Summary" }] } };
    writeAtomic(candidatePath(f.home, f.id), `${JSON.stringify(candidate)}\n`);
    let checks = 0;
    const d = dependencies({ arbiter: async (input) => { checks += 1; return { conflicts: checks === 6, against: checks === 6 ? input.againstId : null, reason: "fixture" }; } });
    await expect(evolveEval(f.home, f.id, f.cfg, { budgetUsd: 600 }, d.deps)).rejects.toThrow("conflicting_bullet");
    expect(checks).toBe(6); expect(d.archived[0]?.reason).toBe("conflicting_bullet"); expect(d.calls).toHaveLength(0);
  });

  test("resumes playbook preflight from report conflict decisions without rebuying arbitration", async () => {
    const f = fixture(); const seed = loadSeeds(f.home, "dev")[0]!; const source = createRun(f.home, seed.text, { id: "source-resume" });
    writeStatus(source, { seed: { id: seed.id, split: seed.split, sha256: seed.sha256 }, shape: seed.shape });
    writeAtomic(source.digest, "# Digest\n\n## Summary\n\nA completed run.\n");
    const candidate: Candidate = { version: 1, kind: "playbook", playbookHash: f.candidate.playbookHash, author: "reflector", createdAt: f.candidate.createdAt,
      runId: source.id, digestHash: "digest", reflectorModelRef: "mock/reflector", seed: { id: seed.id, split: seed.split, sha256: seed.sha256 },
      delta: { op: "add", section: "ideate", text: "Test the weakest causal assumption before expanding any surviving candidate.", why: "Early falsification prevents wasted expansion.",
        kind: "correction", evidence: [{ kind: "digest", ref: "Summary" }] } };
    writeAtomic(candidatePath(f.home, f.id), `${JSON.stringify(candidate)}\n`);
    let checks = 0; const floor = evalPairFloor(f.cfg, "ideate");
    const d = dependencies({
      arbiter: async () => { checks += 1; return { conflicts: false, against: null, reason: "fixture" }; },
      executor: async (spec) => { d.calls.push(spec); return summary(spec, floor / 2); },
    });
    const partial = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: floor * 1.5 }, d.deps);
    expect(partial.verdict).toBe("incomplete"); expect(checks).toBe(6); expect(partial.conflictChecks).toHaveLength(6);
    await evolveEval(f.home, f.id, f.cfg, { budgetUsd: floor * 2.5 }, d.deps);
    expect(checks).toBe(6);
  });

  test("prefix honest exits, failures, and pauses become rows without cloning", async () => {
    for (const kind of ["honest_exit", "failure"] as const) {
      const f = fixture("builder"); let clones = 0; const d = dependencies({
        executor: async (spec) => { d.calls.push(spec); return summary(spec, 2, spec.through === "form" ? kind : "success"); },
        clone: () => { clones += 1; }, buildPairs: () => { throw new Error("build pairs must not run before the clone boundary"); },
      });
      const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 1300 }, d.deps);
      expect(clones).toBe(0); expect(report.runs).toHaveLength(48); expect(d.calls).toHaveLength(24);
    }
    const paused = fixture("builder"); let clones = 0; const pd = dependencies({
      executor: async (spec) => { pd.calls.push(spec); const value = summary(spec, 1); value.status.state = "paused"; return value; },
      clone: () => { clones += 1; },
    });
    const report = await evolveEval(paused.home, paused.id, paused.cfg, { budgetUsd: 1300 }, pd.deps);
    expect(report).toMatchObject({ verdict: "incomplete", stoppedReason: "deadline" }); expect(clones).toBe(0); expect(pd.calls).toHaveLength(1); expect(report.runs).toHaveLength(2);
  });

  test("cloned prefix cost is charged once, not once per copied record", async () => {
    const f = fixture("builder"); const d = dependencies({
      executor: async (spec) => { d.calls.push(spec); return summary(spec, spec.through === "form" ? 10 : spec.arm === "champion" ? 15 : 18); },
      buildPairs: ({ seed }) => [{ score: 0.5, seedId: seed.id }],
    });
    const report = await evolveEval(f.home, f.id, f.cfg, { budgetUsd: 1300 }, d.deps);
    expect(report.costUsd).toBe(24 * (15 + 18 - 10));
    expect(report.runs.every((row) => row.sharedPrefixUsd === 10)).toBe(true);
  });

  test("cloneEvolutionRun delegates to the hardened cross-home checkpoint clone", () => {
    const fromHome = mkdtempSync(join(tmpdir(), "kiln-evolve-clone-from-")); const toHome = mkdtempSync(join(tmpdir(), "kiln-evolve-clone-to-")); mkdirSync(join(toHome, "runs"));
    const source = createRun(fromHome, "seed", { id: "source" }); writeAtomic(source.frontier, '{"version":1,"shown":["idea"]}\n');
    new RunRecord(source.record).append({ t: "phase.end", phase: "ideate", outcome: "stopped" });
    writeStatus(source, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
    cloneEvolutionRun({ fromHome, fromId: source.id, toHome, toId: "candidate", boundary: "checkpoint" });
    expect(readStatus({ ...source, ...{ id: "candidate", dir: join(toHome, "runs", "candidate"), status: join(toHome, "runs", "candidate", "status.json") } })).toMatchObject({ id: "candidate", cursor: { step: "checkpoint" } });
  });
});
