import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { throwIfRunCancelled } from "../../core/run-control";
import type { SearchStatus } from "../../core/events";
import { fail, ok, shapeResult } from "./shape";
import type { ToolContext } from "./index";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DEFAULT_RESULTS = 8;
const MAX_FETCH_CHARS = 12_000;
const DEFAULT_WEB_TIMEOUT_MS = 30_000;

/**
 * One signal that fires on either the agent's cancellation or this tool's own deadline, so a
 * hung server cannot hold a turn open and an aborted phase does not leave a request in flight.
 */
export function requestSignal(ctx: ToolContext, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ctx.webTimeoutMs ?? DEFAULT_WEB_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function decodeEntities(s: string): string {
  // &amp; last, so a decoded ampersand cannot start a second round of decoding.
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Tags become spaces so `<h1>Hi</h1><p>there</p>` reads as two words, not one. */
function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * DuckDuckGo hands back `//duckduckgo.com/l/?uddg=<encoded target>&rut=…` rather
 * than the target itself. Decode `uddg` exactly once; direct hrefs pass through.
 */
function unwrapRedirect(href: string): string {
  const m = /\/l\/\?(?:[^"]*&)?uddg=([^&]+)/.exec(href);
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return href;
  }
}

/** An anti-bot interstitial rather than a result page: HTTP 200 with a challenge and no results. */
const BLOCKED_MARKERS = /captcha|are you a robot|unusual traffic|anomaly|challenge-form|access denied|rate ?limit/i;

/** One search result line, already unwrapped and de-entitied. */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * A search's outcome as a fact rather than a guess (record §5): `ok` with zero hits means the web
 * really has nothing, `blocked` means the engine refused to answer, and `failed` means the request
 * never completed. Novelty enforcement depends on telling those apart.
 */
export interface SearchOutcome {
  status: SearchStatus;
  results: SearchHit[];
  note?: string;
}

/** Parses a DuckDuckGo HTML result page into hits. Exported for the prior-art scout's own use. */
export function parseSearchHtml(html: string): SearchHit[] {
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    url: unwrapRedirect(decodeEntities(m[1]!)),
    title: plainText(m[2]!),
  }));
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => plainText(m[1]!));
  return links.map((l, i) => ({ ...l, snippet: snippets[i] }));
}

/** Runs one DuckDuckGo search and classifies what came back. Never throws. */
export async function webSearch(ctx: ToolContext, query: string, maxResults: number, signal?: AbortSignal): Promise<SearchOutcome> {
  if (ctx.searchLimiter) {
    return ctx.searchLimiter.run(async () => {
      const max = Math.max(0, ctx.searchJitterMs ?? 100);
      if (max > 0) await Bun.sleep(Math.floor(Math.random() * (max + 1)));
      return webSearch({ ...ctx, searchLimiter: undefined }, query, maxResults, signal);
    });
  }
  const f = ctx.fetchImpl ?? fetch;
  const rs = requestSignal(ctx, signal);
  if (rs.aborted) return { status: "failed", results: [], note: `cancelled before the request for "${query}" started` };
  let html: string;
  try {
    const res = await f(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: rs,
    });
    if (!res.ok) {
      // 403 and 429 are the engine turning us away; everything else is a broken request.
      const status: SearchStatus = res.status === 403 || res.status === 429 ? "blocked" : "failed";
      return { status, results: [], note: `HTTP ${res.status} for "${query}"` };
    }
    html = await res.text();
  } catch (e) {
    return { status: "failed", results: [], note: `${(e as Error).message} for "${query}"` };
  }
  const results = parseSearchHtml(html).slice(0, maxResults);
  if (results.length === 0 && BLOCKED_MARKERS.test(html)) {
    return { status: "blocked", results: [], note: `the engine returned a challenge page for "${query}"` };
  }
  return { status: "ok", results, note: results.length === 0 ? `no results for "${query}"` : undefined };
}

export function formatHits(hits: SearchHit[]): string {
  return hits.map((h) => `${h.title} — ${h.url}${h.snippet ? `\n  ${h.snippet}` : ""}`).join("\n");
}

export function webSearchTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "web_search",
    label: "Web search",
    intent: "omit",
    description: "Search the web and return titles, urls, and snippets. Use it to find sources, prior art, and current facts.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, maxResults: { type: "number" } },
      required: ["query"],
    },
    examples: [{ caption: "Look for prior art", call: { query: "open source run journal jsonl", maxResults: 5 } }],
    async execute(_id, p: { query: string; maxResults?: number }, signal?: AbortSignal) {
      const r = await webSearch(ctx, p.query, p.maxResults ?? DEFAULT_RESULTS, signal);
      throwIfRunCancelled();
      // Recorded on every path: the share of healthy searches is what decides whether novelty
      // rejection is still trustworthy this round.
      ctx.record.append({ t: "search.health", tool: "web_search", status: r.status });
      ctx.onSearchHealth?.(r.status);
      if (r.status !== "ok") return fail(`search failed (${r.status}): ${r.note ?? "no detail"}`);
      return ok(shapeResult(ctx, "web_search", r.results.length > 0 ? formatHits(r.results) : (r.note ?? "no results")));
    },
  };
}

export function webFetchTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "web_fetch",
    label: "Web fetch",
    intent: "omit",
    description: "Fetch a url and return its visible text with scripts, styles, and markup removed.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, maxChars: { type: "number" } },
      required: ["url"],
    },
    examples: [{ caption: "Read a docs page", call: { url: "https://example.com/docs", maxChars: 4000 } }],
    async execute(_id, p: { url: string; maxChars?: number }, signal?: AbortSignal) {
      const f = ctx.fetchImpl ?? fetch;
      let html: string;
      const rs = requestSignal(ctx, signal);
      if (rs.aborted) return fail(`web_fetch failed for ${p.url}: cancelled before the request started`);
      try {
        const res = await f(p.url, { headers: { "User-Agent": USER_AGENT }, signal: rs });
        if (!res.ok) return fail(`web_fetch got HTTP ${res.status} for ${p.url}`);
        html = await res.text();
      } catch (e) {
        throwIfRunCancelled();
        return fail(`web_fetch failed for ${p.url}: ${(e as Error).message}`);
      }
      throwIfRunCancelled();
      const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
      const text = plainText(body).slice(0, Math.min(p.maxChars ?? MAX_FETCH_CHARS, MAX_FETCH_CHARS));
      return ok(shapeResult(ctx, "web_fetch", text.length > 0 ? text : "no text content"));
    },
  };
}
