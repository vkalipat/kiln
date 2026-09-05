import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { scoutTools, type ToolContext } from "../../src/brain/tools";
import { scholarSearchTool } from "../../src/brain/tools/scholar";

/** A two-work OpenAlex `/works` page, trimmed to the fields the tool reads. */
const OPENALEX = {
  meta: { count: 2, db_response_time_ms: 14, page: 1, per_page: 2 },
  results: [
    {
      id: "https://openalex.org/W2741809807",
      doi: "https://doi.org/10.7717/peerj.4375",
      title: "The state of OA",
      display_name: "The state of OA",
      publication_year: 2018,
      primary_location: { source: { display_name: "PeerJ" }, landing_page_url: "https://peerj.com/articles/4375" },
      abstract_inverted_index: { Despite: [0], growing: [1], interest: [2], in: [3, 7], "open": [4], access: [5], "(OA)": [6], scholarship: [8] },
    },
    {
      id: "https://openalex.org/W123",
      doi: null,
      display_name: "An untitled venue work",
      publication_year: null,
      primary_location: { source: null, landing_page_url: null },
      abstract_inverted_index: null,
    },
  ],
};

function setup(extra: Partial<ToolContext> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const urls: string[] = [];
  const respond = extra.fetchImpl;
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    urls.push(String(url));
    return respond ? await (respond as (u: unknown, i?: unknown) => Promise<Response>)(url, init) : new Response(JSON.stringify(OPENALEX));
  }) as unknown as typeof fetch;
  const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record, ...extra, fetchImpl };
  const tool = scholarSearchTool(ctx);
  const call = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const r = await tool.execute("id", args as never, signal as never);
    return { text: (r.content[0] as { text: string }).text, isError: r.isError === true };
  };
  return { ctx, record, urls, call, tool };
}

describe("scholar_search", () => {
  test("is one of the scout's tools", () => {
    const { ctx } = setup();
    expect(scoutTools(ctx).map((t) => t.name)).toContain("scholar_search");
  });

  test("has the harness tool shape", () => {
    const { tool } = setup();
    expect(tool.name).toBe("scholar_search");
    expect(tool.description.length).toBeLessThan(300);
    expect(tool.examples?.length).toBe(1);
  });

  test("parses a fixture OpenAlex response into title, year, venue and url lines", async () => {
    const { call } = setup();
    const r = await call({ query: "open access" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("The state of OA (2018, PeerJ) — https://doi.org/10.7717/peerj.4375");
    // Second work: no doi, no venue, no year — the landing page and the openalex id are the fallbacks.
    expect(r.text).toContain("An untitled venue work — https://openalex.org/W123");
  });

  test("reconstructs the abstract from abstract_inverted_index in position order", async () => {
    const { call } = setup();
    const r = await call({ query: "open access" });
    expect(r.text).toContain("Despite growing interest in open access (OA) in scholarship");
  });

  test("caps the abstract at 300 characters", async () => {
    const long: Record<string, number[]> = {};
    for (let i = 0; i < 200; i += 1) long[`word${i}`] = [i];
    const page = { results: [{ id: "https://openalex.org/W9", display_name: "Long", publication_year: 2020, abstract_inverted_index: long }] };
    const { call } = setup({ fetchImpl: (async () => new Response(JSON.stringify(page))) as unknown as typeof fetch });
    const r = await call({ query: "x" });
    const abstract = r.text.split("\n")[1]!.trim();
    expect(abstract.length).toBeLessThanOrEqual(300);
    expect(abstract.startsWith("word0 word1 word2")).toBe(true);
  });

  test("asks OpenAlex for the query, the page size and the polite-pool mailto", async () => {
    const { call, urls } = setup({ mailto: "someone@example.org" });
    await call({ query: "run journal jsonl", maxResults: 3 });
    expect(urls[0]).toStartWith("https://api.openalex.org/works?");
    expect(urls[0]).toContain(`search=${encodeURIComponent("run journal jsonl")}`);
    expect(urls[0]).toContain("per-page=3");
    expect(urls[0]).toContain(`mailto=${encodeURIComponent("someone@example.org")}`);
  });

  test("falls back to the config default mailto and to five results", async () => {
    const { call, urls } = setup();
    await call({ query: "x" });
    expect(urls[0]).toContain("per-page=5");
    expect(urls[0]).toContain(`mailto=${encodeURIComponent("kiln@example.invalid")}`);
  });

  test("clamps maxResults to ten and to at least one", async () => {
    const { call, urls } = setup();
    await call({ query: "x", maxResults: 50 });
    await call({ query: "x", maxResults: 0 });
    expect(urls[0]).toContain("per-page=10");
    expect(urls[1]).toContain("per-page=1");
  });

  test("records ok search health and says so when the search simply found nothing", async () => {
    const { call, record } = setup({ fetchImpl: (async () => new Response(JSON.stringify({ results: [] }))) as unknown as typeof fetch });
    const r = await call({ query: "nothing at all" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("no results");
    expect(record.read().some((e) => e.t === "search.health" && e.tool === "scholar_search" && e.status === "ok")).toBe(true);
  });

  test("an HTTP error is a failed search with its own search health event", async () => {
    const { call, record } = setup({ fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch });
    const r = await call({ query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scholar search failed (failed)");
    expect(record.read().some((e) => e.t === "search.health" && e.tool === "scholar_search" && e.status === "failed")).toBe(true);
  });

  test("a rate limit is a blocked search, not a failed one", async () => {
    const { call, record } = setup({ fetchImpl: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch });
    const r = await call({ query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scholar search failed (blocked)");
    expect(record.read().some((e) => e.t === "search.health" && e.tool === "scholar_search" && e.status === "blocked")).toBe(true);
  });

  test("a network error and unparseable json both fail rather than throw", async () => {
    const boom = setup({ fetchImpl: (async () => { throw new Error("econnreset"); }) as unknown as typeof fetch });
    const r = await boom.call({ query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scholar search failed (failed)");
    expect(r.text).toContain("econnreset");
    const junk = setup({ fetchImpl: (async () => new Response("<html>not json</html>")) as unknown as typeof fetch });
    const r2 = await junk.call({ query: "x" });
    expect(r2.isError).toBe(true);
    expect(r2.text).toContain("scholar search failed (failed)");
    expect(junk.record.read().filter((e) => e.t === "search.health" && e.status === "failed").length).toBe(1);
  });

  test("honors its own deadline and a caller signal that is already aborted", async () => {
    const hang = (async (_u: unknown, init?: { signal?: AbortSignal }) =>
      await new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const slow = setup({ fetchImpl: hang, webTimeoutMs: 50 });
    expect((await slow.call({ query: "x" })).isError).toBe(true);
    const pre = setup({ fetchImpl: hang, webTimeoutMs: 30_000 });
    const r = await pre.call({ query: "x" }, AbortSignal.abort());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scholar search failed (failed)");
  });
});
