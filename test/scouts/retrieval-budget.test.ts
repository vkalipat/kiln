import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { defaultConfig } from "../../src/core/config";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { runScout } from "../../src/scouts/scout";
import { scoutTools } from "../../src/brain/tools";
import { Limiter } from "../../src/core/limiter";

test("an expensive admitted retrieval turn keeps its source batch before dollar finishing", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-scout-admitted-"));
  try {
    const run = createRun(home, "seed"); let retrieved = 0;
    const model = createMockModel({ id: "expensive-first", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async (ctx: any) => (ctx.tools?.length ?? 0) === 0
      ? { content: ["- Supported answer from the retrieved source."], usage: { input: 6_000, output: 2_800 } }
      : { content: [0, 1].map(() => ({ type: "toolCall", name: "web_fetch", arguments: {} })), usage: { input: 10_000, output: 8_000 } } } as never);
    const result = await runScout({ home, runId: run.id, cfg: defaultConfig(), record: new RunRecord(run.record), question: "Evidence?", brief: "Brief", model, streamFn: streamMock as never, apiKey: "mock", usdCap: 0.4,
      tools: [{ name: "web_fetch", label: "Fetch", description: "Read", parameters: { type: "object", properties: {} }, execute: async () => { retrieved++; return { content: [{ type: "text", text: "Observed source" }] }; } }],
    });
    expect(retrieved).toBe(2); expect(result.successfulFetches).toBe(2);
    expect(result.stopped).toBe("done"); expect(result.turns).toBe(2); expect(result.costUsd).toBeCloseTo(0.35);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("dollar finishing reserves an answer from owned usage despite unrelated concurrent journal spend", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-scout-owned-usd-"));
  try {
    const run = createRun(home, "seed"); const record = new RunRecord(run.record); let retrievals = 0;
    const model = createMockModel({ id: "priced", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async (ctx: any) => (ctx.tools?.length ?? 0) === 0
      ? { content: ["- Observed source evidence."], usage: { input: 6_000, output: 2_800 } }
      : { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://example.test" } }], usage: { input: 8_000, output: 1_600 } } } as never);
    const result = await runScout({ home, runId: run.id, cfg: defaultConfig(), record, question: "Find evidence", brief: "Bounded brief", model, streamFn: streamMock as never, apiKey: "mock", usdCap: 0.4,
      tools: [{ name: "web_fetch", label: "Fetch", description: "Read", parameters: { type: "object", properties: {} }, execute: async () => {
        if (retrievals++ === 0) record.append({ t: "model.call", role: "brain", provider: "mock", model: "unrelated", inputHash: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 100, stopReason: "stop", excerpt: "" });
        return { content: [{ type: "text", text: "Observed evidence" }] };
      } }],
    });
    expect(result.stopped).toBe("done"); expect(result.turns).toBe(3); expect(retrievals).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.26); expect(record.costUsd()).toBeCloseTo(100.26);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("retrieval cutoff prevents network dispatch for requests already queued behind the search limiter", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-scout-queued-"));
  try {
    const run = createRun(home, "seed"); const record = new RunRecord(run.record); const cutoff = new AbortController();
    const searchLimiter = new Limiter(1); let networkCalls = 0;
    const model = createMockModel({ id: "queued", handler: async (ctx: any) => (ctx.tools?.length ?? 0) === 0
      ? { content: ["- Observed source fact; remaining requests were not retrieved."] }
      : { content: [0, 1, 2].map((i) => ({ type: "toolCall", name: "web_fetch", arguments: { url: `https://example.test/${i}` } })) } } as never);
    const result = await runScout({ home, runId: run.id, cfg: defaultConfig(), record,
      question: "Find evidence", brief: "A bounded question", model, streamFn: streamMock as never, apiKey: "mock", retrievalSignal: cutoff.signal,
      tools: scoutTools({ cwd: run.dir, roots: [run.dir], run, record, searchLimiter, searchJitterMs: 0,
        fetchImpl: (async () => { networkCalls++; await Bun.sleep(10); cutoff.abort(); return new Response("Observed source fact"); }) as unknown as typeof fetch }),
    });
    expect(networkCalls).toBe(1); expect(result.successfulFetches).toBe(1); expect(result.turns).toBe(2);
    expect(searchLimiter.active).toBe(0); expect(searchLimiter.pending).toBe(0);
    expect(record.read().filter((event) => event.t === "tool.call" && event.name === "web_fetch" && event.ok === false)).toHaveLength(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("soft retrieval cutoff preserves observed evidence and makes the next request tool-free", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-scout-soft-"));
  try {
    const run = createRun(home, "seed"); const cutoff = new AbortController(); let executed = 0; let nextContext = "";
    const model = createMockModel({ id: "soft-scout", handler: async (ctx: any) => {
      if ((ctx.tools?.length ?? 0) === 0) { nextContext = JSON.stringify(ctx.messages); return { content: ["- Observed source fact; other coverage unknown."] }; }
      return { content: [0, 1].map((i) => ({ type: "toolCall", name: "web_fetch", arguments: { url: `https://example.test/${i}` } })) };
    } } as never);
    const result = await runScout({ home, runId: run.id, cfg: defaultConfig(), record: new RunRecord(run.record),
      question: "Find evidence", brief: "A bounded question", model, streamFn: streamMock as never, apiKey: "mock",
      retrievalSignal: cutoff.signal,
      tools: [{ name: "web_fetch", label: "Fetch", description: "Read source", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        execute: async () => { executed++; cutoff.abort(); return { content: [{ type: "text", text: "Observed source fact with https://example.test/0" }] }; } }],
    });
    expect(executed).toBe(1); expect(result.turns).toBe(2); expect(result.stopped).toBe("done");
    expect(result.successfulFetches).toBe(1); expect(nextContext).toContain("Observed source fact with https://example.test/0");
    expect(result.findings).toContain("coverage unknown");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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
