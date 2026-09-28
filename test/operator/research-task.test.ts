import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runResearchTask, type ResearchTaskInput } from "../../src/operator/research-task";
import type { ToolContext } from "../../src/brain/tools";

const input: ResearchTaskInput = {
  question: "Does this API support streaming?",
  requiredFields: [{ id: "streaming", question: "Documented streaming support" }],
  sources: ["https://docs.example.com/first", "https://docs.example.com/second"],
  allowedHosts: ["docs.example.com"],
};
async function fixture(work: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "kiln-research-test-"));
  try { await work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("research task evidence collection", () => {
  test("retains conflicting sources and validates passage locations without claiming truth", async () => fixture(async artifactDir => {
    const result = await runResearchTask(input, {
      artifactDir,
      fetchSource: async url => ({ text: url.endsWith("first") ? "Streaming is supported." : "Streaming is not supported.", truncated: false, costUsd: 0 }),
      classify: async ({ passages }) => ({ costUsd: 0.001, labels: passages.map((p, i) => ({ sourceId: p.sourceId, fieldId: "streaming", coverage: i ? "contradicts" : "supports", passageIds: [p.id] })) }),
    });
    expect(result.status).toBe("collected");
    expect(result.truthVerified).toBe(false);
    expect(result.untrusted).toBe(true);
    expect(result.fields[0]!.evidence.map(e => e.coverage)).toEqual(["supports", "contradicts"]);
    expect(result.cost).toEqual({ knownUsd: 0.001, unknownCalls: 0, complete: true });
    for (const source of result.sources) {
      const text = readFileSync(source.artifact.path, "utf8");
      expect(sha(text)).toBe(source.artifact.sha256);
      expect(source.integrity).toBe("verified");
      expect(source.retrievedAt).toMatch(/^\d{4}-/);
      const location = result.fields[0]!.evidence.find(e => e.sourceId === source.id)!.locations[0]!;
      expect(text.slice(location.start, location.end)).toBe(text);
    }
    expect(sha(readFileSync(result.manifest.path, "utf8"))).toBe(result.manifest.sha256);
  }));

  test("captures the full supplied evidence while bounding inline and classification text", async () => fixture(async artifactDir => {
    const text = "Evidence ".repeat(4000);
    const result = await runResearchTask({ ...input, sources: [input.sources[0]!], maxCaptureChars: 1200, maxInlineChars: 99 }, {
      artifactDir, fetchSource: async () => ({ text }),
      classify: async ({ passages }) => { expect(passages.map(p => p.text).join("").length).toBe(1200); return { labels: [] }; },
    });
    expect(readFileSync(result.sources[0]!.artifact.path, "utf8")).toBe(text);
    expect(result.sources[0]!.artifact.chars).toBe(text.length);
    expect(result.sources[0]!.excerpt.length).toBe(99);
    expect(result.sources[0]!.truncated).toBe(true);
    expect(result.fields[0]!.status).toBe("unknown");
    expect(result.cost.complete).toBe(false);
  }));

  test("rejects invented or cross-source passage provenance and preserves captures", async () => fixture(async artifactDir => {
    const result = await runResearchTask(input, {
      artifactDir, fetchSource: async () => ({ text: "Actual source text" }),
      classify: async () => ({ labels: [{ sourceId: "source-1", fieldId: "streaming", coverage: "supports", passageIds: ["source-2-p1"] }] }),
    });
    expect(result.fields[0]!.evidence.every(e => e.coverage === "unknown")).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.failures.some(f => f.stage === "classify")).toBe(true);
  }));

  test("source outages remain unknown and optional browser captures retain failure history", async () => fixture(async artifactDir => {
    const result = await runResearchTask(input, {
      artifactDir, fetchSource: async () => { throw new Error("secret diagnostic"); },
      browser: async url => { if (url.endsWith("second")) throw new Error("private browser diagnostics"); return { text: "Rendered source" }; },
    });
    expect(result.status).toBe("partial");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.method).toBe("browser");
    expect(result.fields[0]!.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("secret diagnostic");
    expect(result.calls).toEqual({ search: 0, fetch: 2, browser: 2, classify: 0 });
  }));

  test("rejects bad scope and bounds before artifact creation or adapter calls", async () => fixture(async artifactDir => {
    let called = false;
    const deps = { artifactDir, fetchSource: async () => { called = true; return { text: "x" }; } };
    for (const sources of [["https://user:pass@docs.example.com"], ["http://docs.example.com"], ["https://127.0.0.1/"], ["https://other.example.com/"]]) {
      await expect(runResearchTask({ ...input, sources }, deps)).rejects.toThrow();
    }
    await expect(runResearchTask({ ...input, concurrency: 10 }, deps)).rejects.toThrow();
    await expect(runResearchTask({ ...input, requiredFields: [input.requiredFields[0]!, input.requiredFields[0]!] }, deps)).rejects.toThrow();
    expect(called).toBe(false);
    expect(readdirSync(artifactDir)).toHaveLength(0);
  }));

  test("search scope, deduplication, source cap and concurrency are bounded", async () => fixture(async artifactDir => {
    let active = 0; let peak = 0;
    const result = await runResearchTask({ ...input, sources: [], searchQueries: ["stream docs"], maxSources: 3, concurrency: 2 }, {
      artifactDir,
      search: async () => ({ status: "ok", urls: ["https://outside.example.com/x", input.sources[0]!, input.sources[0]!, input.sources[1]!, "https://docs.example.com/third", "https://docs.example.com/fourth"] }),
      fetchSource: async () => { active++; peak = Math.max(active, peak); await Bun.sleep(5); active--; return { text: "Captured" }; },
    });
    expect(result.sources).toHaveLength(3);
    expect(peak).toBe(2);
    expect(result.calls.fetch).toBe(3);
    expect(result.sources.every(source => source.url.startsWith("https://docs.example.com/"))).toBe(true);
  }));

  test("deadline bounds non-cooperating dependencies and no late capture writes occur", async () => fixture(async artifactDir => {
    const result = await runResearchTask({ ...input, timeoutMs: 10, concurrency: 1 }, {
      artifactDir, fetchSource: async () => { await Bun.sleep(60); return { text: "Late evidence" }; },
    });
    expect(result.status).toBe("cancelled");
    expect(result.sources).toHaveLength(0);
    expect(result.calls.fetch).toBe(1);
    await Bun.sleep(70);
    expect(readdirSync(join(artifactDir, readdirSync(artifactDir)[0]!))).toEqual(["manifest.json"]);
  }));

  test("already cancelled tasks do not call services", async () => fixture(async artifactDir => {
    const controller = new AbortController(); controller.abort();
    const result = await runResearchTask(input, { artifactDir, signal: controller.signal, fetchSource: async () => { throw new Error("must not execute"); } });
    expect(result.status).toBe("cancelled");
    expect(result.calls.fetch).toBe(0);
  }));

  test("new invocations never overwrite evidence and source drift invalidates labels", async () => fixture(async artifactDir => {
    const deps = { artifactDir, fetchSource: async () => ({ text: "Original source" }) };
    const first = await runResearchTask(input, deps);
    const second = await runResearchTask(input, {
      ...deps,
      classify: async ({ passages }) => {
        const dirs = readdirSync(artifactDir).map(name => join(realpathSync(artifactDir), name));
        for (const dir of dirs) if (!first.manifest.path.startsWith(dir + "/")) {
          const path = join(dir, "source-1.txt"); chmodSync(path, 0o644); writeFileSync(path, "Tampered");
        }
        return { labels: [{ sourceId: "source-1", fieldId: "streaming", coverage: "supports", passageIds: [passages[0]!.id] }] };
      },
    });
    expect(first.manifest.path).not.toBe(second.manifest.path);
    expect(readFileSync(first.sources[0]!.artifact.path, "utf8")).toBe("Original source");
    expect(second.sources[0]!.integrity).toBe("changed");
    expect(second.fields[0]!.evidence[0]!.coverage).toBe("unknown");
    expect(second.failures.some(f => f.reason.includes("changed"))).toBe(true);
  }));

  test("unapproved final URLs cannot acquire valid evidence labels", async () => fixture(async artifactDir => {
    const result = await runResearchTask(input, { artifactDir, fetchSource: async () => ({ text: "Redirected", finalUrl: "https://unapproved.example.com/" }) });
    expect(result.sources).toHaveLength(0);
    expect(result.status).toBe("partial");
  }));

  test("default web adapter retains per-request deadline and rejects redirect following", async () => fixture(async artifactDir => {
    let requestAborted = false;
    const toolContext = {
      webTimeoutMs: 5,
      fetchImpl: async (_url: unknown, init: RequestInit) => {
        expect(init.redirect).toBe("error");
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => { requestAborted = true; reject(new Error("request deadline")); }, { once: true });
        });
      },
    } as unknown as ToolContext;
    const result = await runResearchTask({ ...input, sources: [input.sources[0]!], timeoutMs: 1000 }, { artifactDir, toolContext });
    expect(requestAborted).toBe(true);
    expect(result.status).toBe("partial");
    expect(result.sources).toHaveLength(0);
  }));

  test("default adapter captures visible source text through the existing web tool", async () => fixture(async artifactDir => {
    const toolContext = { fetchImpl: async () => new Response("<html><script>secret executable</script><body>Visible evidence</body></html>") } as unknown as ToolContext;
    const result = await runResearchTask({ ...input, sources: [input.sources[0]!] }, { artifactDir, toolContext });
    expect(result.sources).toHaveLength(1);
    expect(readFileSync(result.sources[0]!.artifact.path, "utf8")).toBe("Visible evidence");
    expect(result.sources[0]!.truncated).toBe("unknown");
    expect(result.cost.complete).toBe(false);
  }));
});
