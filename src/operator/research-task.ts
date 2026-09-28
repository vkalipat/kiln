import { constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { webFetchTool, webSearch } from "../brain/tools/web";
import type { ToolContext } from "../brain/tools";

export type ResearchCoverage = "supports" | "contradicts" | "mixed" | "not_stated" | "unknown";
export interface ResearchTaskInput {
  question: string;
  requiredFields: { id: string; question: string }[];
  sources: string[];
  allowedHosts: string[];
  searchQueries?: string[];
  maxSources?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxCaptureChars?: number;
  maxInlineChars?: number;
}
export interface ResearchCapture { text: string; finalUrl?: string; truncated?: boolean; costUsd?: number }
export interface ResearchPassage { id: string; sourceId: string; start: number; end: number; text: string }
export interface ResearchClassification {
  sourceId: string; fieldId: string; coverage: ResearchCoverage; passageIds: string[];
}
export interface ResearchTaskDeps {
  artifactDir: string;
  toolContext?: ToolContext;
  signal?: AbortSignal;
  fetchSource?: (url: string, signal: AbortSignal) => Promise<ResearchCapture>;
  search?: (query: string, signal: AbortSignal) => Promise<{ urls: string[]; status: string; costUsd?: number }>;
  browser?: (url: string, signal: AbortSignal) => Promise<ResearchCapture>;
  classify?: (input: { question: string; fields: ResearchTaskInput["requiredFields"]; passages: ResearchPassage[] }, signal: AbortSignal) => Promise<{ labels: ResearchClassification[]; costUsd?: number }>;
}
export interface ResearchSource {
  id: string; url: string; finalUrl: string; retrievedAt: string;
  artifact: { path: string; sha256: string; chars: number };
  captureExtent: "bounded_visible_text"; truncated: boolean | "unknown";
  method: "fetch" | "browser"; excerpt: string;
  integrity: "verified" | "changed";
}
export interface ResearchReceipt {
  schema: "kiln-research-task-v1"; status: "collected" | "partial" | "cancelled";
  untrusted: true; truthVerified: false; question: string;
  sources: ResearchSource[];
  fields: { id: string; question: string; status: "labeled" | "unknown"; evidence: (ResearchClassification & { locations: { passageId: string; path: string; sha256: string; start: number; end: number }[] })[] }[];
  failures: { stage: "search" | "fetch" | "browser" | "classify"; sourceId?: string; reason: string }[];
  unknowns: string[];
  cost: { knownUsd: number; unknownCalls: number; complete: boolean };
  calls: { search: number; fetch: number; browser: number; classify: number };
  manifest: { path: string; sha256: string };
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const coverages = new Set(["supports", "contradicts", "mixed", "not_stated", "unknown"]);
function bounded(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`Invalid research ${name}`);
}
function integer(value: number | undefined, fallback: number, max: number) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1 || actual > max) throw new Error("Invalid research bound");
  return actual;
}
function publicHost(host: string) {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes(".")
    && !/^\d+(?:\.\d+){3}$/.test(host) && !/(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host);
}
/** HTTPS and an exact operator-provided host allowlist, excluding literal local addresses.
 * This is not a DNS/rebinding sandbox; only operator-approved hosts belong in the allowlist. */
function sourceUrl(raw: string, hosts: Set<string>) {
  bounded(raw, "URL", 2048);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid research URL"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !publicHost(url.hostname) || !hosts.has(url.hostname)) throw new Error("Research URL is outside allowed public HTTPS hosts");
  url.hash = "";
  return url.href;
}
function passagesFor(sourceId: string, text: string): ResearchPassage[] {
  const passages: ResearchPassage[] = [];
  for (let start = 0; start < text.length; start += 1000) {
    const end = Math.min(text.length, start + 1000);
    passages.push({ id: `${sourceId}-p${passages.length + 1}`, sourceId, start, end, text: text.slice(start, end) });
  }
  return passages;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Research cancelled");
  let listener: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { listener = () => reject(new Error("Research cancelled")); signal.addEventListener("abort", listener, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
  finally { signal.removeEventListener("abort", listener); }
}

/** Collect evidence, not answers. No model synthesis, automatic retention, or truth verification. */
export async function runResearchTask(input: ResearchTaskInput, deps: ResearchTaskDeps): Promise<ResearchReceipt> {
  bounded(input.question, "question", 4096);
  if (!Array.isArray(input.requiredFields) || input.requiredFields.length < 1 || input.requiredFields.length > 12) throw new Error("Invalid research fields");
  const fieldIds = new Set<string>();
  for (const field of input.requiredFields) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(field.id) || fieldIds.has(field.id)) throw new Error("Invalid research field ID");
    bounded(field.question, "field question", 1024); fieldIds.add(field.id);
  }
  if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length < 1 || input.allowedHosts.length > 16 || input.allowedHosts.some(h => typeof h !== "string" || !publicHost(h))) throw new Error("Invalid research allowed hosts");
  const hosts = new Set(input.allowedHosts);
  if (!Array.isArray(input.sources) || input.sources.length > 12) throw new Error("Invalid research sources");
  const urls = [...new Set(input.sources.map(url => sourceUrl(url, hosts)))];
  const queries = input.searchQueries ?? [];
  if (!Array.isArray(queries) || queries.length > 3) throw new Error("Invalid research search queries");
  queries.forEach(query => bounded(query, "search query", 1024));
  if (!urls.length && !queries.length) throw new Error("Research needs sources or search queries");
  const maxSources = integer(input.maxSources, 6, 12);
  const concurrency = integer(input.concurrency, 3, 4);
  const timeoutMs = integer(input.timeoutMs, 30000, 120000);
  const maxCaptureChars = integer(input.maxCaptureChars, 12000, 12000);
  const maxInlineChars = integer(input.maxInlineChars, 1800, 6000);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  deps.signal?.addEventListener("abort", cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  const signal = controller.signal;
  const sources: ResearchSource[] = [];
  const failures: ResearchReceipt["failures"] = [];
  const unknowns: string[] = [];
  const cost = { knownUsd: 0, unknownCalls: 0, complete: false };
  const calls = { search: 0, fetch: 0, browser: 0, classify: 0 };
  const captures = new Map<string, string>();
  const account = (value?: number) => { if (typeof value === "number" && Number.isFinite(value) && value >= 0) cost.knownUsd += value; else cost.unknownCalls++; };
  let directory: string;
  try {
    mkdirSync(deps.artifactDir, { recursive: true });
    directory = mkdtempSync(join(realpathSync(deps.artifactDir), "research-"));
  } catch { clearTimeout(timer); deps.signal?.removeEventListener("abort", cancel); throw new Error("Research artifact directory unavailable"); }
  const save = (name: string, text: string) => {
    const path = join(directory, name);
    writeFileSync(path, text, { flag: "wx", mode: 0o444 });
    return { path, sha256: hash(text) };
  };
  const guardedFetch: typeof fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = sourceUrl(request instanceof Request ? request.url : String(request), hosts);
    const signals = [signal, ...(init?.signal ? [init.signal] : []), ...(request instanceof Request ? [request.signal] : [])];
    return (deps.toolContext?.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
  }) as typeof fetch;
  const defaultFetch = async (url: string): Promise<ResearchCapture> => {
    if (!deps.toolContext) throw new Error("No fetch adapter");
    const tool = webFetchTool({ ...deps.toolContext, fetchImpl: guardedFetch });
    const result = await tool.execute("research-task", { url, maxChars: maxCaptureChars }, signal);
    if (result.isError) throw new Error("Source fetch unavailable");
    const text = result.content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
    return { text, finalUrl: url };
  };
  const defaultSearch = async (query: string) => {
    if (!deps.toolContext) throw new Error("No search adapter");
    // Search endpoints are owned by the existing search implementation, not source-host filtering.
    const result = await webSearch(deps.toolContext, query, maxSources, signal);
    return { urls: result.results.map(hit => hit.url), status: result.status };
  };
  let labels: ResearchClassification[] = [];
  try {
    for (const query of queries) {
      if (signal.aborted || urls.length >= maxSources) break;
      calls.search++;
      let charged = false;
      try {
        const result = await abortable(() => (deps.search ?? defaultSearch)(query, signal), signal);
        account(result.costUsd); charged = true;
        if (result.status !== "ok") failures.push({ stage: "search", reason: "Search did not complete successfully; coverage unknown" });
        if (!Array.isArray(result.urls) || result.urls.length > 100) throw new Error("Invalid search result");
        for (const raw of result.urls) {
          try { const url = sourceUrl(raw, hosts); if (!urls.includes(url)) urls.push(url); } catch { /* Outside the explicit source scope. */ }
          if (urls.length >= maxSources) break;
        }
      } catch { if (!charged) account(); failures.push({ stage: "search", reason: signal.aborted ? "Cancelled or deadline exceeded" : "Search unavailable or invalid" }); }
    }
    if (urls.length > maxSources) unknowns.push("Some explicit sources exceed the source budget; they were not fetched.");
    const selected = urls.slice(0, maxSources);
    let cursor = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const index = cursor++;
        const url = selected[index]; if (!url) return;
        const id = `source-${index + 1}`;
        let capture: ResearchCapture | undefined;
        let method: "fetch" | "browser" = "fetch";
        calls.fetch++;
        try { capture = await abortable(() => (deps.fetchSource ?? defaultFetch)(url, signal), signal); account(capture.costUsd); }
        catch { account(); failures.push({ stage: "fetch", sourceId: id, reason: signal.aborted ? "Cancelled or deadline exceeded" : "Source fetch unavailable" }); }
        if (!capture && deps.browser && !signal.aborted) {
          method = "browser"; calls.browser++;
          try { capture = await abortable(() => deps.browser!(url, signal), signal); account(capture.costUsd); }
          catch { account(); failures.push({ stage: "browser", sourceId: id, reason: signal.aborted ? "Cancelled or deadline exceeded" : "Browser capture unavailable" }); }
        }
        if (!capture || signal.aborted) continue;
        try {
          bounded(capture.text, "captured text", 256000);
          const finalUrl = sourceUrl(capture.finalUrl ?? url, hosts);
          const text = capture.text.slice(0, maxCaptureChars);
          // Preserve every character the adapter captured, even when only a prefix fits classification.
          const artifact = save(`${id}.txt`, capture.text);
          captures.set(id, text);
          sources.push({ id, url, finalUrl, retrievedAt: new Date().toISOString(), artifact: { ...artifact, chars: capture.text.length },
            captureExtent: "bounded_visible_text", truncated: capture.text.length > text.length ? true : capture.truncated ?? "unknown", method, excerpt: "", integrity: "verified" });
        } catch { failures.push({ stage: method, sourceId: id, reason: "Invalid source capture or artifact write failure" }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
    sources.sort((a, b) => Number(a.id.slice(7)) - Number(b.id.slice(7)));
    const passages = sources.flatMap(source => passagesFor(source.id, captures.get(source.id)!));
    if (deps.classify && passages.length && !signal.aborted) {
      calls.classify++;
      let charged = false;
      try {
        const result = await abortable(() => deps.classify!({ question: input.question, fields: input.requiredFields, passages }, signal), signal);
        account(result.costUsd); charged = true;
        if (!Array.isArray(result.labels) || result.labels.length > sources.length * fieldIds.size) throw new Error("Invalid labels");
        const seen = new Set<string>();
        for (const label of result.labels) {
          const key = `${label.sourceId}/${label.fieldId}`;
          if (!captures.has(label.sourceId) || !fieldIds.has(label.fieldId) || !coverages.has(label.coverage) || seen.has(key)
            || !Array.isArray(label.passageIds) || label.passageIds.length > 12 || new Set(label.passageIds).size !== label.passageIds.length
            || label.passageIds.some(id => !passages.some(p => p.id === id && p.sourceId === label.sourceId))
            || (["supports", "contradicts", "mixed"].includes(label.coverage) && !label.passageIds.length)) throw new Error("Invalid label provenance");
          seen.add(key);
        }
        labels = result.labels;
      } catch { if (!charged) account(); failures.push({ stage: "classify", reason: "Labels unavailable or invalid; all captured evidence retained" }); }
    }
    for (const source of sources) {
      try {
        const stat = lstatSync(source.artifact.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024000 || hash(readFileSync(source.artifact.path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW })) !== source.artifact.sha256) throw new Error("Source changed");
      } catch {
        source.integrity = "changed";
        labels = labels.filter(label => label.sourceId !== source.id);
        failures.push({ stage: "classify", sourceId: source.id, reason: "Captured artifact changed or became unavailable; evidence must be reacquired" });
      }
    }
    const fields: ResearchReceipt["fields"] = input.requiredFields.map(field => {
      const evidence = sources.map(source => {
        const label = labels.find(item => item.sourceId === source.id && item.fieldId === field.id) ?? { sourceId: source.id, fieldId: field.id, coverage: "unknown" as const, passageIds: [] };
        return { ...label, locations: label.passageIds.map(id => { const p = passages.find(p => p.id === id)!; return { passageId: id, path: source.artifact.path, sha256: source.artifact.sha256, start: p.start, end: p.end }; }) };
      });
      const incomplete = sources.length < selected.length || urls.length > maxSources || failures.some(f => f.stage === "search")
        || sources.some(source => source.integrity !== "verified" || source.truncated !== false);
      return { ...field, status: evidence.length && !incomplete && evidence.every(e => e.coverage !== "unknown") ? "labeled" : "unknown", evidence };
    });
    for (const field of fields) if (field.status === "unknown") unknowns.push(`Evidence for ${field.id} remains unassessed or incomplete.`);
    if (!sources.length) unknowns.push("No source content captured; absence is not negative evidence.");
    if (sources.some(source => source.truncated !== false)) unknowns.push("Some captures are bounded or have unknown completeness; missing text is not negative evidence.");
    if (signal.aborted) unknowns.push("Collection cancelled or deadline exceeded; unfinished work remains unknown.");
    let remaining = maxInlineChars;
    for (const source of sources) { const cap = Math.min(600, Math.floor(maxInlineChars / sources.length), remaining); source.excerpt = captures.get(source.id)!.slice(0, cap); remaining -= source.excerpt.length; }
    cost.complete = cost.unknownCalls === 0;
    const body = { schema: "kiln-research-task-v1" as const, status: signal.aborted ? "cancelled" as const : failures.length || sources.length < selected.length ? "partial" as const : "collected" as const,
      untrusted: true as const, truthVerified: false as const, question: input.question, sources, fields, failures, unknowns, cost, calls };
    const manifest = save("manifest.json", JSON.stringify({ ...body, requiredFields: input.requiredFields, requestedSources: input.sources, searchQueries: queries, allowedHosts: input.allowedHosts }, null, 2) + "\n");
    return { ...body, manifest };
  } finally { clearTimeout(timer); deps.signal?.removeEventListener("abort", cancel); controller.abort(); }
}
