import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHASES, ROLES, type Effort, type Role } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { createRun, writeStatus } from "../../src/core/run";
import { computeMetrics, haloCorrelation, STOP_KINDS, writeMetrics, type IdeationMetrics, type Metrics } from "../../src/ideation/metrics";
import type { TournamentRecord } from "../../src/ideation/tournament";

function line(seq: number, valueWinner: "a" | "b", feasibilityWinner: "a" | "b", pair = seq): TournamentRecord {
  return {
    seq, ts: `2026-09-04T00:00:0${seq}.000Z`, round: 1, a: `a${pair}`, b: `b${pair}`, order: "ab",
    valueWinner, feasibilityWinner, judgeModel: "judge", aGenModel: "ga", bGenModel: "gb",
    criteriaId: "c", aRenderHash: "a", bRenderHash: "b", costUsd: 0.01, source: "judge",
  };
}

function byRole<T>(value: T): Record<Role, T> {
  return Object.fromEntries(ROLES.map((role) => [role, value])) as Record<Role, T>;
}

describe("ideation metrics", () => {
  test("halo correlation is computed from the two verdicts returned by each call", () => {
    expect(haloCorrelation([line(1, "a", "a"), line(2, "b", "a"), line(3, "a", "b"), line(4, "b", "b")])).toBeCloseTo(0);
    expect(haloCorrelation([line(1, "a", "a")])).toBeNull();
  });

  test("folds every required field and suppresses collision rate below the search-health floor", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-metrics-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    record.append({ t: "phase.start", phase: "ideate" });
    record.append({ t: "turn", role: "judge", phase: "ideate", n: 1 });
    record.append({ t: "model.call", role: "judge", provider: "p", model: "m", effortSent: "medium", addendaHash: "family-a", inputHash: "x", usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 }, costUsd: 0.25, stopReason: "error", stopDetails: { type: "refusal", category: "safety" }, reasoningTokens: 3, excerpt: "ok" });
    record.append({ t: "failure", class: "refusal", message: "refused", category: "safety" });
    record.append({ t: "idea.insert", id: "i1", cell: "a", similarity: 0.1, parents: [] });
    record.append({ t: "idea.insert", id: "i2", cell: "b", similarity: 0.2, parents: [] });
    record.append({ t: "idea.reject", id: "i1", reason: "collided" });
    record.append({ t: "arbiter.verdict", kind: "novelty", id: "i1", verdict: "distinct", costUsd: 0.01 });
    record.append({ t: "arbiter.verdict", kind: "collision", id: "i1", verdict: "collided", costUsd: 0.01 });
    record.append({ t: "stop", stopKind: "rounds", round: 1 });
    writeStatus(run, { searchHealth: 2 / 3, searchHealthFloor: 0.8, noveltyEnforced: false });
    const evidence = [
      { priorArt: { status: "collided", artifact: { title: "x", url: "https://x" } }, probe: { status: "pass" }, status: "rejected", similarity: 0.9 },
      { priorArt: { status: "not_falsified" }, probe: { status: "fail" }, status: "active", similarity: 0.2 },
      { priorArt: { status: "search_failed" }, probe: { status: "timeout" }, status: "unranked", similarity: 0.1 },
    ];
    evidence.forEach((item, i) => writeFileSync(join(run.ideasDir, `i${i + 1}.evidence.json`), JSON.stringify(item)));
    writeFileSync(run.frontier, JSON.stringify({ rawFront: ["i1", "i2"], shown: ["i2"] }));
    const tournament = [
      { ...line(1, "a", "a", 1), order: "ab" }, { ...line(2, "a", "a", 1), order: "ba" },
      { ...line(3, "b", "a", 2), order: "ab" }, { ...line(4, "a", "b", 2), order: "ba" },
    ];
    writeFileSync(run.tournament, tournament.map((item) => JSON.stringify(item)).join("\n") + "\n");

    const metrics: IdeationMetrics = computeMetrics(run);
    const compatible: Metrics = metrics;
    expect(compatible.schemaVersion).toBe(1);
    expect(Object.keys(metrics).sort()).toEqual([
      "addendaHashes", "arbiterCalls", "collisionRate", "corruptRecordLines", "cost", "costByPhase", "costByRole", "costUsd",
      "effortByRole", "frontier", "honestExits", "modelCalls", "noveltyEnforced", "priorArt", "probes", "refusals",
      "schemaVersion", "searchHealth", "similarity", "stops", "tokensByRole", "tournament",
    ]);
    expect(metrics.costByRole.judge).toBe(0.25);
    expect(metrics.costByPhase.ideate).toBe(0.25);
    expect(metrics.arbiterCalls).toEqual({ novelty: 1, collision: 1 });
    expect(metrics.searchHealth.rate).toBeCloseTo(2 / 3);
    expect(metrics.noveltyEnforced).toBe(false);
    expect(metrics.collisionRate).toBeNull();
    expect(metrics.probes.passRate).toBeCloseTo(1 / 3);
    expect(metrics.frontier).toEqual({ raw: 2, shown: 1 });
    expect(Object.keys(metrics.cost)).toEqual(PHASES);
    expect(metrics.cost.ideate).toEqual({
      usd: 0.25, tokens: 13, turns: 1, successes: 1, usdPerSuccess: 0.25,
      tokensPerSuccess: 13, turnsPerSuccess: 1, cacheReadRatio: 1 / 11,
      cacheWrite: 0, reasoningTokens: 3,
    });
    expect(metrics.refusals.byRole).toEqual({ ...byRole(0), judge: 1 });
    expect(metrics.refusals.byCategory).toEqual({ safety: 1 });
    expect(metrics.addendaHashes).toEqual(["family-a"]);
    expect(metrics.effortByRole).toEqual({ ...byRole<Effort | null>(null), judge: "medium" });
    expect(metrics.tournament.tieRate.feasibility).toBe(0.5);
    expect(metrics.tournament).toHaveProperty("haloCorrelation");
    expect(writeMetrics(run)).toEqual(metrics);
    expect(JSON.parse(readFileSync(run.metrics, "utf8"))).toEqual(metrics);
  });

  test("initializes and increments every widened stop kind without NaN", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-stops-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    for (const stopKind of STOP_KINDS) record.append({ t: "stop", stopKind });
    const stops = computeMetrics(run).stops;
    expect(Object.keys(stops).sort()).toEqual([...STOP_KINDS].sort());
    for (const stopKind of STOP_KINDS) {
      expect(stops[stopKind]).toBe(1);
      expect(Number.isNaN(stops[stopKind])).toBe(false);
    }
    const metrics = computeMetrics(run);
    expect(Object.keys(metrics.cost)).toEqual(PHASES);
    for (const phase of PHASES) {
      expect(metrics.cost[phase]).toEqual({
        usd: 0, tokens: 0, turns: 0, successes: 0, usdPerSuccess: null,
        tokensPerSuccess: null, turnsPerSuccess: null, cacheReadRatio: null,
        cacheWrite: 0, reasoningTokens: null,
      });
    }
    expect(metrics.refusals.byRole).toEqual(byRole(0));
    expect(metrics.refusals.byCategory).toEqual({});
    expect(metrics.addendaHashes).toEqual([]);
    expect(metrics.effortByRole).toEqual(byRole<Effort | null>(null));
  });

  test("uses the modal effortSent with a fixed lower-effort tie break and distinct first-seen addenda", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-metric-modes-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    const call = (effortSent: "low" | "high", addendaHash: string) => record.append({
      t: "model.call", role: "brain", provider: "p", model: "m", effortSent, addendaHash,
      inputHash: effortSent, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
      stopReason: "stop", excerpt: "",
    });
    call("high", "second"); call("low", "first"); call("high", "second"); call("low", "third");
    const metrics = computeMetrics(run);
    expect(metrics.effortByRole.brain).toBe("low");
    expect(metrics.addendaHashes).toEqual(["second", "first", "third"]);
  });
});
