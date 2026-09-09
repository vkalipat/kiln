import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { throwIfRunCancelled } from "../../core/run-control";
import type { SearchStatus } from "../../core/events";
import { fail, ok, shapeResult } from "./shape";
import type { ToolContext } from "./index";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_FETCH_CHARS = 12_000;
const MAX_FETCH_BODY_BYTES = 256_000;
const MAX_SEARCH_BODY_BYTES = 512_000;
const DEFAULT_WEB_TIMEOUT_MS = 30_000;

export type SearchEngine = "duckduckgo-html" | "bing-rss";

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

/**
 * Recognise interstitials narrowly. A normal article may discuss CAPTCHAs, traffic, rate limits,
 * or access denial; those words alone are not evidence that the fetched page is a challenge.
 */
function isChallengePage(html: string): boolean {
  const title = plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  if (/^(?:just a moment(?:\.{3})?|security challenge|attention required!?|access denied)$/i.test(title)) return true;
  if (/(?:id|class)\s*=\s*["'][^"']*(?:challenge-form|cf-chl-widget|px-captcha|anomaly-modal)[^"']*["']/i.test(html)) return true;
  const visible = plainText(html);
  return /^(?:(?:please\s+)?(?:solve|complete)\s+(?:this\s+|the\s+)?captcha(?:\s+challenge)?\s+to\s+continue|(?:please\s+)?verify\s+you\s+are\s+(?:a\s+)?human|are\s+you\s+a\s+robot)\??[.!]?$/i.test(visible);
}

function explicitNoResults(engine: SearchEngine, text: string): boolean {
  if (engine === "duckduckgo-html") return /\bno results found for\b|\bno more results\b/i.test(plainText(text));
  return /<rss\b[^>]*>[\s\S]*<channel\b[^>]*>[\s\S]*<\/channel>[\s\S]*<\/rss>/i.test(text) && !/<item\b/i.test(text);
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

/** Read at most `maxBytes`; cancelling the reader prevents an unbounded body from draining. */
async function readTextBounded(response: Response, maxBytes: number): Promise<BoundedText> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    const remaining = maxBytes - bytes;
    const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
    bytes += accepted.byteLength;
    text += decoder.decode(accepted, { stream: true });
    if (accepted.byteLength < value.byteLength || bytes >= maxBytes) {
      void reader.cancel("Kiln response body limit reached");
      return { text: text + decoder.decode(), truncated: true };
    }
  }
  void reader.cancel("Kiln response body limit reached");
  return { text: text + decoder.decode(), truncated: true };
}

/** One search result line, already unwrapped and de-entitied. */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  /** Backend that returned this hit; parser-only callers may omit it. */
  engine?: SearchEngine;
}

export interface SearchAttempt {
  engine: SearchEngine;
  status: SearchStatus;
  note: string;
}

/**
 * A search's outcome as a fact rather than a guess (record §5): `ok` with zero hits means the web
 * really has nothing, `blocked` means the engine refused to answer, and `failed` means the request
 * never completed. Novelty enforcement depends on telling those apart.
 */
export interface SearchOutcome {
  status: SearchStatus;
  results: SearchHit[];
  attempts: SearchAttempt[];
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

function parseBingRss(xml: string): SearchHit[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
    const item = match[1]!;
    const value = (tag: string) => {
      const raw = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(item)?.[1];
      if (raw === undefined) return undefined;
      return plainText(raw.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1"));
    };
    const title = value("title");
    const url = value("link");
    if (!title || !url || !/^https?:\/\//i.test(url)) return [];
    return [{ title, url, snippet: value("description") }];
  });
}

interface EngineOutcome {
  attempt: SearchAttempt;
  results: SearchHit[];
}

function engineUrl(engine: SearchEngine, query: string): string {
  const url = new URL(engine === "duckduckgo-html" ? "https://html.duckduckgo.com/html/" : "https://www.bing.com/search");
  url.searchParams.set("q", query);
  if (engine === "bing-rss") url.searchParams.set("format", "rss");
  return url.toString();
}

async function searchEngine(ctx: ToolContext, engine: SearchEngine, query: string, maxResults: number, signal: AbortSignal): Promise<EngineOutcome> {
  const failed = (status: SearchStatus, note: string): EngineOutcome => ({ attempt: { engine, status, note }, results: [] });
  if (signal.aborted) return failed("failed", "cancelled before request dispatch");
  try {
    const response = await (ctx.fetchImpl ?? fetch)(engineUrl(engine, query), {
      headers: { "User-Agent": USER_AGENT, Accept: engine === "bing-rss" ? "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" : "text/html" },
      signal,
    });
    if (!response.ok) {
      const status: SearchStatus = response.status === 403 || response.status === 429 ? "blocked" : "failed";
      return failed(status, `HTTP ${response.status}`);
    }
    const body = await readTextBounded(response, MAX_SEARCH_BODY_BYTES);
    if (body.text.trim().length === 0) return failed("failed", "empty HTTP 200 response");
    if (isChallengePage(body.text)) return failed("blocked", "HTTP 200 security challenge");
    const parsed = engine === "duckduckgo-html" ? parseSearchHtml(body.text) : parseBingRss(body.text);
    const results = parsed.slice(0, maxResults).map((hit) => ({ ...hit, engine }));
    if (results.length > 0) {
      return { attempt: { engine, status: "ok", note: `${results.length} result${results.length === 1 ? "" : "s"}${body.truncated ? " from a bounded response" : ""}` }, results };
    }
    if (explicitNoResults(engine, body.text)) return failed("ok", "explicit no-results response: no results");
    return failed("failed", `${body.truncated ? "bounded response ended before " : ""}the parser could not recognize a result or explicit no-results response`);
  } catch (error) {
    return failed("failed", (error as Error).message);
  }
}

function searchNote(attempts: readonly SearchAttempt[]): string {
  return attempts.map((attempt) => `${attempt.engine}: ${attempt.status} (${attempt.note})`).join("; ");
}

/** Runs a bounded DuckDuckGo search with one Bing RSS fallback. Never throws. */
export async function webSearch(ctx: ToolContext, query: string, maxResults: number, signal?: AbortSignal): Promise<SearchOutcome> {
  if (ctx.searchLimiter) {
    return ctx.searchLimiter.run(async () => {
      const max = Math.max(0, ctx.searchJitterMs ?? 100);
      if (max > 0) await Bun.sleep(Math.floor(Math.random() * (max + 1)));
      return webSearch({ ...ctx, searchLimiter: undefined }, query, maxResults, signal);
    });
  }
  const rs = requestSignal(ctx, signal);
  const limit = Number.isFinite(maxResults) ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(maxResults))) : DEFAULT_RESULTS;
  if (rs.aborted) {
    const attempt: SearchAttempt = { engine: "duckduckgo-html", status: "failed", note: "cancelled before request dispatch" };
    return { status: "failed", results: [], attempts: [attempt], note: searchNote([attempt]) };
  }
  const first = await searchEngine(ctx, "duckduckgo-html", query, limit, rs);
  const attempts = [first.attempt];
  if (first.attempt.status === "ok") return { status: "ok", results: first.results, attempts, note: searchNote(attempts) };

  const fallback = await searchEngine(ctx, "bing-rss", query, limit, rs);
  attempts.push(fallback.attempt);
  return { status: fallback.attempt.status, results: fallback.results, attempts, note: searchNote(attempts) };
}

export function formatHits(hits: SearchHit[]): string {
  return hits.map((h) => `${h.title} — ${h.url}${h.engine ? ` [via ${h.engine}]` : ""}${h.snippet ? `\n  ${h.snippet}` : ""}`).join("\n");
}

export function webSearchTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "web_search",
    label: "Web search",
    intent: "omit",
    description: "Search the web and return titles, urls, and snippets. Use it to find sources, prior art, and current facts.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, maxResults: { type: "number", minimum: 1, maximum: MAX_RESULTS } },
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
      const result = r.results.length > 0 ? `${r.note ? `[search provenance: ${r.note}]\n` : ""}${formatHits(r.results)}` : (r.note ?? "no results");
      return ok(shapeResult(ctx, "web_search", result));
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
      properties: { url: { type: "string" }, maxChars: { type: "number", minimum: 1, maximum: MAX_FETCH_CHARS } },
      required: ["url"],
    },
    examples: [{ caption: "Read a docs page", call: { url: "https://example.com/docs", maxChars: 4000 } }],
    async execute(_id, p: { url: string; maxChars?: number }, signal?: AbortSignal) {
      let parsed: URL;
      try { parsed = new URL(p.url); } catch { return fail(`web_fetch requires an absolute http:// or https:// URL`); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail(`web_fetch requires an absolute http:// or https:// URL`);
      if (p.maxChars !== undefined && (!Number.isFinite(p.maxChars) || p.maxChars <= 0)) return fail(`web_fetch maxChars must be a positive finite number`);
      const maxChars = p.maxChars === undefined ? MAX_FETCH_CHARS : Math.min(MAX_FETCH_CHARS, Math.max(1, Math.floor(p.maxChars)));
      const perform = async () => {
        const rs = requestSignal(ctx, signal);
        if (rs.aborted) return fail(`web_fetch failed for ${p.url}: cancelled before the request started`);
        try {
          const response = await (ctx.fetchImpl ?? fetch)(parsed, { headers: { "User-Agent": USER_AGENT }, signal: rs });
          if (!response.ok) return fail(`web_fetch got HTTP ${response.status} for ${p.url}`);
          const body = await readTextBounded(response, MAX_FETCH_BODY_BYTES);
          if (body.text.trim().length === 0) return fail(`web_fetch returned no content for ${p.url}`);
          if (isChallengePage(body.text)) return fail(`web_fetch received a security challenge instead of source content for ${p.url}`);
          const visible = body.text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
          const text = plainText(visible).slice(0, maxChars);
          if (text.length === 0) return fail(`web_fetch returned no visible text for ${p.url}`);
          return ok(shapeResult(ctx, "web_fetch", text));
        } catch (e) {
          throwIfRunCancelled();
          return fail(`web_fetch failed for ${p.url}: ${(e as Error).message}`);
        }
      };
      if (!ctx.searchLimiter) return perform();
      return ctx.searchLimiter.run(async () => {
        const max = Math.max(0, ctx.searchJitterMs ?? 100);
        if (max > 0) await Bun.sleep(Math.floor(Math.random() * (max + 1)));
        return perform();
      });
    },
  };
}
