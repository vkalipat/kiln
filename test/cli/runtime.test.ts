import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, type UsageReport } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { createCliRuntime, firstProbePreview, usageSnapshot } from "../../src/cli/runtime";

describe("CLI runtime", () => {
  test("uses the most-consumed provider window and carries its reset time", () => {
    const reset = Date.parse("2026-09-05T12:00:00.000Z");
    const report = { provider: "anthropic", fetchedAt: 0, limits: [
      { id: "short", label: "short", scope: { provider: "anthropic" }, amount: { unit: "percent", used: 70 } },
      { id: "long", label: "long", scope: { provider: "anthropic" }, window: { id: "7d", label: "week", resetsAt: reset }, amount: { unit: "requests", used: 19, limit: 20 } },
    ] } as UsageReport;
    expect(usageSnapshot(report)).toEqual({ used: 0.95, limit: 1, resetAt: "2026-09-05T12:00:00.000Z" });
  });

  test("preserves an injected usage adapter for deterministic embeddings", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-runtime-cli-"));
    const fetchUsage = async () => ({ used: 0.2, limit: 1, resetAt: "later" });
    const runtime = await createCliRuntime(home, defaultConfig(), { apiKeyFor: async () => "k", fetchUsage });
    expect(runtime.fetchUsage).toBe(fetchUsage);
    expect(await runtime.fetchUsage("anthropic")).toEqual({ used: 0.2, limit: 1, resetAt: "later" });
    expect(runtime.available).toEqual(new Set(["anthropic", "openai-codex", "openai"]));
    expect(runtime.modelsOn("critic", "anthropic").model.provider).toBe("anthropic");
  });

  test("admits injected providers and uses the role override for provider-restricted seats", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-runtime-cli-"));
    const builder = createMockModel({ id: "builder", provider: "producer", responses: [] });
    const auditor = createMockModel({ id: "auditor", provider: "other", responses: [] });
    const runtime = await createCliRuntime(home, defaultConfig(), {
      models: { builder: builder as never, auditor: auditor as never },
      apiKeyFor: async (provider) => provider === "producer" || provider === "other" ? "key" : undefined,
    });
    expect([...runtime.available].slice(0, 2)).toEqual(["producer", "other"]);
    expect(runtime.models("builder")).toEqual({ model: builder, ref: "producer/builder" });
    expect(runtime.modelsOn("auditor", "other")).toEqual({ model: auditor, ref: "other/auditor" });
  });

  test("the interactive preview prints the first frozen probe only", async () => {
    const output: string[] = []; const preview = firstProbePreview({ write: (text) => output.push(text) }, true)!;
    const spec = { ideaId: "a", files: [{ path: "check.sh", content: "echo ok\n" }], command: "sh check.sh", needs: ["sh"], networkRequired: false, timeoutSeconds: 5, successPredicate: { type: "substring" as const, value: "ok" } };
    await preview(spec); await preview({ ...spec, ideaId: "b" });
    expect(output.join("")).toContain("First probe script (a)");
    expect(output.join("")).not.toContain("First probe script (b)");
  });
});
