import { expect, test } from "bun:test";
import { auditCatalog, fetchUpstreamCatalog, parseCatalog, UPSTREAM_CATALOG_URL } from "../../src/providers/catalog-audit";
const model = (id = "new-frontier") => ({ id, provider: "openai", api: "openai-responses", supportsTools: true, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000, thinking: { efforts: ["low", "high"] } });
test("new catalog IDs pass metadata review without becoming runtime admitted", () => {
  const finding = auditCatalog([], [model()])[0]!;
  expect(finding).toMatchObject({ change: "added", compatibility: "metadata_checks_passed", runtimeAdmission: "not_runtime_admitted" });
});
test("unknown API, effort, tool dialect and missing rates remain blocked", () => {
  const finding = auditCatalog([], [{ ...model(), api: "future-wire-v2", toolMode: "code_mode_only", thinking: { efforts: ["ultra"] }, cost: { input: 0, output: -1 } }])[0]!;
  expect(finding.compatibility).toBe("blocked");
  expect(finding.findings).toEqual(expect.arrayContaining(["unsupported_api", "unsupported_tool_contract", "unsupported_effort", "invalid_or_missing_cost"]));
});
test("identity mismatches and empty or malformed remote catalogs do not establish freshness", () => {
  expect(() => parseCatalog(JSON.stringify({ openai: { wrong: model() } }))).toThrow("identity");
  expect(() => parseCatalog("{}")).toThrow("Empty");
  expect(() => parseCatalog("[]")).toThrow("provider/model");
});
test("normalized object key ordering does not cause changed false positives", () => {
  const a = model(), b = Object.fromEntries(Object.entries(a).reverse());
  expect(auditCatalog([a], [b])[0]!.change).toBe("unchanged");
  expect(auditCatalog([a], [])[0]!.change).toBe("removed");
});
test("check only contacts fixed official source, uses timeout and refuses redirects", async () => {
  const result = await fetchUpstreamCatalog((async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    expect(url).toBe(UPSTREAM_CATALOG_URL); expect(options?.redirect).toBe("error"); expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toEqual({ accept: "application/json" });
    return Response.json({ openai: { "new-frontier": model() } });
  }) as unknown as typeof fetch);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/); expect(result.models).toHaveLength(1);
  await expect(fetchUpstreamCatalog((async () => new Response("error", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("503");
});
