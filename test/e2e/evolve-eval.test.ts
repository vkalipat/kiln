import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { evolveCommand } from "../../src/cli/commands/evolve";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { appendLine, candidatePath, writeAtomic } from "../../src/core/paths";
import type { RunStatus } from "../../src/core/run";
import type { RunExecutorSpec, RunSummary } from "../../src/evals/executor";
import type { LoadedSeed } from "../../src/evals/seeds";
import type { Candidate } from "../../src/evolution/candidate";
import { evalPairFloor, type EvolveEvalDeps } from "../../src/evolution/evolve";
import { playbookHash } from "../../src/evolution/playbook";
import { FakeGitRunner } from "../build/fake-git";

const FIXED_TIME = "2026-09-05T12:00:00.000Z";

interface Fixture {
  home: string;
  id: string;
}

interface FixtureHarness {
  deps: EvolveEvalDeps;
  calls: RunExecutorSpec[];
  archived: Array<{ reason: string; detail: string }>;
  judgeInvocations: string[];
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "kiln-evolve-e2e-"));
  initHome(home);
  const id = "fixture-candidate";
  const playbook = readFileSync(join(home, "playbook", "playbook.md"), "utf8");
  const candidate: Candidate = {
    version: 1,
    kind: "prompt",
    playbookHash: playbookHash(playbook),
    author: "operator",
    createdAt: FIXED_TIME,
    prompt: {
      name: "brain",
      text: "# Brain fixture\n\nPrefer a concrete mechanism and state the assumption it tests.\n",
    },
  };
  writeAtomic(candidatePath(home, id), `${JSON.stringify(candidate, null, 2)}\n`);
  return { home, id };
}

function summary(spec: RunExecutorSpec, costUsd: number): RunSummary {
  const outcome = { kind: "success" } as const;
  const status: RunStatus = {
    id: spec.runId,
    phase: spec.through === "ideate" ? "ideate" : "build",
    state: "done",
    outcome,
    usdSpent: costUsd,
    turns: {},
    seed: spec.seedIdentity,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
  return {
    runId: spec.runId,
    seedId: spec.seedIdentity.id,
    split: spec.seedIdentity.split,
    shape: "unknown",
    arm: spec.arm,
    status,
    outcome,
    costUsd,
    metrics: {},
  };
}

/** A durable provider-free judge: reruns read prior fixture rows instead of appending duplicates. */
function fixtureHarness(score: number, runCostUsd = 0): FixtureHarness {
  const calls: RunExecutorSpec[] = [];
  const archived: Array<{ reason: string; detail: string }> = [];
  const judgeInvocations: string[] = [];
  const git = new FakeGitRunner();
  const judge = async ({ evalDir, seed }: { evalDir: string; seed: LoadedSeed }) => {
    judgeInvocations.push(seed.id);
    const judgedPath = join(evalDir, "judged.jsonl");
    const prior = (() => {
      try {
        return readFileSync(judgedPath, "utf8").split("\n").flatMap((line) => line.trim() ? [JSON.parse(line) as { seedId: string; score: number }] : []);
      } catch {
        return [];
      }
    })();
    if (!prior.some((line) => line.seedId === seed.id)) {
      for (let pair = 0; pair < 4; pair += 1) {
        appendLine(judgedPath, JSON.stringify({ seedId: seed.id, pair, score, source: "fixture" }));
      }
    }
    return readFileSync(judgedPath, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      const held = JSON.parse(line) as { seedId: string; score: number };
      return held.seedId === seed.id ? [{ seedId: held.seedId, score: held.score }] : [];
    });
  };
  return {
    calls,
    archived,
    judgeInvocations,
    deps: {
      git,
      executor: async (spec) => {
        calls.push(spec);
        return summary(spec, runCostUsd);
      },
      judge,
      arbiter: async () => ({ conflicts: false, against: null, reason: "fixture" }),
      archive: async (reason, detail) => { archived.push({ reason, detail }); },
      models: (role) => ({
        model: { id: role, provider: "fixture", thinking: { efforts: ["low", "medium", "high", "xhigh"] } } as never,
        ref: `fixture/${role}`,
      }),
    },
  };
}

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { write: (text: string) => out.push(text), error: (text: string) => err.push(text) },
  };
}

async function run(f: Fixture, harness: FixtureHarness, budget: number) {
  const captured = output();
  const code = await evolveCommand(["eval", f.id], { home: f.home, budget: String(budget), json: true }, captured.io, { eval: harness.deps });
  return { code, ...captured };
}

function judgedRows(home: string, id: string): Array<{ seedId: string; score: number }> {
  return readFileSync(join(home, "evolution", "reports", id, "judged.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { seedId: string; score: number });
}

function protectedSnapshot(home: string): Array<{ path: string; bytes: string }> {
  const roots = ["config.json", "evals", "playbook", "prompts"];
  const rows: Array<{ path: string; bytes: string }> = [];
  const visit = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    rows.push({ path: relative(home, path).split(sep).join("/"), bytes: readFileSync(path).toString("base64") });
  };
  for (const root of roots) visit(join(home, root));
  return rows;
}

describe("kiln evolve eval fixture end-to-end", () => {
  test("a missing budget is a usage error before any fixture dependency runs", async () => {
    const f = fixture();
    const harness = fixtureHarness(0.5);
    const captured = output();

    const code = await evolveCommand(["eval", f.id], { home: f.home, json: true }, captured.io, { eval: harness.deps });

    expect(code).toBe(2);
    expect(harness.calls).toEqual([]);
    expect(harness.judgeInvocations).toEqual([]);
    expect(captured.err.join("")).toContain("--budget");
  });

  test("manifest drift refuses before any fixture executor or judge call", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "evals", "README.md"), "drifted evaluator material\n");
    const harness = fixtureHarness(0.5);

    const result = await run(f, harness, 600);

    expect(result.code).toBe(1);
    expect(harness.calls).toEqual([]);
    expect(harness.judgeInvocations).toEqual([]);
    expect(`${result.out.join("")}\n${result.err.join("")}`).toContain("README.md");
    expect(harness.archived).toEqual([expect.objectContaining({ reason: "invalid" })]);
    expect(readFileSync(candidatePath(f.home, f.id), "utf8")).toContain('"kind": "prompt"');
  });

  test("a clear dev loss returns JSON and never executes a held-out seed", async () => {
    const f = fixture();
    const before = protectedSnapshot(f.home);
    const harness = fixtureHarness(0);

    const result = await run(f, harness, 600);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join(""));
    expect(report).toMatchObject({
      candidateId: f.id,
      verdict: "lose",
      stoppedEarly: "lost_dev",
      passes: { dev: { seeds: 12, pairs: 48, wins: 0 }, heldout: { seeds: 0, pairs: 0 } },
    });
    expect(harness.calls).toHaveLength(24);
    expect(new Set(harness.calls.map((call) => call.seedIdentity.split))).toEqual(new Set(["dev"]));
    expect(harness.archived[0]).toMatchObject({ reason: "lost_dev" });
    expect(judgedRows(f.home, f.id)).toHaveLength(48);
    expect(JSON.parse(readFileSync(join(f.home, "evolution", "reports", f.id, "eval.json"), "utf8"))).toEqual(report);
    expect(protectedSnapshot(f.home)).toEqual(before);
  });

  test("a marginal dev result executes the held-out pass and preserves the real home", async () => {
    const f = fixture();
    const before = protectedSnapshot(f.home);
    const harness = fixtureHarness(0.5);

    const result = await run(f, harness, 600);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join(""));
    expect(report).toMatchObject({
      candidateId: f.id,
      verdict: "lose",
      passes: { dev: { seeds: 12, pairs: 48 }, heldout: { seeds: 12, pairs: 48 } },
    });
    expect(harness.calls).toHaveLength(48);
    expect(new Set(harness.calls.map((call) => call.seedIdentity.split))).toEqual(new Set(["dev", "heldout"]));
    expect(judgedRows(f.home, f.id)).toHaveLength(96);
    expect(protectedSnapshot(f.home)).toEqual(before);
  });

  test("an incomplete budget resumes without repeating completed runs or judged rows", async () => {
    const f = fixture();
    const floor = evalPairFloor(defaultConfig(), "ideate");
    const harness = fixtureHarness(0.5, floor / 2);

    const first = await run(f, harness, floor * 1.5);

    expect(first.code).toBe(1);
    expect(JSON.parse(first.out.join(""))).toMatchObject({ verdict: "incomplete", stoppedReason: "budget", passes: { dev: { seeds: 1 } } });
    expect(harness.calls).toHaveLength(2);
    expect(judgedRows(f.home, f.id)).toHaveLength(4);

    const resumed = await run(f, harness, 600);

    expect(resumed.code).toBe(1);
    expect(JSON.parse(resumed.out.join(""))).toMatchObject({ verdict: "lose", passes: { dev: { seeds: 12 }, heldout: { seeds: 12 } } });
    expect(harness.calls).toHaveLength(48);
    expect(new Set(harness.calls.map((call) => call.runId)).size).toBe(48);
    expect(judgedRows(f.home, f.id)).toHaveLength(96);
  });
});
