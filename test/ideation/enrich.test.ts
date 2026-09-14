import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig, type Role } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { RunControl, withRunControl } from "../../src/core/run-control";
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
  test("five optional probe refusals reject those drafts while the sixth probe remains eligible", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `r1-i1-${i + 1}`);
    const brain = createMockModel({ id: "selector", responses: [{ content: [{ type: "toolCall", name: "probe_request", arguments: { ideas: ids.map((ideaId) => ({ ideaId, rationale: "Run the assigned bounded check; report unavailable inputs instead of substituting another test." })) } }] }] as never });
    const prober = createMockModel({ id: "optional-prober", handler: async (context: unknown) => JSON.stringify(context).includes("r1-i1-6")
      ? { content: [{ type: "toolCall", name: "probe_spec", arguments: { files: [], command: "echo checked", needs: [], networkRequired: false, timeoutSeconds: 5, successPredicate: { type: "substring", value: "checked" }, scope: "precondition" } }] }
      : { stopReason: "error", errorMessage: "provider refused", stopDetails: { type: "refusal", category: "safety" } } } as never);
    const { deps, archive, record } = fixture({ brain, prober });
    for (const id of ids.slice(1)) archive.insert({ ...dossier(), id });
    for (const id of ids) archive.mergeEvidence(id, { priorArt: { status: "not_falsified" } });
    const result = await enrichEvidence(deps, archive, ids, "product", 1, new Limiter(2));
    expect(result.failure).toBeUndefined();
    for (const id of ids.slice(0, 5)) {
      expect(archive.get(id)?.evidence).toMatchObject({ status: "rejected", rejectReason: "probe_refused", probe: { status: "not_run", reason: "worker_refused:safety" } });
    }
    expect(archive.get(ids[5]!)?.evidence.probe?.status).toBe("pass");
    expect(archive.get(ids[5]!)?.evidence.status).not.toBe("rejected");
    expect(archive.seedable()).toEqual([ids[5]!]);
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "prober")).toHaveLength(6);
  });

  for (const [message, failureClass] of [["budget exhausted", "budget"], ["rate limit exceeded", "transient"], ["integrity check failed", "integrity"]] as const) {
    test(`optional probe collection still stops on ${failureClass} worker failure`, async () => {
      const brain = createMockModel({ id: "selector", responses: [{ content: [{ type: "toolCall", name: "probe_request", arguments: { ideas: [{ ideaId: "r1-i1-1", rationale: "Run the exact bounded check." }] } }] }] as never });
      const prober = createMockModel({ id: "failed-worker", responses: [{ stopReason: "error", errorMessage: message }] as never });
      const { deps, archive } = fixture({ brain, prober });
      archive.mergeEvidence("r1-i1-1", { priorArt: { status: "not_falsified" } });
      const result = await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
      expect(result.failure?.failureClass).toBe(failureClass);
      expect(archive.get("r1-i1-1")?.evidence.probe).toBeUndefined();
    });
  }

  test("a completed scout survives sibling cancellation and resumes into review without replay", async () => {
    const control = new RunControl();
    let ready!: () => void;
    const checkpointReady = new Promise<void>((resolve) => { ready = resolve; });
    let resumed = false;
    let completedCalls = 0, siblingCalls = 0, completedFetches = 0, siblingFetches = 0;
    const report = "Complete findings with a retained report tail: TAIL-COMPLETE-REPORT https://openalex.org/W1";
    let reviewedExactReport = false;
    const scout = createMockModel({ id: "durable-scout", handler: async (context: unknown) => {
      const text = JSON.stringify(context);
      const complete = text.includes("Completed handoff");
      if (complete) completedCalls += 1; else siblingCalls += 1;
      if (!complete && !resumed) {
        await checkpointReady;
        control.cancel("test sibling interruption after first report persisted");
        throw control.signal.reason;
      }
      if (!text.includes("toolResult")) return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: complete ? "completed" : "sibling" } }] };
      return { content: [complete ? report : "Sibling findings https://openalex.org/W2"] };
    } } as never);
    const arbiter = createMockModel({ id: "durable-review", handler: (context: unknown) => {
      const text = JSON.stringify(context);
      if (text.includes("Completed handoff")) reviewedExactReport = text.includes(report);
      return { content: [{ type: "toolCall", name: "collision", arguments: { coverageAdequate: true, same: false, reason: "Relevant sources reviewed; the mechanisms differ." } }] };
    } } as never);
    const { deps, archive, record } = fixture({ scout, arbiter });
    archive.get("r1-i1-1")!.dossier.title = "Completed handoff";
    archive.insert({ ...dossier(), id: "r1-i1-2", title: "Interrupted sibling" });
    const ids = ["r1-i1-1", "r1-i1-2"];
    for (const id of ids) archive.mergeEvidence(id, { probe: { status: "not_run", reason: "not_probeable" } });
    deps.fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const complete = url.searchParams.get("search") === "completed";
      if (complete) completedFetches += 1; else siblingFetches += 1;
      return new Response(JSON.stringify({ results: [{ id: `https://openalex.org/${complete ? "W1" : "W2"}`, display_name: "Retrieved work" }] }));
    }) as typeof fetch;
    const append = record.append.bind(record);
    record.append = (event) => {
      const saved = append(event);
      if (event.t === "note" && event.text.startsWith("prior-art checkpoint r1-i1-1: ")) ready();
      return saved;
    };
    await expect(withRunControl(control, () => enrichEvidence(deps, archive, ids, "product", 1, new Limiter(2)))).rejects.toThrow();
    const originalJournal = readFileSync(deps.run.record, "utf8");
    const historicalSpend = record.costUsd();
    const historicalCalls = record.read().filter((event) => event.t === "model.call").length;
    expect(completedCalls).toBe(2);
    expect(completedFetches).toBe(1);
    expect(archive.get(ids[0]!)?.evidence.priorArt).toBeUndefined();
    resumed = true;
    const restored = new Archive(deps.run, record);
    for (const item of archive.all()) restored.adopt(item);
    const result = await enrichEvidence(deps, restored, ids, "product", 1, new Limiter(2));
    expect(result.failure).toBeUndefined();
    expect(completedCalls).toBe(2);
    expect(completedFetches).toBe(1);
    expect(siblingCalls).toBe(3);
    expect(siblingFetches).toBe(1);
    expect(reviewedExactReport).toBe(true);
    expect(restored.get(ids[0]!)?.evidence.priorArt?.status).toBe("not_falsified");
    expect(restored.get(ids[1]!)?.evidence.priorArt?.status).toBe("not_falsified");
    expect(readFileSync(deps.run.record, "utf8").startsWith(originalJournal)).toBe(true);
    expect(record.costUsd()).toBeGreaterThanOrEqual(historicalSpend);
    const newCalls = record.read().filter((event) => event.t === "model.call").slice(historicalCalls);
    expect(newCalls.filter((event) => event.role === "scout")).toHaveLength(2);
    expect(newCalls.filter((event) => event.role === "arbiter")).toHaveLength(2);
  });

  test.each([false, true])("review interruption retains research; an explicit inadequate decision retires it (inadequate: %s)", async (inadequate) => {
    let recovered = false, scoutCalls = 0;
    const scout = createMockModel({ id: "review-recovery-scout", handler: (context: unknown) => {
      scoutCalls += 1;
      if (!JSON.stringify(context).includes("toolResult")) return { content: [{ type: "toolCall", name: "scholar_search", arguments: { query: "journal indexing" } }] };
      return { content: ["Full saved research from https://openalex.org/W1"] };
    } } as never);
    const arbiter = createMockModel({ id: "recovering-reviewer", handler: () => {
      if (!recovered && !inadequate) return { stopReason: "error", errorMessage: "transient reviewer unavailable" };
      return { content: [{ type: "toolCall", name: "collision", arguments: { coverageAdequate: recovered, same: false, reason: recovered ? "Relevant evidence supports the comparison." : "The retrieved evidence does not cover this mechanism." } }] };
    } } as never);
    const { deps, archive } = fixture({ scout, arbiter });
    const id = "r1-i1-1";
    archive.mergeEvidence(id, { probe: { status: "not_run", reason: "not_probeable" } });
    await enrichEvidence(deps, archive, [id], "product", 1, new Limiter(1));
    expect(archive.get(id)?.evidence.priorArt?.status).toBe("search_failed");
    expect(scoutCalls).toBe(2);
    recovered = true;
    await enrichEvidence(deps, archive, [id], "product", 1, new Limiter(1));
    expect(scoutCalls).toBe(inadequate ? 4 : 2);
    expect(archive.get(id)?.evidence.priorArt?.status).toBe("not_falsified");
  });

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
      timeoutSeconds: 20, successPredicate: { type: "substring", value: "ready" }, scope: "precondition",
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
