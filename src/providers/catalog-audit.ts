import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getBundledModels, getBundledProviders, type GeneratedProvider, type Model } from "@oh-my-pi/pi-catalog";
import { isKilnToolModelSupported } from "./models";

export const UPSTREAM_CATALOG_URL = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/models.json";
const LIMIT = 32 * 1024 * 1024;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
// APIs implemented by the pinned pi-ai streamSimple dispatcher. Unknown future APIs fail closed.
const APIS = new Set(["anthropic-messages", "bedrock-converse-stream", "openrouter", "openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses", "google-generative-ai", "google-gemini-cli", "google-vertex", "ollama-chat", "cursor-agent", "gitlab-duo-agent", "devin-agent"]);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
export interface CatalogFinding { ref: string; change: "added" | "changed" | "removed" | "unchanged"; compatibility: "metadata_checks_passed" | "blocked"; runtimeAdmission: "bundled_only" | "not_runtime_admitted"; findings: string[] }
export function installedCatalog(): { models: Row[]; version: string; sha256: string } {
  const models = getBundledProviders().flatMap(p => getBundledModels(p as GeneratedProvider)) as unknown as Row[];
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@oh-my-pi/pi-catalog")), "utf8")).version as string;
  return { models, version, sha256: digest(JSON.stringify(models)) };
}
export function parseCatalog(bytes: string): Row[] {
  if (Buffer.byteLength(bytes) > LIMIT) throw new Error("Catalog exceeds 32 MiB limit");
  const value: unknown = JSON.parse(bytes);
  if (!object(value)) throw new Error("Catalog must be a provider/model object");
  const result: Row[] = [];
  for (const [provider, rows] of Object.entries(value)) {
    if (!object(rows)) throw new Error("Invalid provider catalog");
    for (const [id, row] of Object.entries(rows)) {
      if (!object(row) || row.id !== id || row.provider !== provider || !id || !provider || /[\x00-\x1f]/.test(id + provider)) throw new Error("Catalog model identity mismatch");
      result.push(row); if (result.length > 30_000) throw new Error("Catalog exceeds model count limit");
    }
  }
  if (!result.length) throw new Error("Empty upstream catalog cannot establish freshness");
  return result;
}
function compatibility(row: Row): string[] {
  const problems: string[] = [];
  if (!APIS.has(String(row.api))) problems.push("unsupported_api");
  if (!isKilnToolModelSupported(row as unknown as Model)) problems.push("unsupported_tool_contract");
  // The native catalog defaults omitted supportsTools to true. Match runtime admission.
  if (row.supportsTools !== undefined && typeof row.supportsTools !== "boolean") problems.push("invalid_tool_support");
  if (row.toolMode !== undefined && !["code_mode_only", "function"].includes(String(row.toolMode))) problems.push("unreviewed_tool_mode");
  const rates = (value: unknown) => object(value) && ["input", "output", "cacheRead", "cacheWrite"].every(k => typeof value[k] === "number" && Number.isFinite(value[k]) && (value[k] as number) >= 0);
  if (!rates(row.cost)) problems.push("invalid_or_missing_cost");
  if (object(row.cost) && row.cost.longContext !== undefined) {
    const tier = row.cost.longContext;
    if (!rates(tier) || !object(tier) || typeof tier.inputThreshold !== "number" || !Number.isFinite(tier.inputThreshold) || tier.inputThreshold < 0) problems.push("invalid_long_context_cost");
  }
  if (![row.contextWindow, row.maxTokens].every(v => typeof v === "number" && Number.isSafeInteger(v) && v > 0)) problems.push("invalid_token_limits");
  if (row.thinking !== undefined) {
    if (!object(row.thinking)) problems.push("invalid_thinking_metadata");
    else if (row.thinking.mode !== undefined && !["effort", "anthropic-adaptive", "budget", "anthropic-budget-effort", "google-level"].includes(String(row.thinking.mode))) problems.push("unsupported_thinking_mode");
    if (object(row.thinking) && row.thinking.efforts !== undefined && (!Array.isArray(row.thinking.efforts) || row.thinking.efforts.some(e => !EFFORTS.has(String(e))))) problems.push("unsupported_effort");
  }
  return problems;
}
const identity = (row: Row) => `${row.provider}/${row.id}`;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
export function auditCatalog(installed: Row[], candidate: Row[]): CatalogFinding[] {
  const old = new Map(installed.map(m => [identity(m), m])), next = new Map(candidate.map(m => [identity(m), m]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().map(ref => {
    const row = next.get(ref), previous = old.get(ref);
    const findings = row ? compatibility(row) : ["removed_from_upstream_snapshot"];
    const change = !row ? "removed" : !previous ? "added" : JSON.stringify(stable(row)) === JSON.stringify(stable(previous)) ? "unchanged" : "changed";
    return { ref, change, compatibility: findings.length ? "blocked" : "metadata_checks_passed", runtimeAdmission: previous ? "bundled_only" : "not_runtime_admitted", findings };
  });
}
export async function fetchUpstreamCatalog(fetchImpl: typeof fetch = fetch): Promise<{ models: Row[]; sha256: string; checkedAt: string }> {
  const response = await fetchImpl(UPSTREAM_CATALOG_URL, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Upstream catalog HTTP ${response.status}`);
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing upstream catalog body");
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > LIMIT) throw new Error("Catalog exceeds 32 MiB limit"); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks).toString("utf8");
  return { models: parseCatalog(bytes), sha256: digest(bytes), checkedAt: new Date().toISOString() };
}
