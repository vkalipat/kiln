import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { collapsePairs } from "../../src/ideation/bt";
import type { FrontierFile } from "../../src/phases/ideate";
import { bwsGroups, rejectIdea, requestAnotherRound, runCheckpoint } from "../../src/phases/checkpoint";
import type { PhaseDeps } from "../../src/phases/frame";
import { readTournament } from "../../src/ideation/tournament";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-checkpoint-"));
  const run = createRun(home, "seed", { id: "checkpoint" });
  const record = new RunRecord(run.record); const cfg = defaultConfig(); cfg.ideation.bootstrapSamples = 20;
  const ids = ["r1-i1-1", "r1-i1-2", "r1-i1-3", "r1-i1-4", "r1-i1-5"];
  const ideas = ids.map((id, index) => ({ id, backfill: false, cell: `cell-${index % 3}`, value: { mean: 5 - index, lo: 4 - index, hi: 6 - index, n: 3 }, feasibility: { mean: index, lo: index - 1, hi: index + 1, n: 3 } }));
  const frontier: FrontierFile = { version: 1, mode: "loop", round: 1, rawFront: [...ids], shown: [...ids], eligible: [...ids], ideas, ladders: { value: [...ids], feasibility: [...ids].reverse() }, searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true };
  writeFileSync(run.frontier, `${JSON.stringify(frontier, null, 2)}\n`);
  for (const id of ids) {
    writeFileSync(join(run.renderedDir, `${id}-r1.md`), `# ${id}\n`);
    writeFileSync(join(run.ideasDir, `${id}.evidence.json`), `${JSON.stringify({ status: "active", cell: ideas.find((idea) => idea.id === id)!.cell, priorArt: { status: "not_falsified" }, probe: { status: "pass" } })}\n`);
  }
  writeStatus(run, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" }, shape: "product" });
  const model = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
  const deps: PhaseDeps = { home, run, record, cfg, models: () => ({ model: model as never, ref: "mock/unused" }), apiKeyFor: async () => "k", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(2) };
  return { home, run, record, cfg, ids, frontier, deps };
}

describe("bwsGroups", () => {
  test("uses groups of four, covers every idea at least twice, and spans cells", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const cells: Record<string, string> = { a: "x", b: "x", c: "y", d: "y", e: "z", f: "z" };
    const groups = bwsGroups(ids, cells);
    expect(groups.every((group) => group.length === 4 && new Set(group).size === 4)).toBe(true);
    for (const id of ids) expect(groups.filter((group) => group.includes(id)).length).toBeGreaterThanOrEqual(2);
    expect(groups.every((group) => new Set(group.map((id) => cells[id])).size > 1)).toBe(true);
    expect(bwsGroups(ids, cells)).toEqual(groups);
  });

  test("every group spans cells even when one cell has only one idea", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const cells = Object.fromEntries(ids.map((id) => [id, id === "h" ? "rare" : "common"]));
    const groups = bwsGroups(ids, cells);
    expect(groups.every((group) => new Set(group.map((id) => cells[id])).size === 2)).toBe(true);
    for (const id of ids) expect(groups.filter((group) => group.includes(id)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("runCheckpoint", () => {
  test("a cancelled checkpoint ask records no failure or answer evidence", async () => {
    const s = setup();
    const statusBefore = readFileSync(s.run.status, "utf8");
    const frontierBefore = readFileSync(s.run.frontier, "utf8");
    const evidenceBefore = s.ids.map((id) => readFileSync(join(s.run.ideasDir, `${id}.evidence.json`), "utf8"));
    const control = new RunControl();
    const pending = withRunControl(control, () => runCheckpoint(s.deps, {
      write: () => {},
      ask: async () => {
        control.cancel("checkpoint cancelled");
        throw control.signal.reason;
      },
    }));
    await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
    const events = s.record.read();
    expect(events.filter((event) => event.t === "checkpoint.shown")).toHaveLength(1);
    expect(events.some((event) => event.t === "checkpoint.bws" || event.t === "checkpoint.decision" || event.t === "failure")).toBe(false);
    expect(readTournament(s.run)).toEqual([]);
    expect(readFileSync(s.run.status, "utf8")).toBe(statusBefore);
    expect(readFileSync(s.run.frontier, "utf8")).toBe(frontierBefore);
    expect(s.ids.map((id) => readFileSync(join(s.run.ideasDir, `${id}.evidence.json`), "utf8"))).toEqual(evidenceBefore);
    expect(existsSync(s.run.lock)).toBe(false);
  });

  test("a checkpoint answer that resolves while cancellation lands is not recorded", async () => {
    const s = setup();
    const control = new RunControl();
    const pending = withRunControl(control, () => runCheckpoint(s.deps, {
      write: () => {},
      ask: async (prompt) => {
        control.cancel("cancel while answer resolves");
        const group = /^Group \d+: ([^\n]+)/.exec(prompt)?.[1]?.split(", ") ?? s.ids.slice(0, 4);
        return `best ${group[0]} worst ${group[3]}`;
      },
    }));
    await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
    expect(s.record.read().some((event) => event.t === "checkpoint.bws" || event.t === "checkpoint.decision" || event.t === "failure")).toBe(false);
    expect(readTournament(s.run)).toEqual([]);
  });

  test("records the shown set, BWS answers, both human orderings, refit, and final pick", async () => {
    const s = setup(); const prompts: string[] = []; const output: string[] = [];
    const result = await runCheckpoint(s.deps, { write: (text) => output.push(text), ask: async (prompt) => {
      prompts.push(prompt);
      const group = /^Group \d+: ([^\n]+)/.exec(prompt)?.[1]?.split(", ");
      return group ? `best ${group[0]} worst ${group[3]}` : `pick ${s.ids[1]}`;
    } });
    expect(result).toEqual({ outcome: "ok" });
    expect(readStatus(s.run)).toMatchObject({ chosenIdeaId: s.ids[1], phase: "form", state: "running" });
    const events = s.record.read();
    expect(events.filter((event) => event.t === "checkpoint.shown")).toHaveLength(1);
    expect(events.filter((event) => event.t === "checkpoint.bws")).toHaveLength(5);
    expect(events.find((event) => event.t === "checkpoint.decision")).toMatchObject({ kind: "pick", id: s.ids[1] });
    expect(output.join("")).toContain("novelty enforced: true");
    const human = readTournament(s.run).filter((line) => line.source === "human");
    expect(human).toHaveLength(50);
    for (const id of new Set(human.map((line) => line.comparisonId))) expect(human.filter((line) => line.comparisonId === id).map((line) => line.order).sort()).toEqual(["ab", "ba"]);
    expect(collapsePairs(human, { humanWeight: 3 }).value).toHaveLength(25);
    const metrics = JSON.parse(readFileSync(s.run.metrics, "utf8"));
    expect(metrics.tournament.tieRate).toEqual({ value: null, feasibility: null });
    expect(metrics.tournament.haloCorrelation).toBeNull();
    expect(metrics.tournament.selfPreferenceRisk).toEqual({ none: 0, a: 0, b: 0, both: 0 });
    expect(existsSync(s.run.lock)).toBe(false);
    expect(prompts.at(-1)).toContain("Choose:");

    writeStatus(s.run, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" }, chosenIdeaId: undefined });
    expect(await runCheckpoint(s.deps, { write: () => {}, ask: async () => `pick ${s.ids[1]}` })).toEqual({ outcome: "ok" });
    expect(readTournament(s.run).filter((line) => line.source === "human")).toHaveLength(human.length);
  });

  test("autonomous mode excludes a prior rejection and picks the next true-front value leader", async () => {
    const s = setup(); s.record.append({ t: "checkpoint.decision", kind: "reject", id: s.ids[0], reason: "not useful" });
    expect(await runCheckpoint(s.deps, { write: () => {}, ask: async () => "unused" }, { autonomous: true })).toEqual({ outcome: "ok" });
    expect(readStatus(s.run).chosenIdeaId).toBe(s.ids[1]);
    expect(s.record.read().findLast((event) => event.t === "checkpoint.decision")).toMatchObject({ kind: "autonomous_pick", id: s.ids[1] });
    expect(s.record.read().find((event) => event.t === "checkpoint.shown")).toMatchObject({
      ideas: expect.not.arrayContaining([s.ids[0]]),
      ladders: { value: expect.not.arrayContaining([s.ids[0]]), feasibility: expect.not.arrayContaining([s.ids[0]]) },
    });
  });

  test("formation exclusions are honored and an empty true frontier exits honestly", async () => {
    const s = setup();
    const result = await runCheckpoint(s.deps, { write: () => {}, ask: async () => "unused" }, { autonomous: true, exclude: s.ids });
    expect(result).toMatchObject({ outcome: "honest_exit", kind: "no_idea_clears_bar" });
    expect(readStatus(s.run).state).toBe("done");
  });

  test("an invalid best-worst response is a recorded verify failure", async () => {
    const s = setup();
    const result = await runCheckpoint(s.deps, { write: () => {}, ask: async () => "not a valid answer" });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "verify" });
    expect(readStatus(s.run)).toMatchObject({ state: "failed", outcome: { kind: "failure", failureClass: "verify" } });
    expect(s.record.read().some((event) => event.t === "failure" && event.class === "verify")).toBe(true);
  });

  test("standalone reject and another-round decisions update durable frontier/cursor state", () => {
    const rejected = setup();
    expect(rejectIdea(rejected, rejected.ids[0], "too broad")).toMatchObject({ outcome: "stopped" });
    expect(JSON.parse(readFileSync(rejected.run.frontier, "utf8")).shown).not.toContain(rejected.ids[0]);
    const another = setup();
    writeStatus(another.run, { chosenIdeaId: another.ids[0] });
    expect(requestAnotherRound(another, "focus on teams")).toEqual({ outcome: "ok" });
    expect(readStatus(another.run)).toMatchObject({ state: "running", ideationRounds: 2, cursor: { round: 2, step: "round.start" } });
    expect(readStatus(another.run).chosenIdeaId).toBeUndefined();
  });
});
