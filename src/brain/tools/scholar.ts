import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { throwIfRunCancelled } from "../../core/run-control";
import { defaultIdeation } from "../../core/config";
import type { SearchStatus } from "../../core/events";
import { fail, ok, shapeResult } from "./shape";
import { requestSignal } from "./web";
import type { ToolContext } from "./index";

/**
 * OpenAlex's keyless `works` endpoint (record §5). It is the prior-art falsifier's second search
 * path: web search finds products and posts, this finds papers, which is what a `research`-shaped
 * idea usually collides with. No key, no account — the `mailto` parameter is what buys the polite
 * pool, so it is always sent.
 */
const WORKS_ENDPOINT = "https://api.openalex.org/works";
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
/** How much of an abstract reaches the model. Enough to tell a collision from a namesake. */
const ABSTRACT_CHARS = 300;

interface Source {
  display_name?: string | null;
}
interface Location {
  source?: Source | null;
  landing_page_url?: string | null;
}
interface Work {
  id?: string | null;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  primary_location?: Location | null;
  host_venue?: Source | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

/**
 * OpenAlex stores abstracts as `word -> [positions]` (an inverted index) because it may not
 * redistribute the abstract text itself. Placing each word back at its positions rebuilds it.
 */
export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index || typeof index !== "object") return undefined;
  const words: { at: number; word: string }[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const at of positions) if (typeof at === "number" && Number.isFinite(at)) words.push({ at, word });
  }
  if (words.length === 0) return undefined;
  words.sort((a, b) => a.at - b.at);
  const text = words.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? undefined : text;
}

function venueOf(w: Work): string | undefined {
  return w.primary_location?.source?.display_name ?? w.host_venue?.display_name ?? undefined;
}

/** `title (year, venue) — url`, then up to 300 characters of abstract on an indented line. */
export function formatWorks(works: Work[]): string {
  return works
    .map((w) => {
      const title = (w.display_name ?? w.title ?? "untitled").trim();
      const parts = [w.publication_year ?? undefined, venueOf(w)].filter((p) => p !== undefined && String(p).length > 0);
      const url = w.doi ?? w.primary_location?.landing_page_url ?? w.id ?? undefined;
      const head = `${title}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}${url ? ` — ${url}` : ""}`;
      const abstract = reconstructAbstract(w.abstract_inverted_index);
      return abstract === undefined ? head : `${head}\n  ${abstract.slice(0, ABSTRACT_CHARS)}`;
    })
    .join("\n");
}

/** One OpenAlex query, classified the way `web_search` classifies its own (record §5). Never throws. */
async function searchWorks(
  ctx: ToolContext,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ status: SearchStatus; works: Work[]; note?: string }> {
  if (ctx.searchLimiter) {
    return ctx.searchLimiter.run(async () => {
      const max = Math.max(0, ctx.searchJitterMs ?? 100);
      if (max > 0) await Bun.sleep(Math.floor(Math.random() * (max + 1)));
      return searchWorks({ ...ctx, searchLimiter: undefined }, query, maxResults, signal);
    });
  }
  const f = ctx.fetchImpl ?? fetch;
  const rs = requestSignal(ctx, signal);
  if (rs.aborted) return { status: "failed", works: [], note: `cancelled before the request for "${query}" started` };
  const mailto = ctx.mailto ?? defaultIdeation().mailto;
  const url = `${WORKS_ENDPOINT}?search=${encodeURIComponent(query)}&per-page=${maxResults}&mailto=${encodeURIComponent(mailto)}`;
  try {
    const res = await f(url, { headers: { "User-Agent": `kiln (mailto:${mailto})` }, signal: rs });
    if (!res.ok) {
      // Same reading as `web_search`: 403 and 429 are the service turning us away, the rest is broken.
      const status: SearchStatus = res.status === 403 || res.status === 429 ? "blocked" : "failed";
      return { status, works: [], note: `HTTP ${res.status} for "${query}"` };
    }
    const body = (await res.json()) as { results?: Work[] };
    const works = Array.isArray(body.results) ? body.results : [];
    return { status: "ok", works, note: works.length === 0 ? `no results for "${query}"` : undefined };
  } catch (e) {
    return { status: "failed", works: [], note: `${(e as Error).message} for "${query}"` };
  }
}

export function scholarSearchTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "scholar_search",
    label: "Scholar search",
    intent: "omit",
    description: "Search scholarly works on OpenAlex and return title, year, venue, url, and abstract. Use it for academic prior art.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, maxResults: { type: "number" } },
      required: ["query"],
    },
    examples: [{ caption: "Look for a paper on the mechanism", call: { query: "quality diversity archive illumination", maxResults: 5 } }],
    async execute(_id, p: { query: string; maxResults?: number }, signal?: AbortSignal) {
      const asked = Number.isFinite(p.maxResults) ? Math.trunc(p.maxResults as number) : DEFAULT_RESULTS;
      const n = Math.min(MAX_RESULTS, Math.max(1, asked));
      const r = await searchWorks(ctx, p.query, n, signal);
      throwIfRunCancelled();
      // Recorded on every path, exactly like `web_search`: search health decides whether novelty
      // rejection is still trustworthy this round.
      ctx.record.append({ t: "search.health", tool: "scholar_search", status: r.status });
      ctx.onSearchHealth?.(r.status);
      if (r.status !== "ok") return fail(`scholar search failed (${r.status}): ${r.note ?? "no detail"}`);
      return ok(shapeResult(ctx, "scholar_search", r.works.length > 0 ? formatWorks(r.works) : (r.note ?? "no results")));
    },
  };
}
