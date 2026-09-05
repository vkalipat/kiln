import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import type { Dossier } from "../../src/ideation/dossier";
import { collisionVerdict, facetQuery, priorArtTemplate, runPriorArtScout } from "../../src/ideation/priorart";
import type { PhaseDeps } from "../../src/phases/frame";

function setup(responses: unknown[] = [], fetchImpl?: typeof fetch) {
  const home = mkdtempSync(join(tmpdir(), "kiln-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const cfg = defaultConfig();
  const model = createMockModel({ id: "mock-priorart", responses: responses as never });
  const deps = {
    home,
    run,
    record,
    cfg,
    models: () => ({ model: model as never, ref: "mock/mock-priorart" }),
    apiKeyFor: async () => "k",
    effort: "low",
    streamFn: streamMock as never,
    fetchImpl,
    limiter: new Limiter(2),
  } as unknown as PhaseDeps;
  return { home, run, record, cfg, deps };
}

function dossier(over: Partial<Dossier> = {}): Dossier {
  return {
    id: "r1-i1-1",
    title: "Trigram dedup for run journals",
    mechanism: "hash trigrams and compare against an archive index",
    draws: "shingling",
    axisValues: { "who it serves": "hobbyist tinkerers" },
    testableClaim: "dedup at 10k docs in under a second",
    cheapestTest: "run it on 10k synthetic docs and time it",
    failureReason: "trigram sets blow up for very long documents",
    parents: [],
    ...over,
  };
}

/** A minimal, always-succeeding OpenAlex `/works` page for `scholar_search`. */
const OK_WORKS = JSON.stringify({ results: [{ id: "https://openalex.org/W1", display_name: "A prior paper", publication_year: 2020 }] });
const okFetch = (async () => new Response(OK_WORKS)) as unknown as typeof fetch;

function scholarCall(query = "x") {
  return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query } }] };
}
function collisionCall(args: Record<string, unknown>) {
  return { content: [{ type: "toolCall", name: "collision", arguments: args }] };
}

describe("facetQuery", () => {
  test("fills purpose (testable claim plus who it serves), mechanism, and evaluation", () => {
    const q = facetQuery(dossier(), "product");
    expect(q).toContain("Purpose: dedup at 10k docs in under a second (for hobbyist tinkerers)");
    expect(q).toContain("Mechanism: Trigram dedup for run journals: hash trigrams and compare against an archive index");
    expect(q).toContain("How it would be evaluated: run it on 10k synthetic docs and time it");
    expect(q).toContain("Idea shape: product");
  });

  test("falls back to the first axis value when there is no 'who it serves' axis", () => {
    const d = dossier({ axisValues: { "mechanism class": "index-based" } });
    expect(facetQuery(d, "research")).toContain("(for index-based)");
  });

  test("drops the parenthetical when there are no axis values at all", () => {
    const d = dossier({ axisValues: {} });
    expect(facetQuery(d, "creative")).toContain("Purpose: dedup at 10k docs in under a second\n");
  });

  test("fills a custom template's placeholders too", () => {
    const q = facetQuery(dossier(), "product", "P={purpose} M={mechanism} E={evaluation}");
    expect(q).toBe(
      "P=dedup at 10k docs in under a second (for hobbyist tinkerers) " +
        "M=Trigram dedup for run journals: hash trigrams and compare against an archive index " +
        "E=run it on 10k synthetic docs and time it",
    );
  });
});

describe("priorArtTemplate", () => {
  test("reads the '## prior art' section's Template: block from the scout prompt", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    mkdirSync(join(home, "prompts"), { recursive: true });
    writeFileSync(
      join(home, "prompts", "scout.md"),
      "# Scout\n\nSome guidance.\n\n## prior art\n\nContext for the model.\n\nTemplate:\nP: {purpose}\nM: {mechanism}\nE: {evaluation}\n",
    );
    expect(priorArtTemplate(home)).toBe("P: {purpose}\nM: {mechanism}\nE: {evaluation}");
  });

  test("falls back to the built-in template when the '## prior art' section is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    mkdirSync(join(home, "prompts"), { recursive: true });
    writeFileSync(join(home, "prompts", "scout.md"), "# Scout\n\nNo prior-art section here.\n");
    const t = priorArtTemplate(home);
    expect(t).toContain("{purpose}");
    expect(t).toContain("{mechanism}");
    expect(t).toContain("{evaluation}");
  });

  test("a home with no prompts of its own falls back to the bundled scout prompt, which carries all three facets", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const t = priorArtTemplate(home);
    expect(t).toContain("{purpose}");
    expect(t).toContain("{mechanism}");
    expect(t).toContain("{evaluation}");
    expect(t).toContain("{shape}");
  });
});

describe("collisionVerdict", () => {
  test("captures the arbiter's verdict, recorded through the arbiter role, at its own cost", async () => {
    const { deps, record } = setup([
      collisionCall({ same: true, artifactTitle: "Foo", artifactUrl: "https://example.com/foo", reason: "Same mechanism for the same users." }),
    ]);
    const v = await collisionVerdict(deps, dossier(), "some findings");
    expect(v).toMatchObject({ same: true, artifactTitle: "Foo", artifactUrl: "https://example.com/foo", reason: "Same mechanism for the same users." });
    const calls = record.read().filter((e) => e.t === "model.call" && e.role === "arbiter");
    expect(calls.length).toBe(1);
    expect(v.costUsd).toBe(calls.reduce((s, e) => s + (e.t === "model.call" ? e.costUsd : 0), 0));
  });

  test("an arbiter that never calls the tool is treated as distinct, without throwing", async () => {
    const { deps } = setup([{ content: ["I'm not sure, let me think about this some more."] }]);
    const v = await collisionVerdict(deps, dossier(), "some findings");
    expect(v.same).toBe(false);
    expect(v.reason).toContain("no verdict");
  });
});

describe("runPriorArtScout", () => {
  test("a same verdict with a URL is collided, and searchOk is true", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["Found a couple of loosely related tools."] }, collisionCall({
        same: true,
        artifactTitle: "Existing Dedup Tool",
        artifactUrl: "https://example.com/dedup",
        reason: "Identical mechanism for the same audience.",
      })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("collided");
    expect(r.artifact).toEqual({ title: "Existing Dedup Tool", url: "https://example.com/dedup" });
    expect(r.searchOk).toBe(true);
    expect(record.read().some((e) => e.t === "arbiter.verdict" && e.kind === "collision" && e.verdict === "collided" && e.id === "r1-i1-1")).toBe(true);
  });

  test("a same verdict without a URL is not_falsified, and still records an arbiter.verdict event (record §5)", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["Nothing clearly on point."] }, collisionCall({ same: true, reason: "Feels familiar but I can't name it." })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("not_falsified");
    expect(r.artifact).toBeUndefined();
    const verdicts = record.read().filter((e) => e.t === "arbiter.verdict");
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]).toMatchObject({ verdict: "same_without_artifact" });
  });

  test("a same verdict with a non-URL string is treated the same as no URL", async () => {
    const { deps } = setup(
      [scholarCall("dedup"), { content: ["Nothing on point."] }, collisionCall({ same: true, artifactTitle: "Something", artifactUrl: "not-a-real-url", reason: "vague" })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("not_falsified");
  });

  test("a distinct verdict is not_falsified and records verdict 'distinct'", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["Nothing on point."] }, collisionCall({ same: false, reason: "Different mechanism entirely." })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("not_falsified");
    expect(record.read().some((e) => e.t === "arbiter.verdict" && e.verdict === "distinct")).toBe(true);
  });

  test("a scout that never searches yields search_failed, and the arbiter is never called", async () => {
    const { deps, record } = setup([{ content: ["I couldn't find anything; giving up without searching."] }]);
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("search_failed");
    expect(r.searchOk).toBe(false);
    expect(record.read().some((e) => e.t === "arbiter.verdict")).toBe(false);
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "arbiter").length).toBe(0);
  });

  test("a search tool that fails outright also yields search_failed", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["The search backend errored out; I have nothing reliable."] }],
      (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("search_failed");
    expect(record.read().some((e) => e.t === "search.health" && e.status === "failed")).toBe(true);
  });

  test("a turn-capped scout stays search_failed even when one search succeeded", async () => {
    const base = setup([], okFetch);
    const looping = createMockModel({ id: "looping-priorart", handler: () => scholarCall("again") } as never);
    base.deps.models = () => ({ model: looping as never, ref: "mock/looping-priorart" });
    base.cfg.ideation.scoutTurnCap = 2;
    const r = await runPriorArtScout(base.deps, dossier(), { shape: "product", arbiter: false });
    expect(r.status).toBe("search_failed");
    expect(r.searchOk).toBe(false);
    expect(base.record.read().some((e) => e.t === "search.health" && e.status === "ok")).toBe(true);
  });

  test("opts.arbiter: false skips the collision call and reports not_falsified", async () => {
    const { deps, record } = setup([scholarCall("dedup"), { content: ["Found some maybe-related tools."] }], okFetch);
    const r = await runPriorArtScout(deps, dossier(), { shape: "product", arbiter: false });
    expect(r.status).toBe("not_falsified");
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "arbiter").length).toBe(0);
  });
});
