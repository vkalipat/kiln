import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webFetchTool, webSearch, webSearchTool, type SearchOutcome } from "../../src/brain/tools/web";
import type { ToolContext } from "../../src/brain/tools";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";

function context(extra: Partial<ToolContext> = {}): ToolContext {
  const home = mkdtempSync(join(tmpdir(), "kiln-web-hardening-"));
  const run = createRun(home, "web hardening");
  const cwd = mkdtempSync(join(tmpdir(), "kiln-web-cwd-"));
  return { cwd, roots: [cwd, run.dir], run, record: new RunRecord(run.record), ...extra };
}

async function fetchCall(ctx: ToolContext, args: { url: string; maxChars?: number }) {
  const result = await webFetchTool(ctx).execute("id", args as never, undefined as never);
  return {
    isError: result.isError === true,
    text: result.content.map((part) => ("text" in part ? part.text : "")).join("\n"),
  };
}

function bingFeed(items = 1): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing: query</title>${Array.from(
    { length: items },
    (_, i) => `<item><title>Result ${i + 1}</title><link>https://example.com/${i + 1}</link><description>Evidence ${i + 1}</description></item>`,
  ).join("")}</channel></rss>`;
}

describe("web retrieval hardening", () => {
  test("falls back once from blocked DuckDuckGo to Bing RSS with per-engine provenance", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return url.includes("duckduckgo.com")
        ? new Response("blocked", { status: 403 })
        : new Response(bingFeed(2), { headers: { "content-type": "application/rss+xml" } });
    }) as unknown as typeof fetch;

    const outcome = await webSearch(context({ fetchImpl, searchJitterMs: 0 }), "kiln", 1);

    expect(outcome.status).toBe("ok");
    expect(outcome.results).toEqual([
      { title: "Result 1", url: "https://example.com/1", snippet: "Evidence 1", engine: "bing-rss" },
    ]);
    expect(outcome.attempts.map(({ engine, status }) => ({ engine, status }))).toEqual([
      { engine: "duckduckgo-html", status: "blocked" },
      { engine: "bing-rss", status: "ok" },
    ]);
    expect(outcome.note).toContain("duckduckgo-html: blocked");
    expect(outcome.note).toContain("bing-rss: ok");
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get("format")).toBe("rss");
    expect(new URL(urls[1]!).searchParams.get("q")).toBe("kiln");
  });

  test("a parser miss is failed rather than falsely reported as no results", async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("duckduckgo.com")
        ? new Response("<html><body>redesigned markup with unknown result selectors</body></html>")
        : new Response("<html><body>not an RSS feed</body></html>")) as unknown as typeof fetch;

    const outcome = await webSearch(context({ fetchImpl, searchJitterMs: 0 }), "x", 5);

    expect(outcome.status).toBe("failed");
    expect(outcome.results).toEqual([]);
    expect(outcome.note).toContain("could not recognize");
    expect(outcome.note).not.toContain("no results for");
    expect(outcome.attempts).toHaveLength(2);
  });

  test("an empty HTTP 200 search response falls back instead of claiming no results", async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("duckduckgo.com") ? new Response("") : new Response(bingFeed())) as unknown as typeof fetch;

    const outcome = await webSearch(context({ fetchImpl, searchJitterMs: 0 }), "x", 5);

    expect(outcome.status).toBe("ok");
    expect(outcome.results[0]?.engine).toBe("bing-rss");
    expect(outcome.attempts[0]).toMatchObject({ engine: "duckduckgo-html", status: "failed", note: "empty HTTP 200 response" });
  });

  test("a successful fallback records one healthy logical-query signal", async () => {
    const health: string[] = [];
    const ctx = context({
      fetchImpl: (async (input: string | URL | Request) =>
        String(input).includes("duckduckgo.com")
          ? new Response("blocked", { status: 429 })
          : new Response(bingFeed())) as unknown as typeof fetch,
      onSearchHealth: (status) => health.push(status),
      searchJitterMs: 0,
    });

    const result = await webSearchTool(ctx).execute("id", { query: "x" } as never, undefined as never);

    expect(result.isError).not.toBe(true);
    expect(health).toEqual(["ok"]);
    expect(ctx.record.read().filter((event) => event.t === "search.health").map(({ t, tool, status }) => ({ t, tool, status }))).toEqual([
      { t: "search.health", tool: "web_search", status: "ok" },
    ]);
  });

  test("a verified DuckDuckGo no-results page does not trigger the fallback", async () => {
    let requests = 0;
    const outcome = await webSearch(context({
      fetchImpl: (async () => {
        requests += 1;
        return new Response("<html><body>No results found for that query.</body></html>");
      }) as unknown as typeof fetch,
      searchJitterMs: 0,
    }), "nothing", 5);

    expect(outcome.status).toBe("ok");
    expect(outcome.results).toEqual([]);
    expect(outcome.note).toContain("explicit no-results response");
    expect(requests).toBe(1);
  });

  test("the fallback is bounded to two attempts even when both engines fail", async () => {
    let requests = 0;
    const outcome: SearchOutcome = await webSearch(context({
      fetchImpl: (async () => {
        requests += 1;
        return new Response("busy", { status: 503 });
      }) as unknown as typeof fetch,
      searchJitterMs: 0,
    }), "x", 5);

    expect(outcome.status).toBe("failed");
    expect(outcome.attempts).toHaveLength(2);
    expect(requests).toBe(2);
  });

  test("web_fetch shares the search limiter across concurrent requests", async () => {
    let active = 0;
    let high = 0;
    const ctx = context({
      searchLimiter: new Limiter(2),
      searchJitterMs: 0,
      fetchImpl: (async () => {
        active += 1;
        high = Math.max(high, active);
        await Bun.sleep(10);
        active -= 1;
        return new Response("<html><body>source text</body></html>");
      }) as unknown as typeof fetch,
    });

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => fetchCall(ctx, { url: `https://example.com/${i}` })));

    expect(results.every((result) => !result.isError)).toBe(true);
    expect(high).toBe(2);
  });

  test("web_fetch rejects non-HTTP schemes and invalid maxChars before dispatch", async () => {
    let requests = 0;
    const ctx = context({
      fetchImpl: (async () => {
        requests += 1;
        return new Response("should not run");
      }) as unknown as typeof fetch,
    });

    for (const url of ["file:///etc/passwd", "data:text/plain,secret", "javascript:alert(1)", "not a url"]) {
      const result = await fetchCall(ctx, { url });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("http:// or https://");
    }
    for (const maxChars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await fetchCall(ctx, { url: "https://example.com", maxChars });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("positive finite number");
    }
    expect(requests).toBe(0);
  });

  test("web_fetch rejects empty and precise challenge pages but permits ordinary captcha discussion", async () => {
    const bodies = [
      "   ",
      "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>",
      "<html><body><form id=\"challenge-form\">Security challenge</form></body></html>",
      "<article><h1>Why CAPTCHA accessibility matters</h1><p>This article discusses captcha design.</p></article>",
    ];
    const ctx = context({ fetchImpl: (async () => new Response(bodies.shift())) as unknown as typeof fetch });

    expect((await fetchCall(ctx, { url: "https://example.com/empty" })).isError).toBe(true);
    expect((await fetchCall(ctx, { url: "https://example.com/title-challenge" })).isError).toBe(true);
    expect((await fetchCall(ctx, { url: "https://example.com/form-challenge" })).isError).toBe(true);
    const article = await fetchCall(ctx, { url: "https://example.com/article" });
    expect(article.isError).toBe(false);
    expect(article.text).toContain("CAPTCHA accessibility matters");
  });

  test("web_fetch bounds streamed response reads before shaping visible text", async () => {
    let cancelled = false;
    let pulls = 0;
    const chunk = new TextEncoder().encode(`<p>${"x".repeat(8_000)}</p>`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const ctx = context({ fetchImpl: (async () => new Response(body)) as unknown as typeof fetch });

    const result = await fetchCall(ctx, { url: "https://example.com/large", maxChars: 100 });

    expect(result.isError).toBe(false);
    expect(result.text).toHaveLength(100);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
  });
});
