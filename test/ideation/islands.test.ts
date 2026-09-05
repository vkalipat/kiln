import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import type { Axis } from "../../src/ideation/dossier";
import { type IslandModels, type IslandPlan, VS_PROBABILITY_MAX, assignIslands, deriveIdeas, formatRawIsland, islandContract, parseRawIsland, playbookMoves, rawIslandPath, recordIslandAssignments, runIsland, validateBatch, writeRawIsland } from "../../src/ideation/islands";
import type { PhaseDeps } from "../../src/phases/frame";

const COST = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } as never;
const USAGE = { input: 100, output: 100 };

const AXES: Axis[] = [
  { name: "who it serves", values: ["hobbyists", "teams", "enterprises"] },
  { name: "mechanism class", values: ["index", "model", "protocol"] },
];

const PLAYBOOK = `# playbook

## lenses
- L1 [helpful:0 harmful:0] Invert a shared assumption.
- L2 [helpful:1 harmful:0] Recombine two atoms that never co-occur.
- L3 [helpful:0 harmful:0] Transfer a distant domain's mechanism.

## ideate
- M1 [helpful:0 harmful:0] Combine two frontier ideas.
- M2 [helpful:0 harmful:0] Specialize to a narrower user.
- M3 [helpful:0 harmful:0] Generalize the mechanism.
- M4 [helpful:0 harmful:0] Swap the domain.
- M5 [helpful:0 harmful:0] Turn the failure reason into a feature.
`;

interface IdeaOptions { title?: string; mechanism?: string; probability?: string; who?: string; drop?: string }

/** One well-formed `# Idea <n>` block, with single fields overridable to break exactly one rule. */
function idea(n: number, o: IdeaOptions = {}): string {
  const parts: [string, string][] = [
    ["Title", o.title ?? `Idea ${n} title`],
    ["Mechanism", o.mechanism ?? `mechanism number ${n}`],
    ["Draws on", "shingling"],
    ["Axes", `- who it serves: ${o.who ?? "hobbyists"}\n- mechanism class: index`],
    ["Testable claim", `claim ${n}`],
    ["Cheapest test", `test ${n}`],
    ["Strongest failure reason", `failure ${n}`],
    ["Probability", o.probability ?? "5%"],
  ];
  const body = parts.filter(([h]) => h !== o.drop).map(([h, v]) => `## ${h}\n${v}`).join("\n\n");
  return `# Idea ${n}\n\n${body}\n`;
}

/** A batch of `count` ideas; `high` of them get a probability well above the VS threshold. */
function batch(start: number, count: number, high = 0): string {
  return Array.from({ length: count }, (_, i) => idea(start + i, { probability: i < high ? "40%" : "5%" })).join("\n");
}

function scripted(answers: readonly string[]) {
  let i = 0;
  return createMockModel({ id: "mock-island", cost: COST, handler: () => ({ content: [answers[Math.min(i++, answers.length - 1)] ?? ""], usage: USAGE }) } as never);
}

function setup(answers: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), "kiln-islands-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const cfg = defaultConfig();
  const model = scripted(answers);
  const deps = { home, run, record, cfg, models: () => ({ model: model as never, ref: "mock/mock-island" }), apiKeyFor: async () => "k", effort: "medium", streamFn: streamMock as never, limiter: new Limiter(2) } as unknown as PhaseDeps;
  return { home, run, record, cfg, deps, model };
}

function plan(model: unknown, over: Partial<IslandPlan> = {}): IslandPlan {
  return { round: 1, island: 1, model: model as never, ref: "mock/mock-island", cheap: false, lens: { id: "L1", text: "Invert a shared assumption." }, ...over };
}

const INPUTS = { brief: "# Brief\n\n## Problem\nsomething", landscape: "## Atoms\n- a\n- b", axes: AXES };

function choices(...refs: string[]) {
  return refs.map((ref) => ({ model: { id: ref } as never, ref }));
}

function modelCalls(record: RunRecord): number {
  return record.read().filter((e) => e.t === "model.call").length;
}

describe("playbookMoves", () => {
  test("reads counted bullets, dropping the counters", () => {
    expect(playbookMoves(PLAYBOOK, "lenses")).toEqual([
      { id: "L1", text: "Invert a shared assumption." },
      { id: "L2", text: "Recombine two atoms that never co-occur." },
      { id: "L3", text: "Transfer a distant domain's mechanism." },
    ]);
    expect(playbookMoves(PLAYBOOK, "ideate").map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
  });

  test("a missing section is empty, not an error", () => {
    expect(playbookMoves(PLAYBOOK, "form")).toEqual([]);
  });
});

describe("assignIslands", () => {
  const models: IslandModels = { generator: choices("a/strong", "b/strong"), cheap: choices("a/cheap", "b/cheap") };
  const cfg = defaultConfig();

  test("is deterministic: the same inputs always give the same seats and moves", () => {
    const first = assignIslands(1, cfg, PLAYBOOK, "a/strong", models);
    const second = assignIslands(1, cfg, PLAYBOOK, "a/strong", models);
    expect(second).toEqual(first);
    expect(first.map((p) => p.island)).toEqual([1, 2, 3]);
    expect(first.map((p) => p.lens?.id)).toEqual(["L1", "L2", "L3"]);
    expect(first.map((p) => p.operator)).toEqual([undefined, undefined, undefined]);
  });

  test("no island runs on the judge's model while another candidate exists", () => {
    const plans = assignIslands(1, cfg, PLAYBOOK, "a/strong", models);
    expect(plans.map((p) => p.ref)).not.toContain("a/strong");
    // The cheap slot avoids the judge too, and it is the only cheap seat.
    expect(plans.filter((p) => p.cheap)).toHaveLength(1);
    const cheapPlans = assignIslands(1, cfg, PLAYBOOK, "a/cheap", models);
    expect(cheapPlans.find((p) => p.cheap)?.ref).toBe("b/cheap");
  });

  test("falls back to the judge's model only when it is the sole candidate", () => {
    const only: IslandModels = { generator: choices("a/strong") };
    const plans = assignIslands(1, cfg, PLAYBOOK, "a/strong", only);
    expect(plans.map((p) => p.ref)).toEqual(["a/strong", "a/strong", "a/strong"]);
    expect(plans.every((p) => !p.cheap)).toBe(true);
  });

  test("rounds after the first rotate through the mutation operators without repeating one", () => {
    expect(assignIslands(2, cfg, PLAYBOOK, "a/strong", models).map((p) => p.operator?.id)).toEqual(["M1", "M2", "M3"]);
    expect(assignIslands(3, cfg, PLAYBOOK, "a/strong", models).map((p) => p.operator?.id)).toEqual(["M4", "M5", "M1"]);
    expect(assignIslands(2, cfg, PLAYBOOK, "a/strong", models).every((p) => p.lens === undefined)).toBe(true);
  });

  test("the cheap seat rotates so one island is not permanently cheap", () => {
    expect(assignIslands(1, cfg, PLAYBOOK, "x/judge", models).findIndex((p) => p.cheap)).toBe(0);
    expect(assignIslands(2, cfg, PLAYBOOK, "x/judge", models).findIndex((p) => p.cheap)).toBe(1);
    expect(assignIslands(3, cfg, PLAYBOOK, "x/judge", models).findIndex((p) => p.cheap)).toBe(2);
  });

  test("cheapIsland: false puts every island on the generator list", () => {
    const off = { ...cfg, ideation: { ...cfg.ideation, cheapIsland: false } };
    expect(assignIslands(1, off, PLAYBOOK, "x/judge", models).some((p) => p.cheap)).toBe(false);
  });

  test("no generator candidate at all is an error, not a silent empty round", () => {
    expect(() => assignIslands(1, cfg, PLAYBOOK, "x/judge", { generator: [] })).toThrow(/no generator model/);
  });

  test("every assignment is recorded once, with its model and its move", () => {
    const { record } = setup([]);
    recordIslandAssignments(record, assignIslands(2, cfg, PLAYBOOK, "a/strong", models));
    const events = record.read().filter((e) => e.t === "island.assign");
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.t === "island.assign" ? e.operator : undefined))).toEqual(["M1", "M2", "M3"]);
    expect(events.map((e) => (e.t === "island.assign" ? e.model : ""))).toEqual(["b/strong", "b/cheap", "b/strong"]);
  });
});

describe("islandContract", () => {
  test("names the seat, the one move, and the closed vocabulary", () => {
    const cfg = defaultConfig();
    const text = islandContract(plan(undefined, { round: 1, island: 2 }), INPUTS, cfg);
    expect(text).toContain("Round 1 of 3, island 2 of 3");
    expect(text).toContain("Lens L1");
    expect(text).toContain("Invert a shared assumption.");
    expect(text).toContain("- who it serves: hobbyists | teams | enterprises");
    expect(text).toContain(`exactly ${cfg.ideation.ideasPerBatch} ideas`);
  });

  test("an operator seat is labelled as one", () => {
    const p = plan(undefined, { round: 2, lens: undefined, operator: { id: "M4", text: "Swap the domain." } });
    expect(islandContract(p, INPUTS, defaultConfig())).toContain("Mutation operator M4 — apply it to every idea");
  });
});

describe("validateBatch", () => {
  test("five complete ideas with three under the threshold pass with nothing to say", () => {
    const c = validateBatch(batch(1, 5, 2), { count: 5, axes: AXES });
    expect(c.problems).toEqual([]);
    expect(c.bounded).toBe(true);
    expect(c.blocks).toHaveLength(5);
  });

  test("a short batch is unbounded and says how many it found", () => {
    const c = validateBatch(batch(1, 4, 1), { count: 5, axes: AXES });
    expect(c.bounded).toBe(false);
    expect(c.problems[0]).toContain("found 4");
  });

  test("too few low probabilities is a violation of the verbalized distribution", () => {
    const c = validateBatch(batch(1, 5, 3), { count: 5, axes: AXES });
    expect(c.bounded).toBe(false);
    expect(c.problems.join("\n")).toContain(`below ${VS_PROBABILITY_MAX}`);
  });

  test("minUnder: 0 turns the distribution rule off for the second batch", () => {
    const c = validateBatch(batch(6, 5, 5), { count: 5, minUnder: 0, axes: AXES });
    expect(c.problems).toEqual([]);
    expect(c.bounded).toBe(true);
  });

  test("a missing section and an out-of-vocabulary axis are re-ask material, not unbounded", () => {
    const md = [idea(1, { drop: "Mechanism" }), idea(2, { who: "astronauts" }), batch(3, 3, 0)].join("\n");
    const c = validateBatch(md, { count: 5, axes: AXES });
    const problems = c.problems.join("\n");
    expect(problems).toContain("idea 1 is missing: Mechanism");
    expect(problems).toContain('idea 2: axis "who it serves" value "astronauts" is not in the vocabulary');
    // The batch is the right size and honestly distributed; only its content needs fixing.
    expect(c.bounded).toBe(true);
  });

  test("axes are optional: without them only the batch's own two rules are checked", () => {
    const c = validateBatch(batch(1, 5, 2).replace("## Axes\n- who it serves: hobbyists\n- mechanism class: index", "## Axes\n- nonsense: x"), { count: 5 });
    expect(c.problems).toEqual([]);
    expect(c.bounded).toBe(true);
  });
});

describe("runIsland", () => {
  test("two batches, no re-ask: one call each, the second asked for ideas unlike the first", async () => {
    const { deps, record, model } = setup([batch(1, 5, 2), batch(6, 5, 5)]);
    const r = await runIsland(deps, plan(model), INPUTS);
    expect(r.error).toBeUndefined();
    expect(r.reasked).toBe(0);
    expect(r.batches.map((b) => b.length)).toEqual([5, 5]);
    expect(r.bounded).toEqual([true, true]);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(modelCalls(record)).toBe(2);
  });

  test("a short first batch is re-asked exactly once and the fixed batch is kept", async () => {
    const { deps, record, model } = setup([batch(1, 3, 1), batch(1, 5, 2), batch(6, 5, 0)]);
    const r = await runIsland(deps, plan(model), INPUTS);
    expect(r.reasked).toBe(1);
    expect(r.bounded).toEqual([true, true]);
    expect(r.batches[0]).toHaveLength(5);
    expect(modelCalls(record)).toBe(3);
  });

  test("a batch that is still wrong after its one re-ask is accepted as unbounded", async () => {
    const { deps, record, model } = setup([batch(1, 3, 0), batch(1, 4, 0), batch(6, 5, 0)]);
    const r = await runIsland(deps, plan(model), INPUTS);
    expect(r.reasked).toBe(1);
    expect(r.bounded[0]).toBe(false);
    expect(r.batches[0]).toHaveLength(4);
    // Exactly one re-ask: the island is never asked a third time for the same batch.
    expect(modelCalls(record)).toBe(3);
    expect(r.raw).toContain("<!-- kiln batch 1 bounded=false -->");
    expect(r.raw).toContain("<!-- kiln batch 2 bounded=true -->");
  });

  test("the re-ask quotes the problems back", async () => {
    let seen = "";
    const answers = [batch(1, 4, 0), batch(1, 5, 2), batch(6, 5, 0)];
    let i = 0;
    const model = createMockModel({
      id: "mock-island",
      cost: COST,
      handler: (ctx: unknown) => {
        const msgs = ((ctx as { messages?: { role?: string; content?: unknown }[] }).messages ?? []).filter((m) => m.role === "user");
        const last = msgs.at(-1)?.content;
        if (i === 1) seen = typeof last === "string" ? last : JSON.stringify(last);
        return { content: [answers[Math.min(i++, answers.length - 1)]!], usage: USAGE };
      },
    } as never);
    const { deps } = setup([]);
    await runIsland(deps, plan(model), INPUTS);
    expect(seen).toContain("not usable yet");
    expect(seen).toContain("found 4");
  });

  test("a model error ends the island and keeps the batches it already produced", async () => {
    let i = 0;
    const model = createMockModel({ id: "mock-island", cost: COST, handler: () => (i++ === 0
      ? { content: [batch(1, 5, 2)], usage: USAGE }
      : { throw: new Error("boom"), responseHeaders: { "x-test": "1" }, responseStatus: 503, responseRequestId: "req-island" }) } as never);
    const { deps } = setup([]);
    const r = await runIsland(deps, plan(model), INPUTS);
    expect(r.error).toBeDefined();
    expect(r.batches).toHaveLength(1);
    expect(r).toMatchObject({ stopped: "error", errorStatus: 503, errorId: "req-island" });
  });

  test("surfaces context pressure from any batch", async () => {
    const model = createMockModel({ id: "pressed-island", cost: COST, contextWindow: 100, handler: () => ({ content: [batch(1, 5, 2)], usage: { input: 80, output: 1 } }) } as never);
    const { deps } = setup([]);
    expect((await runIsland(deps, plan(model), INPUTS)).contextPressure).toBe(true);
  });

  test("the island is toolless and carries its contract in the system prompt", async () => {
    let ctxSeen: { tools?: { name: string }[]; systemPrompt?: string[] } = {};
    const model = createMockModel({
      id: "mock-island",
      cost: COST,
      handler: (ctx: unknown) => {
        ctxSeen = ctx as typeof ctxSeen;
        return { content: [batch(1, 5, 2)], usage: USAGE };
      },
    } as never);
    const { deps } = setup([]);
    await runIsland(deps, plan(model), INPUTS);
    expect(ctxSeen.tools ?? []).toEqual([]);
    expect((ctxSeen.systemPrompt ?? []).join("\n")).toContain("who it serves: hobbyists | teams | enterprises");
  });
});

describe("the raw island file", () => {
  const p = plan(undefined, { round: 2, island: 3, ref: "a/strong", lens: undefined, operator: { id: "M4", text: "Swap the domain." } });
  const raw = formatRawIsland(p, [{ text: batch(1, 5, 2), bounded: true }, { text: batch(6, 5, 0), bounded: false }]);

  test("round-trips its header and its per-batch bound", () => {
    const parsed = parseRawIsland(raw);
    expect(parsed.meta).toEqual({ round: 2, island: 3, model: "a/strong", operator: "M4" });
    expect(parsed.batches.map((b) => b.bounded)).toEqual([true, false]);
    expect(parsed.batches[0]!.text).toContain("# Idea 1");
    expect(parsed.batches[0]!.text).not.toContain("# Idea 6");
  });

  test("its markers stay out of the ideas: no block carries a kiln comment", () => {
    for (const d of deriveIdeas(raw, 2, 3, AXES)) {
      expect(d.block).not.toContain("<!-- kiln");
      expect(d.dossier.mechanism).not.toContain("kiln");
    }
  });

  test("writeRawIsland writes it atomically at the id's own path", () => {
    const { run } = setup([]);
    const path = writeRawIsland(run, 2, 3, raw);
    expect(path).toBe(rawIslandPath(run, 2, 3));
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test("a file with no markers is still readable as one unbounded batch", () => {
    const parsed = parseRawIsland(batch(1, 5, 0));
    expect(parsed.batches).toHaveLength(1);
    expect(parsed.batches[0]!.bounded).toBe(false);
    expect(deriveIdeas(batch(1, 5, 0), 1, 1, AXES)).toHaveLength(5);
  });
});

describe("deriveIdeas", () => {
  const p = plan(undefined, { round: 1, island: 2, ref: "a/strong" });
  const raw = formatRawIsland(p, [{ text: batch(1, 5, 2), bounded: true }, { text: batch(6, 5, 0), bounded: false }]);

  test("is idempotent: the same raw file always yields the same ids and the same content", () => {
    const first = deriveIdeas(raw, 1, 2, AXES);
    const second = deriveIdeas(raw, 1, 2, AXES);
    expect(second).toEqual(first);
    expect(first.map((d) => d.dossier.id)).toEqual(Array.from({ length: 10 }, (_, i) => `r1-i2-${i + 1}`));
  });

  test("survives the round trip through disk unchanged", () => {
    const { run } = setup([]);
    const path = writeRawIsland(run, 1, 2, raw);
    expect(deriveIdeas(readFileSync(path, "utf8"), 1, 2, AXES)).toEqual(deriveIdeas(raw, 1, 2, AXES));
  });

  test("carries the batch's bound and the island's move onto every idea it produced", () => {
    const ideas = deriveIdeas(raw, 1, 2, AXES);
    expect(ideas.map((d) => d.vsBound)).toEqual([true, true, true, true, true, false, false, false, false, false]);
    expect(ideas.every((d) => d.dossier.lens === "L1")).toBe(true);
    expect(ideas.every((d) => d.dossier.operator === undefined)).toBe(true);
    expect(ideas.every((d) => d.dossier.parents.length === 0)).toBe(true);
    expect(ideas[0]!.dossier.vsProbability).toBeCloseTo(0.4);
  });

  test("maps axis values onto the brief's vocabulary, drops axes it does not have, and reports the mapping", () => {
    const written = idea(1).replace("- who it serves: hobbyists", "- Who It Serves:  Hobbyists \n- vibe: loud");
    const [d] = deriveIdeas(written, 3, 1, AXES);
    expect(d!.dossier.axisValues).toEqual({ "who it serves": "hobbyists", "mechanism class": "index" });
    // §4 requires the mapping recorded; the caller can only record what derive hands it.
    expect(d!.mapped).toEqual([{ axis: "who it serves", from: "Hobbyists", to: "hobbyists" }]);
    expect(d!.unknown).toEqual([]);
  });

  test("keeps an unresolved axis value as written and reports it with the vocabulary it missed", () => {
    const [d] = deriveIdeas(idea(1, { who: "astronauts" }), 1, 1, AXES);
    expect(d!.dossier.axisValues["who it serves"]).toBe("astronauts");
    expect(d!.unknown).toEqual([{ axis: "who it serves", value: "astronauts", allowed: AXES[0]!.values }]);
    expect(d!.mapped).toEqual([]);
  });

  test("with no vocabulary at all, the island's own axis values are kept and nothing is reported", () => {
    const [d] = deriveIdeas(idea(1), 1, 1, []);
    expect(d!.dossier.axisValues).toEqual({ "who it serves": "hobbyists", "mechanism class": "index" });
    expect([d!.mapped, d!.unknown]).toEqual([[], []]);
  });

  test("a block missing a section still becomes an idea, with that field empty", () => {
    const ideas = deriveIdeas(idea(1, { drop: "Mechanism" }), 1, 1, AXES);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.dossier.mechanism).toBe("");
    expect(ideas[0]!.dossier.title).toBe("Idea 1 title");
  });
});
