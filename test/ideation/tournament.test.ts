import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { collapsePairs } from "../../src/ideation/bt";
import type { Criteria, JudgeDeps } from "../../src/ideation/judge";
import { appendTournamentLine, fitRound, readTournament, runTournament, seedFor, selfPreferenceRisk, type TournamentRecord } from "../../src/ideation/tournament";

const COST = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } as never;
const USAGE = { input: 500, output: 100 };
const CRITERIA: Criteria = { id: "r1-deadbeef", text: "Prefer ideas that ship in a week.", round: 1, shape: "product" };

/** A judge that always prefers whichever idea is presented first: every pair collapses to a tie. */
function positional() {
  return createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "A", reason: "first looks sharper" } }], usage: USAGE }) } as never);
}

/** A judge that always prefers the render containing the token STRONG. */
function consistent() {
  return createMockModel({
    id: "mock-judge",
    cost: COST,
    handler: (ctx: unknown) => {
      const msgs = (ctx as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
      const user = msgs.filter((m) => m.role === "user").at(-1);
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
      const aStart = text.indexOf("## Idea A");
      const bStart = text.indexOf("## Idea B");
      const aText = text.slice(aStart, bStart);
      const winner = aText.includes("STRONG") ? "A" : "B";
      return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: winner, feasibilityWinner: winner, reason: "strong wins" } }], usage: USAGE };
    },
  } as never);
}

function setup(model: unknown) {
  const home = mkdtempSync(join(tmpdir(), "kiln-tournament-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const deps: JudgeDeps = { home, run, record, cfg: defaultConfig(), models: () => ({ model: model as never, ref: "mock/mock-judge" }), apiKeyFor: async () => "k", streamFn: streamMock as never, effort: "medium" };
  const renders = { x: { text: "STRONG idea x", hash: "hx" }, y: { text: "weak idea y", hash: "hy" }, z: { text: "weak idea z", hash: "hz" } };
  const genModels = { x: "mock/gen-a", y: "mock/mock-judge", z: "mock/gen-b" };
  return { home, run, record, deps, renders, genModels };
}

describe("runTournament", () => {
  test("judges every pair in both orders and writes one line per (round, a, b, order)", async () => {
    const { deps, run, renders, genModels, record } = setup(consistent());
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"], ["x", "z"]], renders, genModels, criteria: CRITERIA });
    expect(lines.length).toBe(4);
    expect(lines.map((l) => `${l.a}|${l.b}|${l.order}`).sort()).toEqual(["x|y|ab", "x|y|ba", "x|z|ab", "x|z|ba"]);
    for (const l of lines) {
      expect(l.valueWinner).toBe("a"); // x is canonical a and always wins, in both presentation orders
      expect(l.criteriaId).toBe("r1-deadbeef");
      expect(l.aRenderHash).toBe("hx");
      expect(l.source).toBe("judge");
      expect(l.costUsd).toBeGreaterThan(0);
    }
    expect(readTournament(run).length).toBe(4);
    expect(readFileSync(run.tournament, "utf8").trim().split("\n").length).toBe(4);
    expect(record.read().filter((e) => e.t === "verdict").length).toBe(4);
  });

  test("resume skips lines already on disk and judges only the missing ones", async () => {
    const { deps, renders, genModels, record } = setup(consistent());
    await runTournament(deps, { round: 1, pairs: [["x", "y"]], renders, genModels, criteria: CRITERIA });
    const before = record.read().filter((e) => e.t === "model.call").length;
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"], ["x", "z"]], renders, genModels, criteria: CRITERIA });
    const after = record.read().filter((e) => e.t === "model.call").length;
    expect(after - before).toBe(2); // only x|z in both orders
    expect(lines.length).toBe(4);
  });

  test("human lines never masquerade as completed machine orderings", async () => {
    const model = consistent(); const { deps, renders, genModels } = setup(model);
    for (const order of ["ab", "ba"] as const) appendTournamentLine(deps.run, { round: 1, a: "x", b: "y", order, valueWinner: "a", feasibilityWinner: "tie", judgeModel: "human", aGenModel: "g", bGenModel: "g", criteriaId: "checkpoint", aRenderHash: "", bRenderHash: "", costUsd: 0, source: "human", comparisonId: "checkpoint-g1-p1" }, order === "ab" ? 1 : 2);
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"]], renders, genModels, criteria: CRITERIA });
    expect(lines.filter((line) => line.source === "judge")).toHaveLength(2);
    expect(model.calls).toHaveLength(2);
    expect(readTournament(deps.run).filter((line) => line.source === "human")).toHaveLength(2);
  });

  test("runs through a limiter without exceeding its concurrency", async () => {
    const { deps, renders, genModels } = setup(consistent());
    const limiter = new Limiter(2);
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"], ["x", "z"], ["y", "z"]], renders, genModels, criteria: CRITERIA, limiter });
    expect(lines.length).toBe(6);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  test("per-line costUsd is this pair's own call, not the whole concurrent batch's", async () => {
    // Every pair is scheduled through one shared limiter (§3, concurrency 4), so several judgePair
    // calls are in flight at once. Diffing the shared journal by sequence number let each line
    // claim every call appended after its own marker; the per-line costs then summed to roughly
    // three times what the run actually spent.
    const { deps, record, renders, genModels } = setup(consistent());
    const limiter = new Limiter(4);
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"], ["x", "z"], ["y", "z"]], renders, genModels, criteria: CRITERIA, limiter });
    expect(lines.length).toBe(6);
    const summed = lines.reduce((s, l) => s + l.costUsd, 0);
    expect(summed).toBeCloseTo(record.costUsd(), 12);
    for (const l of lines) expect(l.costUsd).toBeCloseTo(record.costUsd() / 6, 12);
  });

  test("selfPreferenceRisk names the side the judge generated", () => {
    const base = { judgeModel: "m", aGenModel: "m", bGenModel: "o" };
    expect(selfPreferenceRisk(base)).toBe("a");
    expect(selfPreferenceRisk({ ...base, aGenModel: "o", bGenModel: "m" })).toBe("b");
    expect(selfPreferenceRisk({ ...base, bGenModel: "m" })).toBe("both");
    expect(selfPreferenceRisk({ ...base, aGenModel: "o" })).toBe("none");
  });
});

describe("fitRound", () => {
  test("a position-only judge collapses every pair to a tie and the ladders stay flat", async () => {
    const { deps, renders, genModels } = setup(positional());
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"], ["x", "z"], ["y", "z"]], renders, genModels, criteria: CRITERIA });
    const fit = fitRound(lines, ["x", "y", "z"], { lambda: 0.1, samples: 50, humanWeight: 3, level: 0.5, seed: 1 });
    expect(fit.counts.value.x).toBe(2);
    expect(Math.abs(fit.value.x!.mean - fit.value.y!.mean)).toBeLessThan(0.05);
  });

  test("a consistent judge ranks the strong idea first with intervals at the configured level", async () => {
    const { deps, renders, genModels } = setup(consistent());
    const lines = await runTournament(deps, { round: 1, pairs: [["x", "y"], ["x", "z"], ["y", "z"]], renders, genModels, criteria: CRITERIA });
    const fit = fitRound(lines, ["x", "y", "z"], { lambda: 0.1, samples: 100, humanWeight: 3, level: 0.5, seed: seedFor("run-1", 1) });
    expect(fit.value.x!.mean).toBeGreaterThan(fit.value.y!.mean);
    expect(fit.value.x!.intervals?.["0.5"]).toBeDefined();
    expect(fit.counts.value.x).toBe(2);
    const again = fitRound(lines, ["x", "y", "z"], { lambda: 0.1, samples: 100, humanWeight: 3, level: 0.5, seed: seedFor("run-1", 1) });
    expect(JSON.stringify(again)).toBe(JSON.stringify(fit));
  });

  test("human lines are weighted and tie lines count as half wins", () => {
    const mk = (a: string, b: string, order: "ab" | "ba", w: "a" | "b" | "tie", source: "judge" | "human" = "judge"): TournamentRecord => ({ seq: 0, ts: "", round: 1, a, b, order, valueWinner: w, feasibilityWinner: w, judgeModel: "m", aGenModel: "g", bGenModel: "g", criteriaId: "c", aRenderHash: "", bRenderHash: "", costUsd: 0, source });
    const lines = [mk("p", "q", "ab", "b", "human"), mk("p", "q", "ba", "b", "human"), mk("p", "r", "ab", "tie"), mk("p", "r", "ba", "tie")];
    const fit = fitRound(lines, ["p", "q", "r"], { lambda: 0.1, samples: 50, humanWeight: 3, level: 0.5, seed: 3 });
    expect(fit.value.q!.mean).toBeGreaterThan(fit.value.p!.mean);
    expect(fit.counts.value.r).toBe(1);
  });

  test("a human comparison id remains distinct from a machine pair on the same round and ids", () => {
    const mk = (source: "judge" | "human", order: "ab" | "ba", winner: "a" | "b", comparisonId?: string): TournamentRecord => ({
      seq: 0, ts: "", round: 1, a: "p", b: "q", order, valueWinner: winner,
      feasibilityWinner: "tie", judgeModel: source, aGenModel: "g", bGenModel: "g",
      criteriaId: "c", aRenderHash: "", bRenderHash: "", costUsd: 0, source, comparisonId,
    });
    const collapsed = collapsePairs([
      mk("judge", "ab", "a"), mk("judge", "ba", "a"),
      mk("human", "ab", "b", "checkpoint-g1-p1"), mk("human", "ba", "b", "checkpoint-g1-p1"),
    ], { humanWeight: 3 });
    expect(collapsed.value).toEqual([
      { a: "p", b: "q", score: 1, weight: 1 },
      { a: "p", b: "q", score: 0, weight: 3 },
    ]);
  });

  test("a line tied on one axis still contributes its other axis's comparison", () => {
    // The regression: `outcomesFor` filtered ties per line across both axes, so the `ab` line's
    // tied feasibility deleted the pair's value comparison as well, and left both means at the
    // prior with `counts.value.p === 0`.
    const mk = (order: "ab" | "ba", feas: "a" | "b" | "tie"): TournamentRecord => ({ seq: 0, ts: "", round: 1, a: "p", b: "q", order, valueWinner: "a", feasibilityWinner: feas, judgeModel: "m", aGenModel: "g", bGenModel: "g", criteriaId: "c", aRenderHash: "", bRenderHash: "", costUsd: 0, source: "judge" });
    const fit = fitRound([mk("ab", "tie"), mk("ba", "b")], ["p", "q"], { lambda: 0.1, samples: 50, humanWeight: 3, level: 0.5, seed: 7 });
    expect(fit.counts.value.p).toBe(1);
    expect(fit.counts.feasibility.p).toBe(1);
    expect(fit.incomplete).toBe(0);
    expect(fit.value.p!.mean).toBeGreaterThan(fit.value.q!.mean);
    // Feasibility disagreed across the orderings, so that axis alone stays flat.
    expect(Math.abs(fit.feasibility.p!.mean - fit.feasibility.q!.mean)).toBeLessThan(0.05);
  });

  test("a human best-worst line is weighted 3x on the axis it decided", () => {
    // §0: best-worst answers land with source "human" and refit at 3x. They are decisive on one
    // axis and silent on the other, which is exactly the shape the old per-line filter discarded.
    const mk = (order: "ab" | "ba", source: "judge" | "human"): TournamentRecord => ({ seq: 0, ts: "", round: 1, a: "p", b: "q", order, valueWinner: "b", feasibilityWinner: "tie", judgeModel: "m", aGenModel: "g", bGenModel: "g", criteriaId: "c", aRenderHash: "", bRenderHash: "", costUsd: 0, source });
    const opts = { lambda: 0.1, samples: 50, humanWeight: 3, level: 0.5, seed: 11 };
    const human = fitRound([mk("ab", "human"), mk("ba", "human")], ["p", "q"], opts);
    const judge = fitRound([mk("ab", "judge"), mk("ba", "judge")], ["p", "q"], opts);
    expect(human.counts.value.q).toBe(1);
    expect(human.value.q!.mean).toBeGreaterThan(human.value.p!.mean);
    // Same verdict, three times the evidence: the human line moves the ladder further.
    expect(human.value.q!.mean).toBeGreaterThan(judge.value.q!.mean);
  });

  test("seedFor is stable and differs across rounds", () => {
    expect(seedFor("r", 1)).toBe(seedFor("r", 1));
    expect(seedFor("r", 1)).not.toBe(seedFor("r", 2));
  });
});
