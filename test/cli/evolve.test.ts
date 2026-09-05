import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog";
import { evolveCommand } from "../../src/cli/commands/evolve";
import { initHome } from "../../src/core/home";
import { candidatePath } from "../../src/core/paths";
import type { CliIo } from "../../src/cli/main";
import type { EvolveEvalDeps, EvolutionEvalReport } from "../../src/evolution/evolve";
import { NoModelError } from "../../src/providers/models";
import { FakeGitRunner } from "../build/fake-git";

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "kiln-evolve-cli-"));
  initHome(home);
  return home;
}

function capture(answer?: string) {
  const out: string[] = []; const err: string[] = [];
  const io: CliIo = { write: (text) => out.push(text), error: (text) => err.push(text), ...(answer === undefined ? {} : { ask: async () => answer }) };
  return { out, err, io };
}

async function promptCandidate(home: string, name = "brain"): Promise<string> {
  const file = join(home, `${name}-replacement.md`);
  writeFileSync(file, `# ${name}\n\nUse the replacement instruction.\n`);
  const output = capture();
  const code = await evolveCommand(["propose"], { home, prompt: name, file, json: true }, output.io, { now: () => new Date("2026-09-05T12:00:00.000Z") });
  expect(code).toBe(0);
  return JSON.parse(output.out.join("")).id as string;
}

const model = { id: "fixture", provider: "fixture", thinking: { efforts: ["low", "medium", "high", "xhigh"] } } as unknown as Model;

function completeEvalDeps(): EvolveEvalDeps {
  return {
    git: new FakeGitRunner(),
    executor: async () => { throw new Error("fixture executor must not run through a stubbed command"); },
    judge: async () => [],
    arbiter: async () => ({ conflicts: false, against: null, reason: "independent" }),
    archive: () => {},
    models: (role) => ({ model, ref: `fixture/${role}` }),
  };
}

function report(id: string, verdict: EvolutionEvalReport["verdict"]): EvolutionEvalReport {
  return {
    version: 1, evalId: id, candidateId: id,
    candidate: {} as never, playbookHash: "hash", class: "ideate",
    projection: { pairFloorUsd: 23.24, expectedUsd: 494.78, ceilingUsd: 557.76, seedPairs: 24 },
    frozen: {} as never, effortSwept: true, judgeCalibration: { status: "calibrated" },
    startedAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z",
    budgetUsd: 600, costUsd: 12, runs: [],
    passes: {
      dev: { seeds: 12, uncensoredSeeds: 12, pairs: 48, wins: 31, ties: 0, rate: 31 / 48, wilson: { lower: 0.5, upper: 0.7 }, requiredWins: 31, evidence: true, seedWins: 8 },
      heldout: { seeds: 12, uncensoredSeeds: 12, pairs: 48, wins: 31, ties: 0, rate: 31 / 48, wilson: { lower: 0.5, upper: 0.7 }, requiredWins: 31, evidence: true, seedWins: 8 },
    }, verdict,
  };
}

describe("kiln evolve command", () => {
  test("rejects unknown shapes and required flags as usage before dispatch", async () => {
    const home = fixture(); let calls = 0;
    for (const [cmd, flags] of [
      [[], { home }], [["wat"], { home }], [["list", "extra"], { home }],
      [["eval", "candidate"], { home, json: true }], [["rollback"], { home }],
      [["archive", "candidate"], { home, reason: "lost_dev", detail: "wrong authority" }],
    ] as Array<[string[], Record<string, string | boolean>]>) {
      const output = capture();
      expect(await evolveCommand(cmd, flags, output.io, { runEval: async () => { calls++; return {} as never; } })).toBe(2);
      expect(output.err.join("")).toBeTruthy();
    }
    expect(calls).toBe(0);

    const apply = capture();
    expect(await evolveCommand(["apply"], { home, op: "add" }, apply.io)).toBe(2);
    expect(apply.err.join("")).toContain("--op edit|retire");
  });

  test("keeps manifest verification ahead of promotion id validation", async () => {
    const home = fixture(); writeFileSync(join(home, "evals", "manifest.json"), "{}\n");
    const output = capture();
    expect(await evolveCommand(["promote", "../bad"], { home }, output.io)).toBe(1);
    expect(output.err.join("")).toContain("eval manifest mismatch");
    expect(output.err.join("")).not.toContain("invalid_candidate_id");
  });

  test("routes an invalid eval candidate through the core terminal archive", async () => {
    const home = fixture(); const id = "invalid-candidate";
    writeFileSync(candidatePath(home, id), '{"kind":"playbook"}\n');
    const output = capture();
    expect(await evolveCommand(["eval", id], { home, budget: "600", json: true }, output.io)).toBe(1);
    expect(existsSync(candidatePath(home, id))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "evolution", "archive", id, "reason.json"), "utf8")).reason).toBe("invalid");
  });

  test("proposes prompt and playbook candidates under the mutation lock", async () => {
    const home = fixture(); const promptId = await promptCandidate(home, "builder");
    expect(JSON.parse(readFileSync(candidatePath(home, promptId), "utf8"))).toMatchObject({
      kind: "prompt", author: "operator", prompt: { name: "builder", text: expect.stringContaining("replacement") },
    });

    const proposed = capture();
    expect(await evolveCommand(["propose"], {
      home, op: "add", section: "build", text: "Verify each proposed change before committing.",
      why: "Local checks expose regressions early.", kind: "correction", evidence: "file:config.json", json: true,
    }, proposed.io, { now: () => new Date("2026-09-05T12:01:00.000Z") })).toBe(0);
    const playbookId = JSON.parse(proposed.out.join("")).id as string;
    expect(JSON.parse(readFileSync(candidatePath(home, playbookId), "utf8"))).toMatchObject({
      kind: "playbook", author: "operator", delta: { op: "add", section: "build", evidence: [{ kind: "file", ref: "config.json" }] },
    });
    expect(existsSync(join(home, "evolution", "evolve.lock"))).toBe(false);

    const refused = capture();
    const file = join(home, "judge.md"); writeFileSync(file, "Replacement.\n");
    expect(await evolveCommand(["propose"], { home, prompt: "judge", file }, refused.io)).toBe(1);
    expect(refused.err.join("")).toContain("prompt_refused");
  });

  test("lists derived candidate state as JSON and a complete operator table", async () => {
    const home = fixture(); const id = await promptCandidate(home); const json = capture();
    expect(await evolveCommand(["list"], { home, json: true }, json.io, { git: new FakeGitRunner() })).toBe(0);
    expect(JSON.parse(json.out.join(""))).toMatchObject({ rows: [{ id, kind: "prompt", status: "pending" }], judgeCalibrationStatus: null });

    const text = capture();
    expect(await evolveCommand(["list"], { home }, text.io, { git: new FakeGitRunner() })).toBe(0);
    expect(text.out.join("")).toContain("held-out [LB,UB]");
    expect(text.out.join("")).toContain("judgeCalibration.status: absent");
  });

  test("prints projection before consent and a decline starts no evaluation", async () => {
    const home = fixture(); const id = await promptCandidate(home); let calls = 0; const output = capture("no");
    expect(await evolveCommand(["eval", id], { home, budget: "600" }, output.io, {
      runEval: async () => { calls++; return report(id, "win"); }, eval: completeEvalDeps(),
    })).toBe(0);
    expect(calls).toBe(0);
    expect(output.out.join("")).toContain("evolve eval projection");
    expect(output.out.join("")).toContain("evolution evaluation cancelled");

    const accepted = capture();
    expect(await evolveCommand(["eval", id], { home, budget: "600", yes: true }, accepted.io, {
      runEval: async () => report(id, "win"), eval: completeEvalDeps(),
    })).toBe(0);
    expect(accepted.out.join("")).toContain("evolve eval projection");
  });

  test("constructs the production executor, judge, conflict, and archive adapters without calling them", async () => {
    const home = fixture(); const id = await promptCandidate(home); const output = capture(); let received: EvolveEvalDeps | undefined;
    expect(await evolveCommand(["eval", id], { home, budget: "600", json: true }, output.io, {
      git: new FakeGitRunner(), cli: { models: { judge: model }, apiKeyFor: async () => undefined },
      runEval: async (_home, _id, _cfg, _options, deps) => { received = deps; return report(id, "win"); },
    })).toBe(0);
    expect(received).toMatchObject({ git: expect.anything(), executor: expect.any(Function), judge: expect.any(Function), arbiter: expect.any(Function), archive: expect.any(Function), models: expect.any(Function) });
  });

  test("passes injected eval dependencies, emits the report object, and maps verdicts", async () => {
    const home = fixture(); const id = await promptCandidate(home); const injected = completeEvalDeps();
    for (const [verdict, code] of [["win", 0], ["lose", 1], ["not_evidence", 1], ["censored", 1], ["incomplete", 1]] as const) {
      const output = capture(); let called = false;
      const expected = report(id, verdict);
      const actual = await evolveCommand(["eval", id], { home, budget: "$600", rounds: "1", "wall-seconds": "60", json: true }, output.io, {
        eval: injected,
        runEval: async (receivedHome, receivedId, _cfg, options, receivedDeps) => {
          called = true; expect(receivedHome).toBe(home); expect(receivedId).toBe(id);
          expect(options).toMatchObject({ budgetUsd: 600, rounds: 1, wallSeconds: 60 });
          expect(receivedDeps.executor).toBe(injected.executor); expect(receivedDeps.judge).toBe(injected.judge);
          return expected;
        },
      });
      expect(actual).toBe(code); expect(called).toBe(true); expect(JSON.parse(output.out.join(""))).toEqual(expected);
    }
  });

  test("refuses a sub-floor budget before dependencies and maps NoModel to exit 3", async () => {
    const home = fixture(); const id = await promptCandidate(home); let calls = 0;
    const budget = capture();
    expect(await evolveCommand(["eval", id], { home, budget: "1", json: true }, budget.io, {
      runEval: async () => { calls++; return report(id, "win"); }, eval: completeEvalDeps(),
    })).toBe(1);
    expect(calls).toBe(0); expect(budget.err.join("")).toContain("below one pair ceiling");

    const noModel = capture();
    expect(await evolveCommand(["eval", id], { home, budget: "600", json: true }, noModel.io, {
      eval: completeEvalDeps(), runEval: async () => { throw new NoModelError("no judge model"); },
    })).toBe(3);
    expect(noModel.err.join("")).toContain("configure authenticated evolution seats");
  });

  test("dispatches promotion and rollback requests and archives pending candidates", async () => {
    const home = fixture(); const id = await promptCandidate(home); const git = new FakeGitRunner();
    const promoted = capture(); let promoteRequest: unknown;
    expect(await evolveCommand(["promote", id], { home, confirm: true, abandon: "old-eval", json: true }, promoted.io, {
      git, runPromote: async (_home, request) => {
        promoteRequest = request;
        return { id, operationId: "promote-1", commit: "abc", championBefore: "a", championAfter: "b", confirmed: true, costFlag: { flagged: true, ratio: 1.6 }, archived: [], idempotent: false };
      },
    })).toBe(0);
    expect(promoteRequest).toMatchObject({ id, confirm: true, abandonEvalId: "old-eval" });
    expect(JSON.parse(promoted.out.join(""))).toMatchObject({ operationId: "promote-1", confirmed: true });

    const rolled = capture(); let rollbackRequest: unknown;
    expect(await evolveCommand(["rollback"], { home, confirm: true, json: true }, rolled.io, {
      git, runRollback: async (_home, request) => {
        rollbackRequest = request; return { reverted: "a".repeat(40), operationId: "rollback-1", commit: "b".repeat(40) };
      },
    })).toBe(0);
    expect(rollbackRequest).toEqual({ confirm: true, forceLock: false });

    const archived = capture();
    expect(await evolveCommand(["archive", id], { home, reason: "operator", detail: "withdrawn by operator", json: true }, archived.io, { git })).toBe(0);
    expect(JSON.parse(archived.out.join(""))).toMatchObject({ id, reason: { reason: "operator", detail: "withdrawn by operator" } });
    expect(existsSync(candidatePath(home, id))).toBe(false);
    expect(existsSync(join(home, "evolution", "archive", id, "candidate.json"))).toBe(true);
    expect(git.commits.at(-1)?.options).toMatchObject({ message: `evolve(archive): ${id} operator`, paths: [`evolution/archive/${id}`] });
  });
});
