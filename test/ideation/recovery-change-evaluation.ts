import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { Limiter } from "../../src/core/limiter";
import type { PhaseDeps } from "../../src/phases/frame";
import type { Dossier } from "../../src/ideation/dossier";
import { runPriorArtScout as after } from "../../src/ideation/priorart";
import { runPriorArtScout as before } from "./recovery-change-evaluation.before";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = fileURLToPath(new URL("../../", import.meta.url));
export function evaluationProvenance() {
  const fixture = readFileSync(new URL("./recovery-change-evaluation.before.ts", import.meta.url), "utf8");
  const normalized = fixture.replace(/^\/\/ Test-only historical module[^\n]*\n/, "")
    .replaceAll('from "../../src/ideation/dossier"', 'from "./dossier"').replaceAll('from "../../src/', 'from "../').trimEnd() + "\n";
  const fixtureSHA = sha256(normalized);
  if (fixtureSHA !== "cdb814b69deadabe0d2e4e9b28dea5a963d070ed067736c31cf3197af77bd3a6") throw new Error("Historical fixture integrity mismatch");
  let currentCommit: string | null = null;
  try { currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Source hashes remain usable in source-only CI. */ }
  return { historicalCommit: "e37399d", fixtureSHA, currentCommit,
    productionSourceSHA: Object.fromEntries(["src/ideation/priorart.ts", "src/ideation/priorart-checkpoint.ts", "src/scouts/scout.ts", "src/brain/agent.ts"].map((path) => [path, sha256(readFileSync(join(root, path)))])),
    currentModuleSHA: sha256(readFileSync(new URL(import.meta.url))),
  };
}

export async function evaluateRecoveryChanges() {
const provenance = evaluationProvenance();
const rows: unknown[] = [];
for (const seed of Array.from({ length: 12 }, (_, i) => i + 1)) {
  for (const scenario of ["pending_handoff", "review_unavailable", "inadequate_review"] as const) {
    for (const [arm, runScout] of [["before", before], ["after", after]] as const) {
      const home = mkdtempSync(join(tmpdir(), "kiln-recovery-evaluation-"));
      const run = createRun(home, `Synthetic evaluation ${seed}`);
      const record = new RunRecord(run.record);
      let scoutCalls = 0, reviewerCalls = 0, retrievals = 0, resumed = false;
      const source = `https://example.org/source-${seed}`;
      const report = `Original report ${seed}: ${"distinct evidence ".repeat(seed)} exact citation ${source}; uncertainty retained.`;
      const model = createMockModel({ id: `evaluation-scout-${seed}`, handler: async (context: unknown) => {
        scoutCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, seed % 3));
        if (!JSON.stringify(context).includes("toolResult")) return { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: source } }] };
        return { content: [report] };
      } } as never);
      const reviewer = createMockModel({ id: `evaluation-reviewer-${seed}`, handler: () => {
        reviewerCalls += 1;
        if (!resumed && scenario === "review_unavailable") return { stopReason: "error", errorMessage: "synthetic transport unavailable" };
        return { content: [{ type: "toolCall", name: "collision", arguments: { coverageAdequate: resumed, same: false, reason: resumed ? "Relevant source supports distinction" : "Coverage genuinely inadequate" } }] };
      } } as never);
      const deps = { home, run, record, cfg: defaultConfig(), limiter: new Limiter(2), streamFn: streamMock,
        models: (role: string) => ({ model: role === "arbiter" ? reviewer : model, ref: `mock/${role}` }), apiKeyFor: async () => "synthetic",
        fetchImpl: async () => { retrievals += 1; return new Response("Synthetic complete primary evidence"); },
      } as unknown as PhaseDeps;
      const dossier: Dossier = { id: `idea-${seed}`, title: "Synthetic", mechanism: "index records", draws: "indexing", axisValues: { audience: "teams" }, testableClaim: "Find records", cheapestTest: "local check", failureReason: "missing records", parents: [] };
      const first = await runScout(deps, dossier, { shape: "product", arbiter: scenario !== "pending_handoff" });
      const prior = { scoutCalls, reviewerCalls, retrievals, journalCalls: record.read().filter((e) => e.t === "model.call").length };
      resumed = true;
      const second = await runScout(deps, dossier, { shape: "product", arbiter: scenario !== "pending_handoff" });
      const expectedScout = arm === "after" && scenario !== "inadequate_review" ? 0 : 2;
      const row = { seed, scenario, arm, firstStatus: first.status, resumedStatus: second.status,
        resumeScoutCalls: scoutCalls - prior.scoutCalls, resumeReviewerCalls: reviewerCalls - prior.reviewerCalls,
        resumeRetrievals: retrievals - prior.retrievals,
        resumeJournalModelCalls: record.read().filter((e) => e.t === "model.call").length - prior.journalCalls,
        exactReport: second.findings === report, exactOwnedUrls: second.observedUrls.length === 1 && second.observedUrls[0] === source,
      };
      const expectedReview = scenario === "pending_handoff" ? 0 : 1;
      const expectedStatus = scenario === "pending_handoff" ? "search_failed" : "not_falsified";
      if (row.resumeScoutCalls !== expectedScout || row.resumeReviewerCalls !== expectedReview
        || row.resumeRetrievals !== expectedScout / 2 || row.resumeJournalModelCalls !== expectedScout + expectedReview
        || row.firstStatus !== "search_failed" || row.resumedStatus !== expectedStatus
        || !row.exactReport || !row.exactOwnedUrls) throw new Error(JSON.stringify(row));
      rows.push(row);
    }
  }
}
return { comparison: "Mocked-provider leaf-module ablation: actual historical priorart.ts from e37399d with relocated imports; both arms use current shared dependencies. Not a full historical checkout or task-quality evaluation.", provenance, rows };
}
if (import.meta.main) console.log(JSON.stringify(await evaluateRecoveryChanges(), null, 2));
