import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { Archive, type InsertCandidate, fixedOrder, insertAll, noveltyVerdict } from "../../src/ideation/archive";
import type { Dossier, Evidence } from "../../src/ideation/dossier";
import { mergeProbeEvidence } from "../../src/ideation/probe";
import type { PhaseDeps } from "../../src/phases/frame";

const COST = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } as never;
const USAGE = { input: 100, output: 100 };

function verdictCall(restatement: boolean) {
  return { content: [{ type: "toolCall", name: "novelty", arguments: { restatement, reason: "because" } }], usage: USAGE };
}

/** An arbiter that answers every tie-break the same way. */
function arbiter(restatement: boolean, calls?: { n: number }) {
  const handler = () => {
    if (calls) calls.n += 1;
    return verdictCall(restatement);
  };
  return createMockModel({ id: "mock-arbiter", cost: COST, handler } as never);
}

function setup(model: unknown = arbiter(true)) {
  const home = mkdtempSync(join(tmpdir(), "kiln-archive-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const cfg = defaultConfig();
  const deps = { home, run, record, cfg, models: () => ({ model: model as never, ref: "mock/mock-arbiter" }), apiKeyFor: async () => "k", effort: "low", streamFn: streamMock as never, limiter: new Limiter(2) } as unknown as PhaseDeps;
  return { home, run, record, cfg, deps, archive: new Archive(run, record) };
}

function dossier(id: string, over: Partial<Dossier> = {}): Dossier {
  const axisValues = { "who it serves": "hobbyists" };
  return { id, title: `Idea ${id}`, mechanism: `mechanism of ${id}`, draws: "shingling", axisValues, testableClaim: `claim ${id}`, cheapestTest: `test ${id}`, failureReason: `failure ${id}`, parents: [], ...over };
}

/** Four unrelated ideas: no pair is anywhere near the 0.45 restatement threshold. */
const UNRELATED: [string, string][] = [
  ["Trigram dedup for run journals", "hash character trigrams and compare each candidate against an index"],
  ["Solar kite tethering for coastal towns", "anchor a high altitude kite to a floating buoy and winch the line"],
  ["Braille menus printed on demand", "emboss a paper menu at the table from the restaurant order system"],
  ["Compost heat for greenhouse floors", "pipe water through an active compost pile and back under the beds"],
];

function unrelated(id: string, n: number, over: Partial<Dossier> = {}): Dossier {
  const [title, mechanism] = UNRELATED[n]!;
  return dossier(id, { title, mechanism, ...over });
}

function evidenceOf(run: { ideasDir: string }, id: string): Evidence {
  return JSON.parse(readFileSync(join(run.ideasDir, `${id}.evidence.json`), "utf8")) as Evidence;
}

/** Insert unrelated ideas under the given ids and cell values, in order. */
function stock(spec: [string, number, string][]) {
  const s = setup();
  for (const [id, n, who] of spec) s.archive.insert(unrelated(id, n, { axisValues: { who } }));
  return s;
}

const stocked = () => stock([["a", 0, "one"], ["b", 1, "one"], ["c", 2, "two"], ["d", 3, "three"]]);
const celled = () => stock([["x", 0, "one"], ["y", 1, "one"], ["z", 2, "one"], ["w", 3, "two"]]);

function rejects(record: RunRecord) {
  return record.read().flatMap((e) => (e.t === "idea.reject" ? [{ id: e.id, reason: e.reason, against: e.against }] : []));
}

function modelCalls(record: RunRecord): number {
  return record.read().filter((e) => e.t === "model.call").length;
}

describe("Archive.insert", () => {
  test("writes the island's own words, an evidence sidecar, and one idea.insert", () => {
    const { run, record, archive } = setup();
    const e = archive.insert(dossier("r1-i1-1"), { similarity: 0.2, vsBound: true, source: "## Title\nas written\n" });
    expect(e).toEqual({ status: "unranked", cell: "who it serves=hobbyists", parents: [], similarity: 0.2, vsBound: true });
    expect(readFileSync(join(run.ideasDir, "r1-i1-1.md"), "utf8")).toBe("## Title\nas written\n");
    expect(evidenceOf(run, "r1-i1-1")).toEqual(e);
    const inserts = record.read().filter((x) => x.t === "idea.insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ id: "r1-i1-1", cell: "who it serves=hobbyists", similarity: 0.2, parents: [] });
  });

  test("parentage reaches the sidecar, which is the protected, resume-authoritative artifact", () => {
    const { run, archive } = setup();
    archive.insert(dossier("r2-i1-1", { parents: ["r1-i1-3", "r1-i2-1"] }));
    expect(evidenceOf(run, "r2-i1-1").parents).toEqual(["r1-i1-3", "r1-i2-1"]);
  });

  test("without a source it stores the canonical dossier render, provenance included", () => {
    const { run, archive } = setup();
    archive.insert(dossier("r1-i1-1", { lens: "L2" }));
    const md = readFileSync(join(run.ideasDir, "r1-i1-1.md"), "utf8");
    expect(md).toContain("Lens: L2");
    expect(md).toContain("## Mechanism");
  });

  test("a restatement still joins the archive, rejected, and is recorded as such", () => {
    const { run, record, archive } = setup();
    archive.insert(dossier("r1-i2-1"), { similarity: 0.9, reject: { reason: "restatement", against: "r1-i1-1" } });
    expect(evidenceOf(run, "r1-i2-1")).toMatchObject({ status: "rejected", rejectReason: "restatement" });
    expect(archive.all().map((d) => d.id)).toEqual(["r1-i2-1"]);
    expect(record.read().filter((e) => e.t === "idea.insert")).toHaveLength(0);
    expect(rejects(record)).toEqual([{ id: "r1-i2-1", reason: "restatement", against: "r1-i1-1" }]);
  });

  test("is idempotent: a second insert of the same id records nothing and keeps the first evidence", () => {
    const { record, archive } = setup();
    archive.insert(dossier("r1-i1-1"), { similarity: 0.1 });
    const again = archive.insert(dossier("r1-i1-1"), { similarity: 0.9 });
    expect(again.similarity).toBe(0.1);
    expect(record.read().filter((e) => e.t === "idea.insert")).toHaveLength(1);
    expect(archive.size).toBe(1);
  });

  test("a fresh archive over an existing run adopts the sidecars already on disk", () => {
    const { run, record } = setup();
    const first = new Archive(run, record);
    first.insert(dossier("r1-i1-1"));
    first.markRejected("r1-i1-1", "collided", "https://example.com/x");
    const resumed = new Archive(run, record);
    resumed.insert(dossier("r1-i1-1"));
    expect(resumed.get("r1-i1-1")?.evidence.status).toBe("rejected");
    expect(resumed.seedable()).toEqual([]);
    expect(record.read().filter((e) => e.t === "idea.insert")).toHaveLength(1);
  });
});

describe("Archive queries", () => {
  test("cells are the idea's axis values, keyed by id", () => {
    const { archive } = stocked();
    expect(archive.cells()).toEqual({ a: { who: "one" }, b: { who: "one" }, c: { who: "two" }, d: { who: "three" } });
  });

  test("everything starts unranked and seedable", () => {
    const { archive } = stocked();
    expect(archive.unranked()).toEqual(["a", "b", "c", "d"]);
    expect(archive.seedable()).toEqual(["a", "b", "c", "d"]);
  });

  test("a compared idea leaves the unranked set but stays seedable", () => {
    const { archive } = stocked();
    archive.mergeEvidence("a", { status: "active", strengths: { value: { mean: 1, lo: 0, hi: 2, n: 3 }, feasibility: { mean: 0, lo: -1, hi: 1, n: 3 } } });
    expect(archive.unranked()).toEqual(["b", "c", "d"]);
    expect(archive.seedable()).toContain("a");
  });

  test("champions are one per cell, strongest cell first, and never a rejected idea", () => {
    const { archive } = stocked();
    const s = (mean: number) => ({ value: { mean, lo: mean - 1, hi: mean + 1, n: 3 }, feasibility: { mean: 0, lo: -1, hi: 1, n: 3 } });
    archive.mergeEvidence("a", { strengths: s(0.2) });
    archive.mergeEvidence("b", { strengths: s(0.9) });
    archive.mergeEvidence("c", { strengths: s(0.5) });
    expect(archive.champions()).toEqual(["b", "c", "d"]);
    archive.markRejected("b", "collided");
    expect(archive.champions()).toEqual(["c", "a", "d"]);
  });

  test("mergeEvidence never clobbers a probe result written straight to disk", () => {
    const { run, archive } = stocked();
    mergeProbeEvidence(run, "a", { status: "pass", exitCode: 0 });
    archive.mergeEvidence("a", { status: "active" });
    expect(evidenceOf(run, "a").probe).toEqual({ status: "pass", exitCode: 0 });
    expect(evidenceOf(run, "a").cell).toBe("who=one");
  });

  test("marking an idea the archive does not hold is ignored rather than fatal", () => {
    const { record, archive } = stocked();
    archive.markRejected("nobody", "collided");
    expect(rejects(record)).toEqual([]);
  });
});

describe("Archive.markLostCell", () => {
  test("a cell keeps its strongest idea and loses the rest", () => {
    const { record, archive } = celled();
    expect(archive.markLostCell({ x: 1, y: 0.5, z: 0.1, w: 0.2 })).toEqual(["y", "z"]);
    expect(archive.seedable()).toEqual(["x", "w"]);
    expect(rejects(record)).toEqual([{ id: "y", reason: "lost_cell", against: undefined }, { id: "z", reason: "lost_cell", against: undefined }]);
  });

  test("an idea with no interval this round is exempt", () => {
    const { archive } = celled();
    // z was never admitted to this round's tournament, so it has no interval and cannot lose its cell.
    expect(archive.markLostCell({ x: 1, y: 0.5, w: 0.2 })).toEqual(["y"]);
    expect(archive.seedable()).toEqual(["x", "z", "w"]);
    expect(archive.get("z")?.evidence.status).toBe("unranked");
  });

  test("a cell with one interval-bearing idea loses nobody", () => {
    const { archive } = celled();
    expect(archive.markLostCell({ x: 1, w: 0.2 })).toEqual([]);
    expect(archive.seedable()).toHaveLength(4);
  });

  test("losing a cell never removes an idea from the archive", () => {
    const { archive } = celled();
    archive.markLostCell({ x: 1, y: 0.5, z: 0.1 });
    expect(archive.all().map((d) => d.id)).toEqual(["x", "y", "z", "w"]);
    expect(archive.get("y")?.evidence.rejectReason).toBe("lost_cell");
  });

  test("an already rejected idea is not rejected twice", () => {
    const { record, archive } = celled();
    archive.markRejected("y", "collided");
    archive.markLostCell({ x: 1, y: 0.5, z: 0.1 });
    expect(rejects(record).filter((r) => r.id === "y")).toHaveLength(1);
  });

  test("ties inside a cell are broken by id, so the choice replays", () => {
    const { archive } = celled();
    expect(archive.markLostCell({ x: 1, y: 1, z: 1 })).toEqual(["y", "z"]);
  });
});

describe("noveltyVerdict", () => {
  test("asks one arbiter question and returns its answer with its cost", async () => {
    let seen = "";
    const handler = (ctx: unknown) => {
      const msgs = ((ctx as { messages?: { role?: string; content?: unknown }[] }).messages ?? []).filter((m) => m.role === "user");
      seen = JSON.stringify(msgs.at(-1)?.content ?? "");
      return verdictCall(false);
    };
    const model = createMockModel({ id: "mock-arbiter", cost: COST, handler } as never);
    const { deps, record } = setup(model);
    const v = await noveltyVerdict(deps, unrelated("r1-i2-1", 0), unrelated("r1-i1-1", 1));
    expect(v.restatement).toBe(false);
    expect(v.reason).toBe("because");
    expect(v.costUsd).toBeGreaterThan(0);
    expect(seen).toContain("Trigram dedup for run journals");
    expect(seen).toContain("Solar kite tethering");
    expect(modelCalls(record)).toBe(1);
  });

  test("an arbiter that answers nothing falls back to the similarity threshold", async () => {
    const model = createMockModel({ id: "mock-arbiter", cost: COST, handler: () => ({ content: ["they feel similar"], usage: USAGE }) } as never);
    const { deps } = setup(model);
    const v = await noveltyVerdict(deps, unrelated("b", 0), unrelated("a", 1));
    expect(v.restatement).toBe(true);
    expect(v.reason).toContain("threshold");
  });
});

describe("insertAll", () => {
  /** Near-identical to `original(...)` in title and mechanism, so it clears the 0.45 threshold. */
  const restatementOf = (id: string, of: string) =>
    dossier(id, { title: "Trigram deduplication for run journals", mechanism: "hash character trigrams and compare every candidate against an index", draws: of });
  const original = (id: string) => unrelated(id, 0);

  test("an idea unlike everything in the archive goes straight in, no arbiter", async () => {
    const calls = { n: 0 };
    const { deps, archive, record } = setup(arbiter(true, calls));
    const r = await insertAll(deps, archive, [{ dossier: unrelated("a", 0) }, { dossier: unrelated("b", 1) }]);
    expect(r.inserted).toEqual(["a", "b"]);
    expect(r.rejected).toEqual([]);
    expect(r.arbiterCalls).toBe(0);
    expect(calls.n).toBe(0);
    expect(r.outcomes[1]!.similarity).toBeLessThan(deps.cfg.ideation.jaccardThreshold);
    expect(modelCalls(record)).toBe(0);
  });

  test("a near-duplicate is escalated to exactly one arbiter tie-break and rejected on its answer", async () => {
    const calls = { n: 0 };
    const { deps, archive, record } = setup(arbiter(true, calls));
    const r = await insertAll(deps, archive, [{ dossier: original("a") }, { dossier: restatementOf("b", "a") }]);
    expect(r.rejected).toEqual(["b"]);
    expect(r.arbiterCalls).toBe(1);
    expect(calls.n).toBe(1);
    expect(r.outcomes[1]).toMatchObject({ id: "b", status: "restatement", against: "a", arbiter: true });
    expect(r.outcomes[1]!.similarity).toBeGreaterThanOrEqual(deps.cfg.ideation.jaccardThreshold);
    expect(r.costUsd).toBeGreaterThan(0);
    const verdicts = record.read().filter((e) => e.t === "arbiter.verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: "novelty", id: "b", against: "a", verdict: "restatement" });
    expect(rejects(record)).toEqual([{ id: "b", reason: "restatement", against: "a" }]);
  });

  test("the arbiter's answer decides, not the threshold: a close but distinct idea is kept", async () => {
    const { deps, archive, record } = setup(arbiter(false));
    const r = await insertAll(deps, archive, [{ dossier: original("a") }, { dossier: restatementOf("b", "a") }]);
    expect(r.inserted).toEqual(["a", "b"]);
    expect(r.rejected).toEqual([]);
    expect(record.read().filter((e) => e.t === "arbiter.verdict")[0]).toMatchObject({ verdict: "distinct" });
  });

  test("at most one tie-break per idea, and never one for an idea below the threshold", async () => {
    const calls = { n: 0 };
    const { deps, archive } = setup(arbiter(false, calls));
    const candidates = [{ dossier: original("a") }, { dossier: restatementOf("b", "a") }, { dossier: restatementOf("c", "a") }, { dossier: unrelated("d", 2) }];
    const r = await insertAll(deps, archive, candidates);
    // Two ideas cleared the threshold, so exactly two tie-breaks were spent: one each, never more.
    expect(r.arbiterCalls).toBe(2);
    expect(calls.n).toBe(2);
    expect(r.outcomes.map((o) => o.arbiter)).toEqual([false, true, true, false]);
  });

  test("past the arbiter cap the threshold decides mechanically, and the fallback is recorded", async () => {
    const calls = { n: 0 };
    const { deps, archive, record } = setup(arbiter(false, calls));
    const r = await insertAll(deps, archive, [{ dossier: original("a") }, { dossier: restatementOf("b", "a") }], { arbiterBudget: 0 });
    expect(r.rejected).toEqual(["b"]);
    expect(r.arbiterCalls).toBe(0);
    expect(calls.n).toBe(0);
    expect(record.read().some((e) => e.t === "note" && e.text.includes("novelty arbiter cap spent"))).toBe(true);
    expect(rejects(record)).toEqual([{ id: "b", reason: "restatement", against: "a" }]);
  });

  test("the cap binds within one call: the budget runs out mid-list", async () => {
    const calls = { n: 0 };
    const { deps, archive } = setup(arbiter(false, calls));
    const candidates = [{ dossier: original("a") }, { dossier: restatementOf("b", "a") }, { dossier: restatementOf("c", "a") }];
    const r = await insertAll(deps, archive, candidates, { arbiterBudget: 1 });
    expect(calls.n).toBe(1);
    expect(r.outcomes.map((o) => o.status)).toEqual(["inserted", "inserted", "restatement"]);
  });

  test("an idea already decided is reused, in memory and after a resume, without a second tie-break", async () => {
    const calls = { n: 0 };
    const { deps, run, record } = setup(arbiter(true, calls));
    const candidates: InsertCandidate[] = [{ dossier: original("a") }, { dossier: restatementOf("b", "a") }];
    const archive = new Archive(run, record);
    expect((await insertAll(deps, archive, candidates)).rejected).toEqual(["b"]);
    const before = record.read().length;
    expect((await insertAll(deps, archive, candidates)).outcomes.map((o) => o.status)).toEqual(["reused", "reused"]);
    // The crash-and-resume path: a brand new Archive, empty in memory, over the same run directory.
    const resumed = new Archive(run, record);
    const again = await insertAll(deps, resumed, candidates);
    expect(calls.n).toBe(1);
    expect(record.read().length).toBe(before);
    expect(again.outcomes.map((o) => o.status)).toEqual(["reused", "reused"]);
    expect(again.costUsd).toBe(0);
    expect(again.arbiterCalls).toBe(0);
    // The result must not say "inserted" for an idea the archive still holds rejected.
    expect(again.inserted).toEqual(["a"]);
    expect(again.rejected).toEqual(["b"]);
    expect(again.outcomes[1]!.rejectedAs).toBe("restatement");
    expect(resumed.seedable()).toEqual(["a"]);
  });

  test("a reused idea an earlier round rejected reports that round's reason, not restatement", async () => {
    const { deps, run, record } = setup(arbiter(true));
    const archive = new Archive(run, record);
    await insertAll(deps, archive, [{ dossier: original("a") }]);
    archive.markRejected("a", "collided", "https://example.com/x");
    const again = await insertAll(deps, new Archive(run, record), [{ dossier: original("a") }]);
    expect(again.outcomes[0]!.rejectedAs).toBe("collided");
    expect(again.rejected).toEqual(["a"]);
    expect(again.inserted).toEqual([]);
  });

  test("vsBound and the island's own block are carried into the archive", async () => {
    const { deps, run, archive } = setup(arbiter(true));
    await insertAll(deps, archive, [{ dossier: original("a"), vsBound: false, block: "## Title\nverbatim\n" }]);
    expect(evidenceOf(run, "a").vsBound).toBe(false);
    expect(readFileSync(join(run.ideasDir, "a.md"), "utf8")).toBe("## Title\nverbatim\n");
    expect(existsSync(join(run.ideasDir, "a.evidence.json"))).toBe(true);
  });
});

describe("fixedOrder", () => {
  const of = (...ids: string[]) => ids.map((id) => ({ dossier: dossier(id) }));
  const idsOf = (cs: InsertCandidate[]) => cs.map((c) => c.dossier.id);

  test("sorts by round, then island, then idea — as numbers, not as text", () => {
    const shuffled = of("r1-i2-10", "r2-i1-1", "r1-i1-2", "r1-i2-2", "r1-i1-10", "r1-i1-1");
    expect(idsOf(fixedOrder(shuffled))).toEqual(["r1-i1-1", "r1-i1-2", "r1-i1-10", "r1-i2-2", "r1-i2-10", "r2-i1-1"]);
  });

  test("ids that are not island ids keep their given order, after the ones that are", () => {
    expect(idsOf(fixedOrder(of("b", "r1-i1-2", "a", "r1-i1-1")))).toEqual(["r1-i1-1", "r1-i1-2", "b", "a"]);
  });

  test("leaves the input array alone", () => {
    const given = of("r1-i2-1", "r1-i1-1");
    fixedOrder(given);
    expect(idsOf(given)).toEqual(["r1-i2-1", "r1-i1-1"]);
  });
});

describe("serial insertion in a fixed order", () => {
  const restated = (id: string) =>
    dossier(id, { title: "Trigram deduplication for run journals", mechanism: "hash character trigrams and compare every candidate against an index" });

  /** Two islands, where island 2's second idea restates island 1's first. */
  const islands = (): Record<number, InsertCandidate[]> => ({
    1: [{ dossier: unrelated("r1-i1-1", 0) }, { dossier: unrelated("r1-i1-2", 1) }],
    2: [{ dossier: unrelated("r1-i2-1", 2) }, { dossier: restated("r1-i2-2") }],
  });

  /** Hand the candidates over exactly as `arrival` orders them, with no sorting by the caller. */
  async function insertAs(arrival: number[][]) {
    const { deps, archive, record } = setup(arbiter(true));
    const flat = islands();
    const given = arrival.map(([island, idea]) => flat[island!]![idea!]!);
    const r = await insertAll(deps, archive, given);
    return { result: r, archive, record };
  }

  const IN_ORDER = [[1, 0], [1, 1], [2, 0], [2, 1]];
  // Island 2 finishing first, its two ideas interleaved with island 1's, exactly as a limiter would
  // deliver them: nothing here is sorted by the caller.
  const SHUFFLED = [[2, 1], [1, 1], [2, 0], [1, 0]];

  test("a shuffled hand-off produces the same archive as an in-order one", async () => {
    const first = await insertAs(IN_ORDER);
    const second = await insertAs(SHUFFLED);
    expect(second.result.outcomes).toEqual(first.result.outcomes);
    expect(second.archive.seedable()).toEqual(first.archive.seedable());
    expect(second.archive.ids()).toEqual(first.archive.ids());
    expect(rejects(second.record)).toEqual(rejects(first.record));
  });

  test("and insertAll's own sort is what pins it, not the caller", async () => {
    // r1-i2-2 restates r1-i1-1 and arrives first; taken as given it would win the slot. It does not.
    const { result, archive } = await insertAs(SHUFFLED);
    expect(result.rejected).toEqual(["r1-i2-2"]);
    expect(result.outcomes.map((o) => o.id)).toEqual(["r1-i1-1", "r1-i1-2", "r1-i2-1", "r1-i2-2"]);
    expect(archive.seedable()).toContain("r1-i1-1");
    expect(archive.seedable()).not.toContain("r1-i2-2");
  });
});
