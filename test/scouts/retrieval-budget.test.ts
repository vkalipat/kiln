import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { runScout } from "../../src/scouts/scout";

test("scout bounds a large tool batch and reserves a tool-free evidence summary", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-scout-limit-"));
  try {
    const run = createRun(home, "seed"); let executed = 0;
    const model = createMockModel({ id: "scout", handler: async (ctx: any) => (ctx.tools?.length ?? 0) === 0
      ? { content: ["- Observed fact from https://example.test/0; other coverage remains unknown."] }
      : { content: Array.from({ length: 20 }, (_, i) => ({ type: "toolCall", name: "web_fetch", arguments: { url: `https://example.test/${i}` } })) } } as never);
    const result = await runScout({ home, runId: run.id, cfg: defaultConfig(), record: new RunRecord(run.record),
      question: "Find evidence", brief: "A bounded question", model, streamFn: streamMock as never, apiKey: "mock", retrievalLimit: 12,
      tools: [{ name: "web_fetch", label: "Fetch", description: "Read a source", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        execute: async () => { executed++; return { content: [{ type: "text", text: "Observed source fact" }] }; } }],
    });
    expect(executed).toBe(12); expect(result.successfulFetches).toBe(12);
    expect(result.stopped).toBe("done"); expect(result.turns).toBe(2);
    expect(result.findings).toContain("coverage remains unknown");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
