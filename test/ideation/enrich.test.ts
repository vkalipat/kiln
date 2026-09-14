import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig, type Role } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { Archive } from "../../src/ideation/archive";
import type { Dossier } from "../../src/ideation/dossier";
import { enrichEvidence } from "../../src/phases/ideate";
import type { PhaseDeps } from "../../src/phases/frame";

const dossier = (): Dossier => ({
  id: "r1-i1-1", title: "Index", mechanism: "hash a journal", draws: "shingling",
  axisValues: { audience: "teams" }, testableClaim: "find duplicates", cheapestTest: "run a script",
  failureReason: "false positives", parents: [],
});

function fixture(models: Partial<Record<Role, unknown>>) {
  const home = mkdtempSync(join(tmpdir(), "kiln-enrich-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  writeFileSync(run.brief, "# Brief\n\n## Problem\nFind a useful index.\n\n## Search success\n- measurable\n\n## Shape\nproduct\n");
  const cfg = defaultConfig();
  const fallback = createMockModel({ id: "fallback", responses: [{ content: ["done"] }] as never });
  const deps = {
    home, run, record, cfg, limiter: new Limiter(2), streamFn: streamMock as never,
    models: (role: Role) => ({ model: (models[role] ?? fallback) as never, ref: `mock/${role}` }),
    apiKeyFor: async () => "key",
    fetchImpl: (async () => new Response(JSON.stringify({ results: [{ id: "https://openalex.org/W1", display_name: "Held" }] }))) as unknown as typeof fetch,
  } as unknown as PhaseDeps;
  const archive = new Archive(run, record);
  archive.insert(dossier());
  return { deps, archive, record };
}

describe("ideation evidence enrichment", () => {
  test("an unobserved collision URL cannot become either a rejection or a conclusive negative", async () => {
    const scout = createMockModel({ id: "owned-search", responses: [
      { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "journal indexing" } }] },
      { content: ["Retrieved https://openalex.org/W1 only."] },
    ] as never });
    const arbiter = createMockModel({ id: "unobserved-collision", responses: [{ content: [{
      type: "toolCall", name: "collision", arguments: { coverageAdequate: true, same: true, artifactUrl: "https://example.org/unobserved", reason: "A claimed duplicate that the scout did not retrieve." },
    }] }] as never });
    const { deps, archive, record } = fixture({ scout, arbiter });
    archive.mergeEvidence("r1-i1-1", { probe: { status: "not_run", reason: "not_probeable" } });
    await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
    expect(archive.get("r1-i1-1")?.evidence.priorArt?.status).toBe("search_failed");
    expect(archive.get("r1-i1-1")?.evidence.status).not.toBe("rejected");
    expect(record.read().some((event) => event.t === "arbiter.verdict" && event.verdict === "distinct")).toBe(false);
  });

  test.each([false, true])("parsed search cannot clear prior-art coverage when review is unavailable or inadequate (seat available: %s)", async (seatAvailable) => {
    const scout = createMockModel({ id: "unrelated-results-scout", responses: [
      { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "journal duplicate mechanisms" } }] },
      { content: ["The retrieved result is unrelated to this mechanism. The search does not establish relevant prior-art coverage."] },
    ] as never });
    const arbiter = createMockModel({ id: "coverage-reviewer", responses: [{ content: [{
      type: "toolCall", name: "collision", arguments: { coverageAdequate: false, same: false, reason: "Only unrelated results were retrieved; the relevant prior art remains unknown." },
    }] }] as never });
    const { deps, archive, record } = fixture({ scout, arbiter });
    deps.cfg.ideation.arbiterCaps.collision = seatAvailable ? 1 : 0;
    archive.mergeEvidence("r1-i1-1", { probe: { status: "not_run", reason: "not_probeable" } });
    const result = await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
    expect(result.failure).toBeUndefined();
    expect(archive.get("r1-i1-1")?.evidence.priorArt?.status).toBe("search_failed");
    expect(archive.get("r1-i1-1")?.evidence.priorArt?.distance).toContain(seatAvailable ? "Only unrelated" : "not been reviewed");
    expect(result.searchHealth).toBe(0);
    expect(result.noveltyEnforced).toBe(false);
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "arbiter")).toHaveLength(seatAvailable ? 1 : 0);
    expect(record.read().some((event) => event.t === "arbiter.verdict" && event.verdict === "distinct")).toBe(false);
  });

  test("the inline budget applies across whole artifacts and later small artifacts still fit", async () => {
    let first = "";
    const brain = createMockModel({ id: "aggregate-brain", handler: (context: unknown) => {
      first = JSON.stringify(context);
      return { content: ["No executable test."] };
    } } as never);
    const { deps, archive } = fixture({ brain });
    const ids = ["r1-i1-1", "r1-i1-2", "r1-i1-3"];
    for (const id of ids.slice(1)) archive.insert({ ...dossier(), id });
    const bodies = ["FIRST-START" + "a".repeat(16_000) + "FIRST-END", "SECOND-START" + "b".repeat(16_000) + "SECOND-END", "THIRD-COMPLETE"];
    ids.forEach((id, index) => {
      archive.mergeEvidence(id, { priorArt: { status: "not_falsified" } });
      writeFileSync(join(deps.run.ideasDir, `${id}.md`), bodies[index]!);
    });
    await enrichEvidence(deps, archive, ids, "product", 1, new Limiter(1));
    expect(first).toContain(bodies[0]!);
    expect(first).not.toContain("SECOND-START");
    expect(first).not.toContain("SECOND-END");
    expect(first).toContain(createHash("sha256").update(bodies[1]!).digest("hex"));
    expect(first).toContain(bodies[2]!);
  });

  test("oversized dossiers are deferred whole with provenance and acquired through read", async () => {
    const raw = "# Large original\n" + "x".repeat(33_000) + "\nTAIL-ORACLE\n";
    let first = "";
    let path = "";
    let calls = 0;
    const brain = createMockModel({ id: "overflow-brain", handler: (context: unknown) => {
      calls += 1;
      first ||= JSON.stringify(context);
      if (calls === 1) return { content: [{ type: "toolCall", name: "read", arguments: { path } }] };
      return { content: ["No executable cheapest test."] };
    } } as never);
    const { deps, archive, record } = fixture({ brain });
    archive.mergeEvidence("r1-i1-1", { priorArt: { status: "not_falsified" } });
    path = join(deps.run.ideasDir, "r1-i1-1.md");
    writeFileSync(path, raw);
    const result = await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
    expect(result.failure).toBeUndefined();
    expect(first).toContain("Deferred");
    expect(first).toContain(path);
    expect(first).toContain(String(raw.length));
    expect(first).toContain(createHash("sha256").update(raw).digest("hex"));
    expect(first).not.toContain("TAIL-ORACLE");
    expect(first).toContain("Read every deferred artifact completely");
    expect(record.read().filter((event) => event.t === "tool.call" && event.name === "read")).toHaveLength(1);
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "brain")).toHaveLength(2);
  });

  test("canonical probe handoff avoids acquisition turns and excludes completed siblings on resume", async () => {
    const raw = '# Original dossier\n' + 'preserve whitespace  \n'.repeat(80) + '\nHard limit: NEVER upload private data. Source: https://example.org/raw#tail\n';
    let first = "";
    let path = "";
    const brain = createMockModel({ id: "handoff-brain", handler: (context: unknown) => {
      const text = JSON.stringify(context);
      first ||= text;
      if (!text.includes("NEVER upload private data")) return { content: [{ type: "toolCall", name: "read", arguments: { path } }] };
      return { content: [{ type: "toolCall", name: "probe_request", arguments: { ideas: [{ ideaId: "r1-i1-1", rationale: "local executable test" }] } }] };
    } } as never);
    const prober = createMockModel({ id: "handoff-prober", responses: [{ content: [{ type: "toolCall", name: "probe_spec", arguments: {
      files: [{ path: "check.sh", content: "echo ready\n" }], command: "sh check.sh", needs: ["sh"], networkRequired: false,
      timeoutSeconds: 20, successPredicate: { type: "substring", value: "ready" },
    } }] }] as never });
    const { deps, archive, record } = fixture({ brain, prober });
    path = join(deps.run.ideasDir, "r1-i1-1.md");
    writeFileSync(path, raw);
    for (const id of ["r1-i1-2", "r1-i1-3", "r1-i1-4"]) archive.insert({ ...dossier(), id }, { source: `RAW-${id}` });
    const ids = ["r1-i1-1", "r1-i1-2", "r1-i1-3", "r1-i1-4"];
    for (const id of ids) archive.mergeEvidence(id, { priorArt: { status: "not_falsified" } });
    archive.mergeEvidence(ids[2]!, { probe: { status: "not_run", reason: "not_probeable" } });
    archive.markRejected(ids[3]!, "collided");
    const result = await enrichEvidence(deps, archive, ids, "product", 1, new Limiter(1), { metaReview: "Retain binding review" });
    expect(result.failure).toBeUndefined();
    expect(first).toContain(JSON.stringify(raw).slice(1, -1));
    expect(first).toContain("Find a useful index.");
    expect(first).toContain("Retain binding review");
    expect(first).toContain("RAW-r1-i1-2");
    expect(first).not.toContain("RAW-r1-i1-3");
    expect(first).not.toContain("RAW-r1-i1-4");
    const calls = record.read().filter((event) => event.t === "model.call" && event.role === "brain");
    expect(calls).toHaveLength(1);
    expect(record.read().filter((event) => event.t === "tool.call" && event.name === "read")).toHaveLength(0);
    expect(record.read().filter((event) => event.t === "probe" && event.id === ids[0] && event.status === "pass")).toHaveLength(1);
    const resumed = new Archive(deps.run, record);
    for (const item of archive.all()) resumed.adopt(item);
    await enrichEvidence(deps, resumed, ids, "product", 1, new Limiter(1));
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "brain")).toHaveLength(1);
  });

  test("a probe-selector refusal is a worker failure and never fake not-probeable evidence", async () => {
    const brain = createMockModel({ id: "refusing-brain", responses: [{
      stopReason: "error", errorMessage: "request refused", stopDetails: { type: "refusal", category: "safety" },
    }] as never });
    const { deps, archive, record } = fixture({ brain });
    archive.mergeEvidence("r1-i1-1", { priorArt: { status: "not_falsified" } });
    const result = await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
    expect(result.failure).toMatchObject({ failureClass: "refusal" });
    expect(archive.get("r1-i1-1")?.evidence.probe).toBeUndefined();
    expect(record.read().some((event) => event.t === "probe")).toBe(false);
  });

  test("a search_failed sidecar is retried and can recover on resume", async () => {
    let searched = false;
    const scout = createMockModel({ id: "scout", handler: (ctx: unknown) => {
      const text = JSON.stringify(ctx);
      if (!text.includes("toolResult")) return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "journal dedup" } }] };
      searched = true;
      return { content: ["Held: https://openalex.org/W1"] };
    } } as never);
    const arbiter = createMockModel({ id: "arbiter", handler: () => ({ content: [{ type: "toolCall", name: "collision", arguments: { coverageAdequate: true, same: false, reason: "different" } }] }) } as never);
    const brain = createMockModel({ id: "brain", responses: [{ content: ["No executable probe."] }] as never });
    const { deps, archive } = fixture({ scout, arbiter, brain });
    archive.mergeEvidence("r1-i1-1", { priorArt: { status: "search_failed" }, probe: { status: "not_run", reason: "not_probeable" } });
    const result = await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
    expect(result.failure).toBeUndefined();
    expect(searched).toBe(true);
    expect(archive.get("r1-i1-1")?.evidence.priorArt?.status).toBe("not_falsified");
  });
});
