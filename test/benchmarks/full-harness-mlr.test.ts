import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MLR_PROVENANCE, MLR_DIMENSIONS, projectMlrTask, selectMlrTasks, mlrIdeaDirective, assertMlrWorkflow, selectNativeMlrIdea, selectBaselineMlrIdea, validateMlrIdeaGrade, anonymizeMlrDeliveries, mlrJudgeRequest, type NativeMlrSnapshot, type MlrIntegrity } from "../../scripts/benchmarks/full-harness/mlr";
import { planWorkflow, compileWorkflow } from "../../src/workflow/plan";
import { renderDossierDetailed, RENDER_VERSION, type Dossier, type Evidence } from "../../src/ideation/dossier";
import { initHome } from "../../src/core/home";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { writeStatus } from "../../src/core/run";
import { main } from "../../src/cli/main";

// Synthetic fixtures only: no real task text, selection, expected paper, or provider requests.
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const task = () => ({ task_id: 7, task_name: "synthetic_task", task_description: "Investigate accuracy and latency tradeoffs in approximate indexing on small datasets.", author: "HIDDEN_AUTHOR", expected_paper: "HIDDEN_GOLD", results: { idea: "HIDDEN_GENERATION" }, metadata: { score: 10 } });
const integrity = (): MlrIntegrity => ({ sourceBeforeSha256: "a".repeat(64), sourceAfterSha256: "a".repeat(64), immutableArtifactsPreserved: true, journalPreserved: true, snapshotsVerified: true });
function nativeFixture(): NativeMlrSnapshot {
  const chosen = "r1-i1-1", raw = "## Title\nSynthetic indexing idea\n\n## Mechanism\nUse bounded index buckets to trade lookup error against latency.\n\n## Draws on\nSynthetic cache evidence\n\n## Axes\n- method: indexing\n\n## Testable claim\nLookup latency improves under an explicit approximation budget.\n\n## Cheapest test\nRun a local synthetic lookup experiment.\n\n## Strongest failure reason\nThe approximation may miss too many relevant records.\n\n## Probability\n0.02\n\n## Provenance\nHIDDEN_PROVENANCE\n";
  const dossier: Dossier = { id: chosen, title: "Synthetic indexing idea", mechanism: "Use bounded index buckets to trade lookup error against latency.", draws: "Synthetic cache evidence", axisValues: { method: "indexing" }, testableClaim: "Lookup latency improves under an explicit approximation budget.", cheapestTest: "Run a local synthetic lookup experiment.", failureReason: "The approximation may miss too many relevant records.", parents: ["HIDDEN_PARENT"], lens: "HIDDEN_LENS", operator: "HIDDEN_OPERATOR", vsProbability: .02 };
  const strength = { mean: 0, lo: -1, hi: 1, n: 3 }, evidence: Evidence = { status: "active", strengths: { value: strength, feasibility: strength }, priorArt: { status: "not_falsified" }, probe: { status: "not_run", reason: "Synthetic test fixture declares an unexecuted probe; no execution claim." } };
  const rendered = renderDossierDetailed(dossier, evidence), others = ["r1-i1-2", "r1-i2-1", "r1-i2-2"], ts = "2026-01-01T00:00:00.000Z";
  const workflow = planWorkflow(mlrIdeaDirective(task()), { adaptive: true });
  return {
    exitCode: 0, cancelled: false, integrity: integrity(), workflow, execution: compileWorkflow(workflow, { through: "checkpoint", autonomous: true }),
    status: { id: "synthetic-run", phase: "form", state: "running", chosenIdeaId: chosen, usdSpent: 1, turns: {}, createdAt: ts, updatedAt: ts },
    events: [
      { seq: 1, ts, t: "checkpoint.shown", round: 1, ideas: [chosen], hashes: [rendered.hash], ladders: { value: [chosen], feasibility: [chosen] } },
      { seq: 2, ts, t: "checkpoint.decision", kind: "autonomous_pick", id: chosen },
    ],
    frontier: { version: 1, mode: "loop", round: 1, rawFront: [chosen], shown: [chosen], eligible: [chosen, ...others], ideas: [{ id: chosen, backfill: false, value: strength as never, feasibility: strength as never }], ladders: { value: [chosen], feasibility: [chosen] }, searchHealth: 1, searchHealthFloor: .8, noveltyEnforced: true },
    tournament: others.flatMap((other, i) => (["ab", "ba"] as const).map((order, j) => ({ seq: 2 * i + j + 1, ts, round: 1, a: chosen, b: other, order, valueWinner: "a" as const, feasibilityWinner: "tie" as const, judgeModel: "HIDDEN_INTERNAL_JUDGE", aGenModel: "HIDDEN_GENERATOR", bGenModel: "HIDDEN_OTHER_GENERATOR", criteriaId: "criterion", aRenderHash: rendered.hash, bRenderHash: hash(other), costUsd: .01, source: "judge" as const }))),
    axes: [{ name: "method", values: ["indexing", "sampling"] }],
    artifacts: { [chosen]: { rawDossierText: raw, dossier, evidence, renderedText: rendered.text, renderVersion: RENDER_VERSION } },
  };
}
const baselineFixture = () => ({ exitCode: 0, cancelled: false, completed: true, integrity: integrity(), artifact: { relativePath: "idea.md", committed: true, content: "# A synthetic research idea\n\nOne proposal with its limitations and evidence.\n" } });
const grade = () => ({ ...Object.fromEntries(MLR_DIMENSIONS.map(name => [name, { score: 8, justification: `Synthetic ${name} justification.` }])), OverallAssessment: { score: 2, strengths: ["Synthetic strength"], weaknesses: ["Critical synthetic weakness"] } });

describe("MLR idea-stage pure adapter", () => {
  test("projects only official task fields and omits metadata from the directive", () => {
    expect(projectMlrTask(task())).toEqual({ task_id: 7, task_name: "synthetic_task", task_description: task().task_description });
    expect(mlrIdeaDirective(task())).not.toContain("HIDDEN"); expect(mlrIdeaDirective(task())).not.toContain("synthetic_task");
    expect(mlrIdeaDirective(task())).toContain(task().task_description);
    for (const value of [null, { ...task(), task_id: "7" }, { ...task(), task_description: {} }, { ...task(), task_description: "" }]) expect(() => projectMlrTask(value)).toThrow();
    expect(MLR_PROVENANCE.datasetLicense).toBe("MIT"); expect(MLR_PROVENANCE.stage).toBe("Idea Generation");
  });
  test("metadata-only selection excludes prior/dev IDs before content or output access", () => {
    const metadata = [1, 2, 3, 4].map(task_id => ({ task_id, task_name: `synthetic-${task_id}`, get task_description(): never { throw new Error("must not inspect content"); }, get result(): never { throw new Error("must not inspect output"); } }));
    const options = { priorIds: [1], devIds: [2], count: 2, seed: "synthetic-selection", sourceRevision: "f".repeat(40) };
    const selected = selectMlrTasks(metadata, options);
    expect(selected).toEqual(selectMlrTasks([...metadata].reverse(), options)); expect(new Set(selected.selectedIds)).toEqual(new Set([3, 4]));
    expect(selected.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => selectMlrTasks(metadata, { ...options, count: 3 })).toThrow();
    expect(() => selectMlrTasks([metadata[0], metadata[0]], options)).toThrow();
    expect(() => selectMlrTasks(metadata, { ...options, sourceRevision: "main" })).toThrow();
  });
  test("directive selects exploratory research through checkpoint, not direct implementation", () => {
    const workflow = planWorkflow(mlrIdeaDirective(task()), { adaptive: true }), execution = compileWorkflow(workflow, { through: "checkpoint", autonomous: true });
    expect(workflow.strategy).toEqual({ mode: "exploratory", research: "broad" }); expect(execution.phases).toEqual(["frame", "discover", "ideate", "checkpoint"]);
    expect(() => assertMlrWorkflow(planWorkflow("Create a dependency-free CSV CLI. No research.", { adaptive: true }), execution)).toThrow();
    expect(() => assertMlrWorkflow(workflow, compileWorkflow(workflow, { through: "build", autonomous: true }))).toThrow();
  });
  test("one genuine selected checkpoint idea is delivered without a three-shortlist oracle", () => {
    const snapshot = nativeFixture(), result = selectNativeMlrIdea(snapshot); expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error("fixture must deliver");
    expect(result.judgeText).toBe(snapshot.artifacts["r1-i1-1"]!.renderedText);
    expect(result.judgeText).not.toContain("HIDDEN"); expect(result.judgeText).not.toContain("Probability"); expect(result.judgeText).not.toContain("r1-i1-1");
    expect(result.audit.rawDossierText).toBe(snapshot.artifacts["r1-i1-1"]!.rawDossierText); expect(result.qualityScore).toBeNull();
  });
  test("draft IDs, cancellation, source drift and incomplete comparison coverage cannot deliver", () => {
    for (const mutate of [
      (s: NativeMlrSnapshot) => { s.status.chosenIdeaId = undefined; },
      (s: NativeMlrSnapshot) => { s.status.chosenIdeaId = "r1-i9-9"; },
      (s: NativeMlrSnapshot) => { s.status.phase = "ideate"; },
      (s: NativeMlrSnapshot) => { s.cancelled = true; },
      (s: NativeMlrSnapshot) => { s.integrity.sourceAfterSha256 = "b".repeat(64); },
      (s: NativeMlrSnapshot) => { s.integrity.immutableArtifactsPreserved = false; },
      (s: NativeMlrSnapshot) => { s.events = []; },
      (s: NativeMlrSnapshot) => { s.tournament.pop(); },
      (s: NativeMlrSnapshot) => { s.frontier.noveltyEnforced = false; },
    ]) { const snapshot = nativeFixture(); mutate(snapshot); expect(selectNativeMlrIdea(snapshot).delivered).toBe(false); }
  });
  test("render and source content remain bound to checkpoint/tournament hashes", () => {
    for (const mutate of [
      (s: NativeMlrSnapshot) => { s.artifacts["r1-i1-1"]!.renderedText += "Changed after judging"; },
      (s: NativeMlrSnapshot) => { s.artifacts["r1-i1-1"]!.rawDossierText = s.artifacts["r1-i1-1"]!.rawDossierText.replace("bounded index buckets", "unrelated mechanism"); },
      (s: NativeMlrSnapshot) => { s.tournament[0]!.aRenderHash = "0".repeat(64); },
      (s: NativeMlrSnapshot) => { s.artifacts["r1-i1-1"]!.renderVersion = 0; },
      (s: NativeMlrSnapshot) => { s.artifacts["r1-i1-1"]!.dossier.mechanism = "x".repeat(901); },
    ]) { const snapshot = nativeFixture(); mutate(snapshot); expect(selectNativeMlrIdea(snapshot).delivered).toBe(false); }
  });
  test("baseline requires committed idea.md and keeps exact bytes", () => {
    const snapshot = baselineFixture(), result = selectBaselineMlrIdea(snapshot); expect(result.delivered).toBe(true);
    if (result.delivered) expect(result.judgeText).toBe(snapshot.artifact.content);
    expect(selectBaselineMlrIdea({ ...snapshot, completed: false }).delivered).toBe(false);
    expect(selectBaselineMlrIdea({ ...snapshot, artifact: { ...snapshot.artifact, relativePath: "answer.txt" } }).delivered).toBe(false);
    expect(selectBaselineMlrIdea({ ...snapshot, artifact: { ...snapshot.artifact, committed: false } }).delivered).toBe(false);
  });
  test("rubric validates six complete integer scores and preserves independent overall assessment", () => {
    const value = grade(); expect(validateMlrIdeaGrade(value).OverallAssessment.score).toBe(2);
    expect(validateMlrIdeaGrade("```json\n" + JSON.stringify(value) + "\n```")).toEqual(validateMlrIdeaGrade(value));
    for (const score of [0, 11, 7.5, "8", NaN, Infinity]) expect(() => validateMlrIdeaGrade({ ...value, Novelty: { score, justification: "reason" } })).toThrow();
    expect(() => validateMlrIdeaGrade({ ...value, Clarity: { score: 8, justification: "" } })).toThrow();
    expect(() => validateMlrIdeaGrade({ ...value, aggregate: 8 })).toThrow();
    expect(() => validateMlrIdeaGrade({ ...value, OverallAssessment: { score: 2, strengths: "not an array", weaknesses: [] } })).toThrow();
    expect(() => validateMlrIdeaGrade("Preface " + JSON.stringify(value))).toThrow();
  });
  test("external judge packets exclude arm/provenance metadata and require pinned rubric", () => {
    const deliveries = { native: selectNativeMlrIdea(nativeFixture()), singleAgent: selectBaselineMlrIdea(baselineFixture()) };
    const packets = anonymizeMlrDeliveries(task(), deliveries, "frozen-blind-order");
    expect(JSON.stringify(packets.judgePackets)).not.toContain("HIDDEN"); expect(JSON.stringify(packets.judgePackets)).not.toContain("selectedIdeaId");
    expect(packets).toEqual(anonymizeMlrDeliveries(task(), deliveries, "frozen-blind-order"));
    const rubric = "SYNTHETIC OFFLINE RUBRIC FIXTURE, NOT THE OFFICIAL PROMPT";
    const request = mlrJudgeRequest(packets.judgePackets[0]!, { model: "mock-judge", provider: "mock", rubricText: rubric, rubricSha256: hash(rubric), sourceRevision: "f".repeat(40) });
    expect(Object.keys(JSON.parse(request.user)).sort()).toEqual(["research_idea", "task_description"]);
    expect(request.controllerOnly.condition).toContain("adapted"); expect(request.controllerOnly.substitutionsMustBeDisclosed).toBe(true);
    expect(() => mlrJudgeRequest(packets.judgePackets[0]!, { model: "mock", provider: "mock", rubricText: rubric, rubricSha256: "0".repeat(64), sourceRevision: "f".repeat(40) })).toThrow();
    expect(() => anonymizeMlrDeliveries(task(), { ...deliveries, native: { delivered: false, reason: "unfinished", qualityScore: null } }, "seed")).toThrow();
  });
});

test("real native CLI interface visits research, ideation and checkpoint with mocked phases only", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-mlr-route-test-")); initHome(home, { plugAndPlay: true });
  const cfg = defaultConfig(); cfg.routing = { mode: "adaptive" }; cfg.budgets.usd = 25; cfg.budgets.wallSeconds = 1500; saveConfig(home, cfg);
  const phases: string[] = []; let providerCalls = 0; const errors: string[] = [];
  const code = await main(["run", "new", mlrIdeaDirective(task()), "--id", "mlr-mock", "--home", home, "--through", "checkpoint", "--autonomous", "--yes", "--json"], { write: () => {}, error: value => errors.push(value) }, {
    apiKeyFor: async provider => provider === "anthropic" ? "offline-mock" : undefined,
    streamFn: () => { providerCalls++; throw new Error("unexpected provider call"); },
    runFrame: async d => { phases.push("frame"); writeStatus(d.run, { phase: "discover", state: "running" }); return { outcome: "ok" }; },
    runDiscover: async d => { phases.push("discover"); writeStatus(d.run, { phase: "ideate", state: "running" }); return { outcome: "ok" }; },
    runIdeate: async d => { phases.push("ideate"); writeFileSync(d.run.frontier, JSON.stringify({ rawFront: ["mock"], shown: ["mock"] })); writeStatus(d.run, { phase: "ideate", state: "stopped", outcome: { kind: "stopped", stopKind: "rounds" } }); return { outcome: "stopped", stopKind: "rounds" }; },
    runCheckpoint: async d => { phases.push("checkpoint"); writeStatus(d.run, { phase: "form", state: "running", chosenIdeaId: "mock", outcome: undefined }); return { outcome: "ok" }; },
    runForm: async () => { throw new Error("MLR idea stage must not form/build"); },
  });
  expect(errors).toEqual([]); expect(code).toBe(0); expect(phases).toEqual(["frame", "discover", "ideate", "checkpoint"]); expect(providerCalls).toBe(0);
});
