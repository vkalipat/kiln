import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { RealGitRunner, type GitCommitOptions } from "../../src/build/git";
import {
  chooseEffortWinner, effortEntryStatus, effortKey, effortsSwept, projectedSweepBudget, readEffortFile,
  resolveEffort, runEffortSweep, supportedEffortLevels, writeEffortFile, type EffortEntry, type EffortSweepCell,
} from "../../src/evals/effort";
import { wilson } from "../../src/evals/wilson";
import { FakeGitRunner } from "../build/fake-git";

const AT = "2026-09-05T12:00:00.000Z";
function model(id = "seat", efforts = ["low", "medium", "high"] as const) {
  const value = createMockModel({ id, provider: "mock" });
  (value as typeof value & { thinking: { efforts: readonly string[] } }).thinking = { efforts: [...efforts] };
  return value;
}
function entry(winner: "low" | "medium" | "high" = "low"): EffortEntry {
  return { winner, sweptLevels: ["low", "medium", "high"], metric: "agreement", quality: 0.5, usdPerSuccess: 1, n: 96, rounds: 1, at: AT, evalId: "sweep-1" };
}
function cell(level: "low" | "medium" | "high", wins: number, usd: number, kind: "level" | "aa" = "level"): EffortSweepCell {
  const interval = wilson(wins, 96);
  return { id: `${level}-${kind}`, level, kind, wins, n: 96, quality: wins / 96, ...interval,
    usdPerSuccess: usd, costUsd: usd, admissible: interval.lower >= 0.4, qualityWin: interval.lower > 0.5 };
}

describe("effort file and resolution", () => {
  test("resolves profile, swept, role config, then global, clamping each to model support", () => {
    const cfg = defaultConfig(); const seated = { model: model(), ref: "mock/seat" };
    const file = { version: 1 as const, entries: { [effortKey("judge", seated.ref, "default")]: entry("low") } };
    expect(resolveEffort(cfg, "judge", seated, file, { name: "default", effort: { judge: "high" } })).toEqual({ level: "high", source: "profile" });
    expect(resolveEffort(cfg, "judge", seated, file, "default")).toEqual({ level: "low", source: "swept" });
    expect(resolveEffort(cfg, "builder", seated, file, "default")).toEqual({ level: "high", source: "config" });
    cfg.effortByRole = {}; cfg.effort = "xhigh";
    expect(resolveEffort(cfg, "judge", seated, { version: 1, entries: {} }, "default")).toEqual({ level: "high", source: "global" });
  });

  test("a changed model ref expires an entry and makes a scored seat unswept", () => {
    const file = { version: 1 as const, entries: { [effortKey("judge", "mock/old", "default")]: entry() } };
    expect(effortEntryStatus(file, "judge", "mock/new", "default")).toBe("expired");
    expect(effortEntryStatus(file, "judge", "mock/old", "frontier")).toBe("expired");
    expect(effortsSwept(["judge"], { judge: { model: model("new"), ref: "mock/new" } }, file, "default")).toBe(false);
    expect(effortsSwept(["scout"], {}, file, "default")).toBe(true);
  });

  test("round-trips effort.json and rejects malformed content", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-")); initHome(home);
    const file = { version: 1 as const, entries: { [effortKey("judge", "mock/seat", "default")]: entry() } };
    writeEffortFile(home, file); expect(readEffortFile(home)).toEqual(file);
    expect(JSON.parse(readFileSync(join(home, "evals", "effort.json"), "utf8"))).toEqual(file);
  });

  test("lists one row per requested level the model actually supports, cheapest first", () => {
    expect(supportedEffortLevels(model())).toEqual(["low", "medium", "high"]);
  });

  test("treats a raw catalog model with its own model field as a model, not an EffortSeat", () => {
    const cfg = defaultConfig(); const raw = { ...model(), model: "transport-name" };
    expect(resolveEffort(cfg, "judge", raw as never, { version: 1, entries: {} }, "default")).toEqual({ level: "medium", source: "config" });
  });
});

describe("effort winner policy", () => {
  test("equal-quality cheaper admissible effort wins", () => {
    expect(chooseEffortWinner([cell("low", 48, 1), cell("medium", 48, 2), cell("high", 48, 3)], "medium")).toMatchObject({ winner: "low", reason: "cheapest_admissible" });
  });

  test("a cheaper lower-quality inadmissible effort loses", () => {
    expect(chooseEffortWinner([cell("low", 35, 1), cell("medium", 48, 2), cell("high", 48, 3)], "medium")).toMatchObject({ winner: "medium", reason: "incumbent" });
  });

  test("a quality win is adopted regardless of cost", () => {
    expect(chooseEffortWinner([cell("low", 48, 1), cell("medium", 48, 2), cell("high", 58, 100)], "medium")).toMatchObject({ winner: "high", reason: "quality_win" });
  });

  test("cost and quality ties keep the incumbent", () => {
    expect(chooseEffortWinner([cell("low", 48, 2), cell("medium", 48, 2), cell("high", 48, 3)], "medium")).toMatchObject({ winner: "medium", reason: "incumbent" });
  });

  test("an A/A interval excluding parity halts the sweep", () => {
    const result = chooseEffortWinner([cell("low", 48, 1), cell("medium", 48, 2), cell("high", 48, 3), cell("medium", 70, 2, "aa")], "medium");
    expect(result).toEqual({ verdict: "judging_biased", winner: "medium", reason: "judging_biased" });
  });
});

describe("effort sweep handler", () => {
  test("runs supported cells, writes the winner, and commits through the Git seam", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-")); initHome(home);
    const cfg = defaultConfig(); const git = new FakeGitRunner(); const seated = model(); const seen: string[] = [];
    const report = await runEffortSweep(home, cfg, "judge", { budgetUsd: 6, projectedUsd: 5, evalId: "sweep-1", now: () => new Date(AT) }, {
      git, models: () => ({ model: seated as never, ref: "mock/seat" }),
      handler: async (request) => { seen.push(request.level); return { wins: 48, n: 96, usdPerSuccess: request.level === "low" ? 1 : 2, costUsd: 1 }; },
    });
    expect(seen).toEqual(["low", "medium", "high"]);
    expect(report).toMatchObject({ verdict: "ok", winner: "low", projectedUsd: 5 });
    expect(readEffortFile(home).entries[effortKey("judge", "mock/seat", "default")]?.winner).toBe("low");
    expect(git.commits[0]?.options).toMatchObject({ message: "evals(effort): judge low", trailers: { "Kiln-Evals-Write": "evals/effort.json" }, paths: ["evals/effort.json"] });
  });

  test("a failed real-Git commit retries from the durable report without rerunning cells", async () => {
    class FailOnceGit extends RealGitRunner {
      fail = true;
      override async commit(dir: string, options: GitCommitOptions): Promise<string> {
        if (this.fail) { this.fail = false; throw new Error("fixture commit failure"); }
        return super.commit(dir, options);
      }
    }
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-recovery-")); initHome(home);
    const git = new FailOnceGit(); const seated = model(); let calls = 0;
    const deps = { git, models: () => ({ model: seated as never, ref: "mock/seat" }),
      handler: async () => { calls += 1; return { wins: 48, n: 96, usdPerSuccess: 1, costUsd: 1 }; } };
    const options = { budgetUsd: 6, projectedUsd: 5, evalId: "commit-recovery", now: () => new Date(AT) };
    await expect(runEffortSweep(home, defaultConfig(), "judge", options, deps)).rejects.toThrow("fixture commit failure");
    const result = await runEffortSweep(home, defaultConfig(), "judge", options, deps);
    expect(result.verdict).toBe("ok"); expect(calls).toBe(3);
    expect((await git.trailerValues(home, "Kiln-Operation")).filter((value) => value.startsWith("eval-effort-"))).toHaveLength(1);
    expect(execFileSync("git", ["status", "--porcelain=v1", "--", "evals/effort.json"], { cwd: home, encoding: "utf8" })).toBe("");
  });

  test("refuses below the projected floor before the first cell", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-")); initHome(home);
    let calls = 0;
    await expect(runEffortSweep(home, defaultConfig(), "judge", { budgetUsd: 1, projectedUsd: 5 }, {
      git: new FakeGitRunner(), models: () => ({ model: model() as never, ref: "mock/seat" }),
      handler: async () => { calls += 1; return { wins: 48, n: 96, usdPerSuccess: 1 }; },
    })).rejects.toThrow("below one-cell sweep floor");
    expect(calls).toBe(0);
  });

  test("one-off reporting writes nothing, and fixed projections retain the priced floor", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-")); initHome(home); const git = new FakeGitRunner();
    const report = await runEffortSweep(home, defaultConfig(), "judge", { budgetUsd: 30, write: false }, {
      git, models: () => ({ model: model() as never, ref: "mock/seat" }), handler: async () => ({ wins: 48, n: 96, usdPerSuccess: 1 }),
    });
    expect(projectedSweepBudget("judge", 4)).toBeCloseTo(24.2);
    expect(report.entry).toBeUndefined(); expect(git.commits).toHaveLength(0); expect(readEffortFile(home).entries).toEqual({});
  });

  test("persists every completed cell and a crash resume reruns only the unfinished cells", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-")); initHome(home); const git = new FakeGitRunner(); const calls: string[] = []; let crash = true;
    const deps = {
      git, models: () => ({ model: model() as never, ref: "mock/seat" }), project: () => 1,
      handler: async (request: { id: string; level: "low" | "medium" | "high" }) => {
        calls.push(request.id); if (crash && request.level === "medium") throw new Error("fixture crash");
        return { wins: 48, n: 96, usdPerSuccess: 1, costUsd: 1 };
      },
    };
    const options = { budgetUsd: 4, evalId: "durable-sweep" };
    await expect(runEffortSweep(home, defaultConfig(), "judge", options, deps as never)).rejects.toThrow("fixture crash");
    const held = JSON.parse(readFileSync(join(home, "evolution", "reports", "durable-sweep", "effort.json"), "utf8"));
    expect(held.cells.map((value: { level: string }) => value.level)).toEqual(["low"]);
    crash = false;
    const report = await runEffortSweep(home, defaultConfig(), "judge", options, deps as never);
    expect(report.verdict).toBe("ok");
    expect(calls).toEqual(["judge-low", "judge-medium", "judge-medium", "judge-high"]);
  });

  test("a 5.5-cell budget stops before cell six and a larger resume buys exactly that cell", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-effort-")); initHome(home); const git = new FakeGitRunner(); let calls = 0;
    const six = model("six", ["minimal", "low", "medium", "high", "xhigh", "max"] as never);
    const deps = { git, models: () => ({ model: six as never, ref: "mock/six" }), project: () => 1,
      handler: async () => { calls += 1; return { wins: 48, n: 96, usdPerSuccess: 1, costUsd: 1 }; } };
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const first = await runEffortSweep(home, defaultConfig(), "judge", { budgetUsd: 5.5, levels: [...levels], evalId: "six-cells" }, deps);
    expect(first).toMatchObject({ verdict: "incomplete", stoppedReason: "budget", spentUsd: 5 }); expect(calls).toBe(5);
    expect(git.commits).toHaveLength(0);
    const resumed = await runEffortSweep(home, defaultConfig(), "judge", { budgetUsd: 6.5, levels: [...levels], evalId: "six-cells" }, deps);
    expect(resumed.verdict).toBe("ok"); expect(calls).toBe(6); expect(git.commits).toHaveLength(1);
  });
});
