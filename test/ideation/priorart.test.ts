import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import type { Dossier } from "../../src/ideation/dossier";
import { collisionVerdict, facetQuery, priorArtTemplate, runPriorArtScout, priorArtCacheDir, retirePriorArtCheckpoint } from "../../src/ideation/priorart";
import { hashInput } from "../../src/core/record";
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
  test("missing fields, invalid boolean values, and empty reasons fail closed within two turns", async () => {
    for (const fields of [
      { same: false, reason: "Unassessed coverage" },
      { coverageAdequate: "unassessed", same: false, reason: "Not an adequate or inadequate decision" },
      { coverageAdequate: true, same: false, reason: "   " },
    ]) {
      const invalid = collisionCall(fields); const { deps, record } = setup([invalid, invalid]);
      expect(await collisionVerdict(deps, dossier(), "Retrieved findings.")).toMatchObject({ conclusive: false, coverageAdequate: false });
      expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(2);
    }
  });

  test("standard schema normalization preserves an explicit affirmative coverage field", async () => {
    const { deps } = setup([collisionCall({ coverageAdequate: "true", same: false, reason: "The relevant retrieved paper establishes a different mechanism." })]);
    expect(await collisionVerdict(deps, dossier(), "Relevant retrieved paper.")).toMatchObject({ coverageAdequate: true, conclusive: true, same: false });
  });
  test("insufficient relevance coverage is inconclusive even when a feed parsed successfully", async () => {
    const { deps, record } = setup([collisionCall({ coverageAdequate: false, same: false, reason: "The RSS results were unrelated to the mechanism; no relevant source was retrieved." })]);
    const verdict = await collisionVerdict(deps, dossier(), "The engine returned unrelated pages; the question remains unanswered.");
    expect(verdict).toMatchObject({ same: false, conclusive: false });
    expect(verdict.reason).toContain("unrelated");
    expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(1);
  });

  test("missing coverage is rejected and a corrected decision fits the existing two-turn limit", async () => {
    const { deps, record } = setup([
      collisionCall({ same: false, reason: "Different mechanism." }),
      collisionCall({ coverageAdequate: true, same: false, reason: "The relevant retrieved paper uses a different mechanism for this purpose." }),
    ]);
    const verdict = await collisionVerdict(deps, dossier(), "Relevant retrieved paper.");
    expect(verdict).toMatchObject({ conclusive: true, reason: "The relevant retrieved paper uses a different mechanism for this purpose." });
    expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(2);
  });

  test("contradictory coverage decisions never become conclusive", async () => {
    const invalid = collisionCall({ coverageAdequate: false, same: true, artifactUrl: "https://example.test/item", reason: "No relevant source was retrieved." });
    const { deps, record } = setup([invalid, invalid]);
    expect(await collisionVerdict(deps, dossier(), "Unrelated results.")).toMatchObject({ conclusive: false });
    expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(2);
  });
  test("captures the arbiter's verdict, recorded through the arbiter role, at its own cost", async () => {
    const { deps, record } = setup([
      collisionCall({ coverageAdequate: true, same: true, artifactTitle: "Foo", artifactUrl: "https://example.com/foo", reason: "Same mechanism for the same users." }),
    ]);
    const v = await collisionVerdict(deps, dossier(), "some findings");
    expect(v).toMatchObject({ same: true, artifactTitle: "Foo", artifactUrl: "https://example.com/foo", reason: "Same mechanism for the same users." });
    const calls = record.read().filter((e) => e.t === "model.call" && e.role === "arbiter");
    expect(calls.length).toBe(1);
    expect(v.costUsd).toBe(calls.reduce((s, e) => s + (e.t === "model.call" ? e.costUsd : 0), 0));
  });

  test("an arbiter that never calls the tool is inconclusive, not distinct", async () => {
    const { deps } = setup([{ content: ["I'm not sure, let me think about this some more."] }]);
    const v = await collisionVerdict(deps, dossier(), "some findings");
    expect(v.same).toBe(false);
    expect(v.conclusive).toBe(false);
    expect(v.reason).toContain("no verdict");
  });
});

describe("runPriorArtScout", () => {
  test.each(["dossier", "prompt", "provider", "effort", "config"])("checkpoint invalidates when %s context changes", async (change) => {
    const base = setup([scholarCall(), { content: ["first report"] }, scholarCall(), { content: ["second report"] }], okFetch);
    if (change === "effort") {
      (base.deps.models("scout").model as unknown as { thinking: unknown }).thinking = { efforts: ["low", "high"] };
      base.cfg.effortByRole = { ...base.cfg.effortByRole, scout: "low" };
    }
    let idea = dossier();
    await runPriorArtScout(base.deps, idea, { shape: "product", arbiter: false });
    if (change === "dossier") idea = dossier({ cheapestTest: "changed oracle" });
    if (change === "prompt") { mkdirSync(join(base.home, "prompts")); writeFileSync(join(base.home, "prompts", "kernel.md"), "Changed governing context"); }
    if (change === "provider") { const resolve = base.deps.models; base.deps.models = (role) => ({ ...resolve(role), ref: "other/scout" }); }
    if (change === "effort") base.cfg.effortByRole = { ...base.cfg.effortByRole, scout: "high" };
    if (change === "config") base.cfg.provider.batchNudge = !base.cfg.provider.batchNudge;
    const second = await runPriorArtScout(base.deps, idea, { shape: "product", arbiter: false });
    expect(second.findings).toBe("second report");
    expect(base.record.read().filter((e) => e.t === "model.call")).toHaveLength(4);
  });

  test("private packet rejects altered bytes even with a recomputed signature, and retirement prevents replay", async () => {
    const base = setup([scholarCall(), { content: ["original"] }, scholarCall(), { content: ["replacement"] }, scholarCall(), { content: ["after retirement"] }], okFetch);
    await runPriorArtScout(base.deps, dossier(), { shape: "product", arbiter: false });
    const path = join(priorArtCacheDir(base.run), `${dossier().id}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const { signature: _old, ...packet } = JSON.parse(readFileSync(path, "utf8"));
    expect(packet.scout.turns).toBe(2);
    packet.scout.findings = "forged";
    writeFileSync(path, JSON.stringify({ ...packet, signature: hashInput(packet) }));
    expect((await runPriorArtScout(base.deps, dossier(), { shape: "product", arbiter: false })).findings).toBe("replacement");
    retirePriorArtCheckpoint(base.deps, dossier().id);
    expect((await runPriorArtScout(base.deps, dossier(), { shape: "product", arbiter: false })).findings).toBe("after retirement");
  });

  test("redirected checkpoint directory is rejected before model dispatch", async () => {
    const base = setup([], okFetch);
    const outside = mkdtempSync(join(tmpdir(), "kiln-checkpoint-outside-"));
    symlinkSync(outside, priorArtCacheDir(base.run));
    await expect(runPriorArtScout(base.deps, dossier(), { shape: "product", arbiter: false })).rejects.toThrow("redirected");
    expect(base.record.read().filter((e) => e.t === "model.call")).toHaveLength(0);
    await expect(runPriorArtScout(base.deps, dossier({ id: "../outside" }), { shape: "product", arbiter: false })).rejects.toThrow("invalid prior-art");
  });

  test("completed retrieval survives a handoff interruption without paying for the scout again", async () => {
    const { deps, record, cfg } = setup([scholarCall("owned"), { content: ["Exact report tail: https://openalex.org/W1 ; uncertainty remains."] }], okFetch);
    const first = await runPriorArtScout(deps, dossier(), { shape: "product", arbiter: false });
    const calls = record.read().filter((e) => e.t === "model.call").length;
    cfg.budgets.usd += 100;
    cfg.budgets.wallSeconds += 100;
    const resumed = await runPriorArtScout(deps, dossier(), { shape: "product", arbiter: false });
    expect(resumed.findings).toBe(first.findings);
    expect(resumed.observedUrls).toEqual(first.observedUrls);
    expect(resumed.searchOk).toBe(true);
    expect(resumed.costUsd).toBe(0);
    expect(record.read().filter((e) => e.t === "model.call")).toHaveLength(calls);
  });

  test.each([false, true])("only a valid inadequate review retires completed research (valid: %s)", async (valid) => {
    const reviews = valid ? [collisionCall({ coverageAdequate: false, same: false, reason: "Relevant evidence missing" })]
      : [{ content: ["review unavailable"] }];
    const base = setup([scholarCall(), { content: ["held findings"] }, ...reviews, scholarCall(), { content: ["improved findings"] }], okFetch);
    const result = await runPriorArtScout(base.deps, dossier(), { shape: "product" });
    expect(result.status).toBe("search_failed");
    const before = base.record.read().filter((e) => e.t === "model.call" && e.role === "scout").length;
    const again = await runPriorArtScout(base.deps, dossier(), { shape: "product", arbiter: false });
    expect(again.findings).toBe(valid ? "improved findings" : "held findings");
    expect(base.record.read().filter((e) => e.t === "model.call" && e.role === "scout")).toHaveLength(before + (valid ? 2 : 0));
  });
  test("a primary fetch after a blocked search can support an explicit adequate review", async () => {
    const url = "https://example.test/primary";
    const { deps } = setup([
      scholarCall("blocked"),
      { content: [{ type: "toolCall", name: "web_fetch", arguments: { url } }] },
      { content: ["The primary documentation was retrieved and describes a different mechanism; broad search was blocked."] },
      collisionCall({ coverageAdequate: true, same: false, reason: "The retrieved primary source is relevant and describes a different mechanism; this is a bounded comparison, not proof of absence." }),
    ], (async (input: string | URL | Request) => String(input) === url ? new Response("Relevant primary documentation") : new Response("blocked", { status: 403 })) as unknown as typeof fetch);
    const result = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(result).toMatchObject({ status: "not_falsified", searchOk: true, observedUrls: [url] });
  });
  test("a successful direct source without a self-link can reach coverage review", async () => {
    const url = "https://example.test/primary-documentation";
    const { deps } = setup([
      { content: [{ type: "toolCall", name: "web_fetch", arguments: { url } }] },
      { content: ["The retrieved documentation describes the same mechanism and users."] },
      collisionCall({ coverageAdequate: true, same: true, artifactUrl: url, reason: "The retrieved primary documentation describes this mechanism for the same purpose." }),
    ], (async () => new Response("Primary documentation describes the mechanism. No self-link here.")) as unknown as typeof fetch);
    const result = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(result).toMatchObject({ status: "collided", searchOk: true });
    expect(result.observedUrls).toEqual([url]);
  });

  test("an unsuccessful direct fetch never supplies an observed URL or reaches review", async () => {
    const url = "https://example.test/blocked";
    const { deps, record } = setup([
      { content: [{ type: "toolCall", name: "web_fetch", arguments: { url } }] },
      { content: [`Could not retrieve ${url}.`] },
    ], (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch);
    const result = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(result).toMatchObject({ status: "search_failed", searchOk: false, observedUrls: [] });
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "arbiter")).toHaveLength(0);
  });

  test("concurrent scouts cannot borrow each other's successfully retrieved URLs", async () => {
    let ready = 0; let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const base = setup([], (async (input: string | URL | Request) => {
      const id = new URL(String(input)).searchParams.get("search");
      if (++ready === 2) release(); await together;
      return new Response(JSON.stringify({ results: [{ id: `https://openalex.org/${id}`, display_name: `Paper ${id}`, publication_year: 2020 }] }));
    }) as unknown as typeof fetch);
    const depsFor = (id: string): PhaseDeps => {
      const model = createMockModel({ id, responses: [scholarCall(id), { delayMs: 10, content: [`Finding for ${id}; model-only https://example.test/invented`] }] as never });
      return { ...base.deps, models: () => ({ model: model as never, ref: `mock/${id}` }) };
    };
    const [a, b] = await Promise.all([
      runPriorArtScout(depsFor("A"), dossier({ id: "A" }), { shape: "product", arbiter: false }),
      runPriorArtScout(depsFor("B"), dossier({ id: "B" }), { shape: "product", arbiter: false }),
    ]);
    expect(a.observedUrls).toEqual(["https://openalex.org/A"]);
    expect(b.observedUrls).toEqual(["https://openalex.org/B"]);
  });
  test("a same verdict with a URL is collided, and searchOk is true", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["Existing Dedup Tool: https://openalex.org/W1"] }, collisionCall({
        coverageAdequate: true,
        same: true,
        artifactTitle: "Existing Dedup Tool",
        artifactUrl: "https://openalex.org/W1",
        reason: "Identical mechanism for the same audience.",
      })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("collided");
    expect(r.artifact).toEqual({ title: "Existing Dedup Tool", url: "https://openalex.org/W1" });
    expect(r.searchOk).toBe(true);
    expect(record.read().some((e) => e.t === "arbiter.verdict" && e.kind === "collision" && e.verdict === "collided" && e.id === "r1-i1-1")).toBe(true);
  });

  test("a same verdict without a URL is invalid and leaves coverage unresolved", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["Nothing clearly on point."] }, collisionCall({ coverageAdequate: true, same: true, reason: "Feels familiar but I can't name it." })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("search_failed");
    expect(r.artifact).toBeUndefined();
    const verdicts = record.read().filter((e) => e.t === "arbiter.verdict");
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]).toMatchObject({ verdict: "inconclusive" });
  });

  test("a same verdict with a non-URL string is treated the same as no URL", async () => {
    const { deps } = setup(
      [scholarCall("dedup"), { content: ["Nothing on point."] }, collisionCall({ coverageAdequate: true, same: true, artifactTitle: "Something", artifactUrl: "not-a-real-url", reason: "vague" })],
      okFetch,
    );
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r.status).toBe("search_failed");
  });

  test("a malformed or retrieval-unseen URL cannot reject an idea as collided", async () => {
    for (const artifactUrl of ["https://", "https://example.com/invented"]) {
      const { deps, record } = setup(
        [scholarCall("dedup"), { content: ["Only https://openalex.org/W1 was found."] }, collisionCall({ coverageAdequate: true, same: true, artifactUrl, reason: "claimed same" })],
        okFetch,
      );
      const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
      expect(r.status).toBe("search_failed");
      expect(record.read().some((e) => e.t === "arbiter.verdict" && e.verdict === "collided")).toBe(false);
    }
  });

  test("an arbiter refusal after a healthy search leaves novelty unknown", async () => {
    const { deps, record } = setup([
      scholarCall("dedup"),
      { content: ["Existing item: https://openalex.org/W1"] },
      { stopReason: "error", errorMessage: "request refused", stopDetails: { type: "refusal", category: "safety" } },
    ], okFetch);
    const r = await runPriorArtScout(deps, dossier(), { shape: "product" });
    expect(r).toMatchObject({ status: "search_failed", searchOk: false });
    expect(record.read().some((e) => e.t === "arbiter.verdict" && e.verdict === "distinct")).toBe(false);
  });

  test("partial successful retrieval can reach review but deferred coverage remains unknown", async () => {
    let calls = 0;
    const fetchImpl = (async () => ++calls === 1 ? new Response(OK_WORKS) : new Response("down", { status: 503 })) as unknown as typeof fetch;
    const { deps } = setup([scholarCall("first"), scholarCall("second"), { content: ["Partial results only."] }], fetchImpl);
    const r = await runPriorArtScout(deps, dossier(), { shape: "product", arbiter: false });
    expect(r).toMatchObject({ status: "search_failed", searchOk: true });
  });

  test("a distinct verdict is not_falsified and records verdict 'distinct'", async () => {
    const { deps, record } = setup(
      [scholarCall("dedup"), { content: ["A relevant retrieved paper uses a different mechanism."] }, collisionCall({ coverageAdequate: true, same: false, reason: "Different mechanism entirely." })],
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

  test("opts.arbiter: false skips review and leaves coverage unassessed", async () => {
    const { deps, record } = setup([scholarCall("dedup"), { content: ["Found some maybe-related tools."] }], okFetch);
    const r = await runPriorArtScout(deps, dossier(), { shape: "product", arbiter: false });
    expect(r).toMatchObject({ status: "search_failed", searchOk: true });
    expect(r.distance).toContain("not been assessed");
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "arbiter").length).toBe(0);
  });
});
