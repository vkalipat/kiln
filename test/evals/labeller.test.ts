import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { labelBestWorst, valueBlock } from "../../src/evals/labeller";

type Context = { systemPrompt?: string[]; tools?: Array<{ name: string; parameters: Record<string, unknown> }> };
const USAGE = { input: 100, output: 20 };

function fixture(handler: (ctx: Context) => unknown) {
  const home = mkdtempSync(join(tmpdir(), "kiln-labeller-")); initHome(home);
  const judge = createMockModel({ id: "judge", provider: "producer", responses: [] });
  const labeller = createMockModel({ id: "labeller", provider: "other", handler: handler as never });
  const deps = {
    home, cfg: defaultConfig(), record: new RunRecord(join(home, "labeller-record.jsonl")),
    models: () => ({ model: judge as never, ref: "producer/judge" }),
    availableProviders: new Set(["producer", "other"]),
    modelsOn: () => ({ model: labeller as never, ref: "other/labeller" }),
    apiKeyFor: async () => "key", streamFn: streamMock as never,
  };
  const group = { id: "g1", shape: "product" as const, items: ["a", "b", "c", "d"].map((id) => ({ id, render: `render ${id}` })) };
  return { deps, group, labeller };
}

describe("calibration labeller", () => {
  test("uses one strict-compatible terminal bws tool on an independent provider", async () => {
    let seen: Context = {};
    const f = fixture((ctx) => {
      seen = ctx;
      return { content: [{ type: "toolCall", name: "bws", arguments: { best: "a", worst: "d" } }], usage: USAGE };
    });
    const result = await labelBestWorst(f.deps, f.group);
    expect(result).toMatchObject({ best: "a", worst: "d", refused: false, model: "other/labeller", crossProvider: true });
    expect(seen.tools?.map((tool) => tool.name)).toEqual(["bws"]);
    expect(seen.tools?.[0]?.parameters).toMatchObject({
      required: ["best", "worst"], additionalProperties: false,
      properties: { best: { type: "string" }, worst: { type: "string" } },
    });
    const system = (seen.systemPrompt ?? []).join("\n");
    expect(system).toContain("Calibration labeller rubric");
    expect(system).toContain("### product");
    expect(system).not.toContain("### research");
    expect(f.labeller.calls).toHaveLength(1);
  });

  test("a missing decision is a counted refusal and is not retried", async () => {
    const f = fixture(() => ({ content: ["I decline."], usage: USAGE }));
    const result = await labelBestWorst(f.deps, f.group);
    expect(result.refused).toBe(true);
    expect(result.best).toBeUndefined();
    expect(f.labeller.calls).toHaveLength(1);
  });

  test("rejects malformed groups before a model call", async () => {
    const f = fixture(() => ({ content: [], usage: USAGE }));
    await expect(labelBestWorst(f.deps, { ...f.group, items: f.group.items.slice(0, 3) })).rejects.toThrow("exactly four");
    expect(f.labeller.calls).toHaveLength(0);
  });

  test("extracts only the requested shape's Value block", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-labeller-")); initHome(home);
    const block = valueBlock(home, "creative");
    expect(block).toContain("### creative");
    expect(block).not.toContain("### product");
  });
});
