import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const arbiter = createMockModel({ id: "arbiter", handler: () => ({ content: [{ type: "toolCall", name: "collision", arguments: { same: false, reason: "different" } }] }) } as never);
    const brain = createMockModel({ id: "brain", responses: [{ content: ["No executable probe."] }] as never });
    const { deps, archive } = fixture({ scout, arbiter, brain });
    archive.mergeEvidence("r1-i1-1", { priorArt: { status: "search_failed" }, probe: { status: "not_run", reason: "not_probeable" } });
    const result = await enrichEvidence(deps, archive, ["r1-i1-1"], "product", 1, new Limiter(1));
    expect(result.failure).toBeUndefined();
    expect(searched).toBe(true);
    expect(archive.get("r1-i1-1")?.evidence.priorArt?.status).toBe("not_falsified");
  });
});
