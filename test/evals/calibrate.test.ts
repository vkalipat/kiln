import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { writeAtomic } from "../../src/core/paths";
import { createRun, writeStatus } from "../../src/core/run";
import { RealGitRunner, type GitCommitOptions } from "../../src/build/git";
import { calibrate, discoverCalibrationGroups, impliedPreferences, judgeCalibration, parseHumanBws } from "../../src/evals/calibrate";
import type { FrontierFile } from "../../src/phases/ideate";
import { FakeGitRunner } from "../build/fake-git";

type Context = { messages?: Array<{ role?: string; content?: unknown }> };
const USAGE = { input: 100, output: 20 };

function userText(ctx: Context): string {
  const message = [...(ctx.messages ?? [])].reverse().find((item) => item.role === "user");
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "").join("\n") : "";
}

function setup(mode: "loop" | "bare" = "loop", itemCount = 4) {
  const home = mkdtempSync(join(tmpdir(), "kiln-calibrate-")); initHome(home);
  const run = createRun(home, "A sufficiently detailed fixture seed.", { id: "source-run" });
  writeStatus(run, { shape: "product" });
  writeFileSync(join(run.criteriaDir, "r1-deadbeef.md"), "Prefer the idea with the lower VALUE rank.\n");
  const ids = Array.from({ length: itemCount }, (_, index) => String.fromCharCode(97 + index));
  ids.forEach((id, rank) => writeFileSync(join(run.renderedDir, `${id}-r1.md`), `VALUE-${rank + 1} ${id}\n`));
  const frontier: FrontierFile = {
    version: 1, mode, round: 1, rawFront: ids, shown: ids, eligible: ids,
    ideas: ids.map((id) => ({ id, backfill: false, cell: id })), ladders: { value: ids, feasibility: ids },
    searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true,
  };
  writeAtomic(run.frontier, `${JSON.stringify(frontier)}\n`);
  const judge = createMockModel({
    id: "fixture-judge", provider: "judge-provider",
    handler: (ctx: Context) => {
      const text = userText(ctx); const aRank = Number(/## Idea A[\s\S]*?VALUE-(\d+)/.exec(text)?.[1]);
      const bRank = Number(/## Idea B[\s\S]*?VALUE-(\d+)/.exec(text)?.[1]);
      const winner = aRank < bRank ? "A" : "B";
      return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: winner, feasibilityWinner: winner, reason: "lower rank wins" } }], usage: USAGE };
    },
  } as never);
  const cfg = defaultConfig(); const git = new FakeGitRunner();
  const models = (_role: Role) => ({ model: judge as never, ref: "judge-provider/fixture-judge" });
  const deps = {
    cfg, git, models,
    availableProviders: new Set(["judge-provider"]), apiKeyFor: async () => "key", streamFn: streamMock as never,
  };
  return { home, run, judge, cfg, git, deps };
}

describe("calibration groups", () => {
  test("a four-item best-worst label implies exactly five preferences", () => {
    const pairs = impliedPreferences(["a", "b", "c", "d"], "a", "d");
    expect(pairs).toEqual([
      { winner: "a", loser: "b" }, { winner: "a", loser: "c" }, { winner: "a", loser: "d" },
      { winner: "b", loser: "d" }, { winner: "c", loser: "d" },
    ]);
  });

  test("discovers each group wholly within one source run and round, retaining frontier mode", () => {
    const f = setup("bare"); const groups = discoverCalibrationGroups(f.home);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0]).toMatchObject({ runId: "source-run", round: 1, frontierMode: "bare", shape: "product" });
    expect(new Set(groups[0]!.items.map((item) => item.id)).size).toBe(4);
  });

  test("parses the terminal form and rejects ids outside the group", () => {
    expect(parseHumanBws("best a worst d", ["a", "b", "c", "d"])).toEqual({ best: "a", worst: "d" });
    expect(parseHumanBws("best x worst d", ["a", "b", "c", "d"])).toBeUndefined();
  });
});

describe("calibrate", () => {
  test("writes a provisional human replay outside run truth, commits it, and resumes without duplicate judging", async () => {
    const f = setup(); let asks = 0;
    const io = { ask: async () => { asks += 1; return "best a worst d"; } };
    const first = await calibrate(f.home, { labels: "human", groups: 1, budgetUsd: 100, now: () => new Date("2026-09-05T12:00:00Z") }, { ...f.deps, io });
    expect(first).toMatchObject({ groups: 1, impliedPairs: 5, refusedGroups: 0, agreement: 1, orderAgreement: 1, provisional: true, calibrated: false });
    expect(readFileSync(first.replayPath, "utf8").trim().split("\n")).toHaveLength(10);
    expect(existsSync(f.run.tournament)).toBe(false);
    expect(f.git.commits[0]?.options).toMatchObject({ message: "evals(calibrate): human 1 groups", trailers: { "Kiln-Evals-Write": "evals/calibration.json" }, paths: ["evals/calibration.json", expect.stringMatching(/^evals\/calibration\/.+\.jsonl$/)] });
    expect(asks).toBe(1); expect(f.judge.calls).toHaveLength(10);

    await calibrate(f.home, { labels: "human", groups: 1, budgetUsd: 100, now: () => new Date("2026-09-05T12:00:01Z") }, { ...f.deps, io });
    expect(asks).toBe(1); expect(f.judge.calls).toHaveLength(10);
    expect(readFileSync(first.replayPath, "utf8").trim().split("\n")).toHaveLength(10);
  });

  test("a lost real-Git acknowledgement resumes the commit without repeating labels or judging", async () => {
    class LostAckGit extends RealGitRunner {
      lose = true;
      override async commit(dir: string, options: GitCommitOptions): Promise<string> {
        const sha = await super.commit(dir, options);
        if (this.lose) { this.lose = false; throw new Error("lost commit acknowledgement"); }
        return sha;
      }
    }
    const f = setup(); const git = new LostAckGit(); let asks = 0;
    const options = { labels: "human" as const, groups: 1, budgetUsd: 100 };
    const deps = { ...f.deps, git, io: { ask: async () => { asks += 1; return "best a worst d"; } } };
    await expect(calibrate(f.home, options, deps)).rejects.toThrow("lost commit acknowledgement");
    const result = await calibrate(f.home, options, deps);
    expect(result.groups).toBe(1); expect(asks).toBe(1); expect(f.judge.calls).toHaveLength(10);
    expect((await git.trailerValues(f.home, "Kiln-Operation")).filter((value) => value.startsWith("eval-calibration-"))).toHaveLength(1);
    expect(execFileSync("git", ["status", "--porcelain=v1", "--", "evals/calibration.json",
      `evals/calibration/${result.id}.jsonl`], { cwd: f.home, encoding: "utf8" })).toBe("");
  });

  test("twelve requested groups remain provisional", async () => {
    const f = setup("loop", 12);
    const io = { ask: async (prompt: string) => {
      const ids = [...prompt.matchAll(/^## ([a-z])$/gm)].map((match) => match[1]!);
      return `best ${ids[0]} worst ${ids[3]}`;
    } };
    const result = await calibrate(f.home, { labels: "human", groups: 12, budgetUsd: 100 }, { ...f.deps, io });
    expect(result.groups).toBe(12);
    expect(result.provisional).toBe(true); expect(result.calibrated).toBe(false);
  });

  test("prompt drift makes an otherwise current calibration stale", async () => {
    const f = setup();
    await calibrate(f.home, { labels: "human", groups: 1, budgetUsd: 100 }, { ...f.deps, io: { ask: async () => "best a worst d" } });
    expect(judgeCalibration(f.home, f.cfg, f.deps.models("judge")).status).toBe("provisional");
    appendFileSync(join(f.home, "prompts", "judge.md"), "one byte\n");
    expect(judgeCalibration(f.home, f.cfg, f.deps.models("judge")).status).toBe("stale");
  });

  test("reports insufficient material before calling either model", async () => {
    const f = setup();
    await expect(calibrate(f.home, { labels: "agent", groups: 20, budgetUsd: 100 }, { ...f.deps, seat: { model: f.judge as never, ref: "same/other", crossProvider: false } })).rejects.toThrow("insufficient material: run M1 first");
    expect(f.judge.calls).toHaveLength(0);
  });

  test("refuses no budget before any prompt and requires one complete-group floor", async () => {
    const f = setup(); let asks = 0;
    await expect(calibrate(f.home, { labels: "human", groups: 1 }, { ...f.deps, io: { ask: async () => { asks += 1; return "best a worst d"; } } })).rejects.toThrow("must cover one calibration group");
    expect(asks).toBe(0); expect(f.judge.calls).toHaveLength(0);
  });

  test("a partial replay is excluded, then resume buys only its missing orderings", async () => {
    const f = setup(); let calls = 0; let fail = true;
    const fixturePair = async () => {
      calls += 1;
      if (fail && calls === 4) throw new Error("crash after three durable orderings");
      return { valueWinner: "a" as const, feasibilityWinner: "a" as const, reason: "fixture", judgeModel: "fixture", costUsd: 0, retried: false };
    };
    const options = { labels: "human" as const, groups: 1, budgetUsd: 100 };
    const deps = { ...f.deps, io: { ask: async () => "best a worst d" }, judgePair: fixturePair };
    await expect(calibrate(f.home, options, deps)).rejects.toThrow("crash after three");
    expect(f.git.commits).toHaveLength(0);
    fail = false;
    const result = await calibrate(f.home, options, deps);
    expect(result).toMatchObject({ groups: 1, impliedPairs: 5 });
    expect(calls).toBe(11);
    expect(readFileSync(result.replayPath, "utf8").trim().split("\n")).toHaveLength(10);
  });

  test("twenty complete low-agreement human groups remove the judge gate in a second commit", async () => {
    const f = setup("loop", 20); f.cfg.autonomous = true;
    const io = { ask: async (prompt: string) => {
      const ids = [...prompt.matchAll(/^## ([a-z])$/gm)].map((match) => match[1]!);
      return `best ${ids[0]} worst ${ids[3]}`;
    } };
    const ties = async () => ({ valueWinner: "tie" as const, feasibilityWinner: "tie" as const, reason: "fixture tie", judgeModel: "fixture", costUsd: 0, retried: false });
    const result = await calibrate(f.home, { labels: "human", groups: 20, budgetUsd: 100 }, { ...f.deps, io, judgePair: ties });
    expect(result).toMatchObject({ groups: 20, agreement: 0.5, calibrated: false });
    expect(f.cfg.evals.judgeGate).toBe("removed"); expect(f.cfg.autonomous).toBe(false);
    expect(f.git.commits.map((commit) => commit.options.message)).toEqual(["evals(calibrate): human 20 groups", "evals(gate): judge removed"]);
    expect(f.git.commits[1]?.options.paths).toEqual(["config.json"]);
  });
});
