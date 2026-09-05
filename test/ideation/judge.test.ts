import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { META_REVIEW_CHAR_CAP, META_REVIEW_TOKEN_CAP, judgePair, judgePromptFor, pairUserTurn, writeCriteria, writeMetaReview, type Criteria, type JudgeDeps } from "../../src/ideation/judge";

type AnyCtx = { systemPrompt?: string[]; messages?: unknown[] };

/** The last user turn's text, flattened: what the model was actually asked. */
function lastUser(ctx: AnyCtx): string {
  const msgs = (ctx.messages ?? []) as { role?: string; content?: unknown }[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  }
  return "";
}

function systemText(ctx: AnyCtx): string {
  return (ctx.systemPrompt ?? []).join("\n");
}

const COST = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } as never;
const USAGE = { input: 1000, output: 1000 };

function setup(model: unknown) {
  const home = mkdtempSync(join(tmpdir(), "kiln-judge-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const deps: JudgeDeps = {
    home,
    run,
    record,
    cfg: defaultConfig(),
    models: () => ({ model: model as never, ref: "mock/mock-judge" }),
    apiKeyFor: async () => "key",
    streamFn: streamMock as never,
    effort: "medium",
  };
  return { home, run, record, deps };
}

function modelCalls(record: RunRecord): number {
  return record.read().filter((e) => e.t === "model.call").length;
}

const CRITERIA: Criteria = { id: "r1-abcd1234", text: "A strong idea must move the needle on retention.", round: 1, shape: "product" };

describe("judgePromptFor", () => {
  test("keeps the general rules and only the block for this run's shape", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-judge-"));
    const research = judgePromptFor(home, "research");
    const product = judgePromptFor(home, "product");
    expect(research).toContain("verdict");
    expect(research.toLowerCase()).toContain("research");
    expect(research).not.toBe(product);
    // The other shapes' definitions of value must not leak into this run's comparisons.
    const productOnly = product.split("## Value")[1] ?? "";
    expect(productOnly.toLowerCase()).not.toContain("### research");
    expect(product).toContain("never");
  });

  test("states value and feasibility only, never novelty, and ignores style", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-judge-"));
    const md = judgePromptFor(home, "product").toLowerCase();
    expect(md).toContain("novelty");
    expect(md).toContain("length");
    expect(md).toContain("criteria");
  });
});

describe("writeCriteria", () => {
  test("writes criteria/<id>.md with an id derived from the text, before any candidate is seen", async () => {
    let seen = "";
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: (ctx: unknown) => { seen = lastUser(ctx as AnyCtx); return { content: ["A strong product idea must reduce time to first value."], usage: USAGE }; } } as never);
    const { run, record, deps } = setup(model);
    const c = await writeCriteria(deps, 1, "# Brief\n\n## Success\nretention", "product");
    if (!c.ok) throw new Error("expected criteria");
    expect(c.id).toMatch(/^r1-[0-9a-f]{8}$/);
    expect(c.text).toContain("time to first value");
    expect(c.reused).toBe(false);
    expect(c.costUsd).toBeGreaterThan(0);
    expect(readFileSync(join(run.criteriaDir, `${c.id}.md`), "utf8")).toContain("time to first value");
    expect(seen).toContain("## Success");
    expect(seen.toLowerCase()).not.toContain("idea a");
    expect(modelCalls(record)).toBe(1);
  });

  test("is stored once per round: a second call reuses the file and calls no model", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: ["criteria text"], usage: USAGE }) } as never);
    const { run, record, deps } = setup(model);
    const first = await writeCriteria(deps, 2, "brief", "research");
    const second = await writeCriteria(deps, 2, "brief", "research");
    if (!first.ok || !second.ok) throw new Error("expected criteria");
    expect(second.id).toBe(first.id);
    expect(second.text).toBe(first.text);
    expect(second.reused).toBe(true);
    expect(second.costUsd).toBe(0);
    // The reused file carries the run's shape, not a hardcoded one.
    expect(second.shape).toBe("research");
    expect(modelCalls(record)).toBe(1);
    expect(readdirSync(run.criteriaDir).filter((f) => f.startsWith("r2-"))).toEqual([`${first.id}.md`]);
  });

  test("passes the previous round's meta-review and nothing else about the losers", async () => {
    let seen = "";
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: (ctx: unknown) => { seen = lastUser(ctx as AnyCtx); return { content: ["criteria"], usage: USAGE }; } } as never);
    const { deps } = setup(model);
    await writeCriteria(deps, 2, "brief", "product", "Losers over-indexed on tooling.");
    expect(seen).toContain("Losers over-indexed on tooling.");
  });

  test("an empty answer is retried once and then fails explicitly, recorded as verify", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: [""], usage: USAGE }) } as never);
    const { run, record, deps } = setup(model);
    const c = await writeCriteria(deps, 1, "brief", "product");
    // Not a blank Criteria the caller can mistake for success: the discriminant has to be narrowed
    // past, so nothing downstream can pin an empty criteria block or write `criteriaId: ""`.
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error("expected a failure");
    expect(c.failure).toBe("verify");
    expect(c.message).toContain("no criteria");
    expect(c.costUsd).toBeGreaterThan(0);
    expect(readdirSync(run.criteriaDir)).toEqual([]);
    expect(modelCalls(record)).toBe(2);
    const failures = record.read().filter((e) => e.t === "failure");
    expect(failures.length).toBe(1);
    expect(failures[0] && failures[0].t === "failure" ? failures[0].class : "").toBe("verify");
  });
});

describe("pairUserTurn", () => {
  test("presents the canonical a first in ab order and the canonical b first in ba order", () => {
    const ab = pairUserTurn("RENDER-A", "RENDER-B", "ab");
    const ba = pairUserTurn("RENDER-A", "RENDER-B", "ba");
    expect(ab.indexOf("RENDER-A")).toBeLessThan(ab.indexOf("RENDER-B"));
    expect(ba.indexOf("RENDER-B")).toBeLessThan(ba.indexOf("RENDER-A"));
    expect(ab).toContain("A");
    expect(ab).toContain("B");
  });
});

describe("judgePair", () => {
  /** A judge that always names whichever side is presented first. */
  function firstWins(): unknown {
    return createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "A", reason: "A is sharper" } }], usage: USAGE }) } as never);
  }

  test("carries the criteria in the system prompt and one verdict tool, and costs one call", async () => {
    let ctxSeen: AnyCtx = {};
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: (ctx: unknown) => { ctxSeen = ctx as AnyCtx; return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "B", feasibilityWinner: "A", reason: "B pays off more" } }], usage: USAGE }; } } as never);
    const { record, deps } = setup(model);
    const v = await judgePair(deps, CRITERIA, "RENDER-A", "RENDER-B", "ab");
    expect(v.valueWinner).toBe("b");
    expect(v.feasibilityWinner).toBe("a");
    expect(v.reason).toBe("B pays off more");
    expect(v.judgeModel).toBe("mock/mock-judge");
    expect(v.retried).toBe(false);
    expect(v.costUsd).toBeGreaterThan(0);
    expect(systemText(ctxSeen)).toContain("A strong idea must move the needle on retention.");
    // The verdict tool is the only way to answer; a judge with tools could research its way around the render.
    expect(((ctxSeen as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name)).toEqual(["verdict"]);
    expect(modelCalls(record)).toBe(1);
  });

  test("winners are canonical, not positional: the same 'A wins' flips with the order", async () => {
    const { deps: d1 } = setup(firstWins());
    const ab = await judgePair(d1, CRITERIA, "RENDER-A", "RENDER-B", "ab");
    const { deps: d2 } = setup(firstWins());
    const ba = await judgePair(d2, CRITERIA, "RENDER-A", "RENDER-B", "ba");
    expect(ab.valueWinner).toBe("a");
    expect(ba.valueWinner).toBe("b");
    expect(ab.feasibilityWinner).toBe("a");
    expect(ba.feasibilityWinner).toBe("b");
  });

  test("no verdict tool call is retried once and then recorded as a tie", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: ["I think A is better, honestly."], usage: USAGE }) } as never);
    const { record, deps } = setup(model);
    const v = await judgePair(deps, CRITERIA, "RENDER-A", "RENDER-B", "ab");
    expect(v.valueWinner).toBe("tie");
    expect(v.feasibilityWinner).toBe("tie");
    expect(v.retried).toBe(true);
    expect(v.reason).toContain("no verdict");
    expect(modelCalls(record)).toBe(2);
  });

  test("a malformed verdict is retried once and then recorded as a tie", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "C", feasibilityWinner: "", reason: "" } }], usage: USAGE }) } as never);
    const { deps } = setup(model);
    const v = await judgePair(deps, CRITERIA, "RENDER-A", "RENDER-B", "ba");
    expect(v.valueWinner).toBe("tie");
    expect(v.feasibilityWinner).toBe("tie");
    expect(v.retried).toBe(true);
  });

  test("a refusal is a category-named tie and is not retried", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, responses: [{
      stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" }, usage: USAGE,
    }] as never });
    const { record, deps } = setup(model);
    const v = await judgePair(deps, CRITERIA, "RENDER-A", "RENDER-B", "ab");
    expect(v).toMatchObject({ valueWinner: "tie", feasibilityWinner: "tie", reason: "refused:safety", retried: false });
    expect(model.calls).toHaveLength(1);
    expect(modelCalls(record)).toBe(1);
  });

  test("a verdict on the retry is kept", async () => {
    let n = 0;
    const model = createMockModel({
      id: "mock-judge",
      cost: COST,
      handler: () => {
        n += 1;
        if (n === 1) return { content: ["no tool for me"], usage: USAGE };
        return { content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "b", feasibilityWinner: "B", reason: "second time lucky" } }], usage: USAGE };
      },
    } as never);
    const { deps } = setup(model);
    const v = await judgePair(deps, CRITERIA, "RENDER-A", "RENDER-B", "ab");
    expect(v.valueWinner).toBe("b");
    expect(v.feasibilityWinner).toBe("b");
    expect(v.retried).toBe(true);
    expect(v.reason).toBe("second time lucky");
  });
});

describe("writeMetaReview", () => {
  test("sees only the losing reasons and caps its answer at 400 tokens", async () => {
    let seen = "";
    const long = `${"why they lost ".repeat(400)}end`;
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: (ctx: unknown) => { seen = lastUser(ctx as AnyCtx); return { content: [long], usage: USAGE }; } } as never);
    const { deps } = setup(model);
    const m = await writeMetaReview(deps, 1, ["too broad to test", "no cheap falsifier"], "product");
    expect(seen).toContain("too broad to test");
    expect(seen).toContain("no cheap falsifier");
    expect(seen).not.toContain("mechanism class");
    expect(seen).toContain(String(META_REVIEW_TOKEN_CAP));
    expect(m.text.length).toBeLessThanOrEqual(META_REVIEW_CHAR_CAP);
    expect(m.text.endsWith("why")).toBe(false);
    expect(m.costUsd).toBeGreaterThan(0);
  });

  test("is stored once per round and reused on resume", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: ["losers were vague"], usage: USAGE }) } as never);
    const { run, record, deps } = setup(model);
    const first = await writeMetaReview(deps, 3, ["vague"], "product");
    const second = await writeMetaReview(deps, 3, ["vague"], "product");
    expect(second.text).toBe(first.text);
    expect(second.costUsd).toBe(0);
    expect(modelCalls(record)).toBe(1);
    expect(existsSync(join(run.criteriaDir, "r3-meta.md"))).toBe(true);
  });

  test("uses the run's shape, not the product value block, in the system prompt", async () => {
    let seen = "";
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: (ctx: unknown) => { seen = systemText(ctx as AnyCtx); return { content: ["losers were vague"], usage: USAGE }; } } as never);
    const { home, deps } = setup(model);
    await writeMetaReview(deps, 4, ["vague"], "research");
    // §8 feeds this into the next round's criteria, so the wrong shape's definition of value here
    // becomes the next round's judging standard.
    expect(seen).toContain(judgePromptFor(home, "research").trim());
    expect(seen).not.toContain(judgePromptFor(home, "product").trim());
  });

  test("no losing reasons means no call and no meta-review", async () => {
    const model = createMockModel({ id: "mock-judge", cost: COST, handler: () => ({ content: ["should not run"], usage: USAGE }) } as never);
    const { record, deps } = setup(model);
    const m = await writeMetaReview(deps, 1, [], "product");
    expect(m.text).toBe("");
    expect(modelCalls(record)).toBe(0);
  });
});
