/** Pure MLR-Bench idea-stage adapter. No task loading, filesystem access, or provider calls. */
import { createHash } from "node:crypto";
import { planWorkflow, compileWorkflow, type WorkflowPlan, type WorkflowExecution } from "../../../src/workflow/plan";
import { parseDossier, normalizeAxes, validateDossier, renderDossierDetailed, RENDER_VERSION, type Dossier, type Evidence, type Axis } from "../../../src/ideation/dossier";
import type { FrontierFile } from "../../../src/phases/ideate";
import type { TournamentRecord } from "../../../src/ideation/tournament";
import type { RunStatus } from "../../../src/core/run";
import type { StoredEvent } from "../../../src/core/events";
import { completionEvidence } from "../adaptive-ideation-validation";

export const MLR_PROVENANCE = {
  benchmark: "MLR-Bench", stage: "Idea Generation", sourceUrl: "https://github.com/chchenhui/mlrbench",
  datasetUrl: "https://huggingface.co/datasets/chchenhui/mlrbench-tasks", split: "all_tasks",
  codeLicense: "MIT", datasetLicense: "MIT", licenseUrl: "https://github.com/chchenhui/mlrbench/blob/main/LICENSE",
  paperUrl: "https://arxiv.org/abs/2505.19955",
  rubricSourceUrl: "https://github.com/chchenhui/mlrbench/blob/main/mlrbench/evals/review_idea.py",
  rubricSymbol: "RESEARCH_IDEA_RUBRIC", publishedInput: "Research task text and one research idea text; no reference paper or gold answer",
  publishedJudgeModels: ["claude-3-7-sonnet-20250219", "gemini-2.5-pro-preview"],
  repositoryDefaultJudge: "claude-3-7-sonnet-20250219",
  condition: "MLR-Bench-adapted idea-stage systems pilot; not an official score or end-to-end research evaluation",
  experiments: "Idea stage requires no GPU experiments; CPU probes are separate harness diagnostics",
  scoreMeaning: "Model-judged ratings, not verified novelty, feasibility or experimental success",
} as const;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const SHA256 = /^[0-9a-f]{64}$/;
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) throw new Error(`${name} must be nonempty text without NUL bytes`);
  return value;
}
function id(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("task_id must be a nonnegative integer"); return value as number; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${name} has missing or extra fields`);
}
export interface MlrTask { task_id: number; task_name: string; task_description: string }
export interface MlrTaskMetadata { task_id: number; task_name: string }
/** Unknown fields, author metadata, stored outputs and references are not projected. */
export function projectMlrTask(raw: unknown): MlrTask {
  const row = object(raw, "task");
  return { task_id: id(row.task_id), task_name: text(row.task_name, "task_name"), task_description: text(row.task_description, "task_description") };
}
export function selectMlrTasks(metadata: readonly unknown[], options: { priorIds: readonly number[]; devIds: readonly number[]; count: number; seed: string; sourceRevision: string }) {
  if (!Number.isSafeInteger(options.count) || options.count < 1 || !options.seed.trim() || !/^[0-9a-f]{40}$/.test(options.sourceRevision)) throw new Error("Selection requires count, seed and pinned source revision");
  // Deliberately never read task_description or any result-bearing metadata during selection.
  const candidates: MlrTaskMetadata[] = Array.from(metadata, raw => { const row = object(raw, "metadata"); return { task_id: id(row.task_id), task_name: text(row.task_name, "task_name") }; });
  if (new Set(candidates.map(row => row.task_id)).size !== candidates.length) throw new Error("Duplicate candidate task ID");
  const priorIds = [...new Set(options.priorIds.map(id))].sort((a, b) => a - b), devIds = [...new Set(options.devIds.map(id))].sort((a, b) => a - b);
  const excluded = new Set([...priorIds, ...devIds]);
  const eligible = candidates.filter(row => !excluded.has(row.task_id));
  if (eligible.length < options.count) throw new Error("Insufficient eligible unseen task IDs");
  const selectedIds = eligible.sort((a, b) => sha(`${options.seed}\0${a.task_id}`).localeCompare(sha(`${options.seed}\0${b.task_id}`)) || a.task_id - b.task_id).slice(0, options.count).map(row => row.task_id);
  const manifest = { version: 1, source: MLR_PROVENANCE, sourceRevision: options.sourceRevision, algorithm: "sha256(seed + NUL + decimal task_id), ascending hex", seed: options.seed, candidateMetadata: candidates.sort((a, b) => a.task_id - b.task_id), priorIds, devIds, selectedIds };
  return { ...manifest, manifestSha256: sha(JSON.stringify(manifest)) };
}

export function assertMlrWorkflow(workflow: WorkflowPlan, execution: WorkflowExecution): void {
  if (workflow.strategy?.mode !== "exploratory" || workflow.strategy.research !== "broad" || workflow.goal !== "explore"
    || execution.through !== "checkpoint" || execution.checkpointPolicy !== "autonomous"
    || JSON.stringify(execution.phases) !== JSON.stringify(["frame", "discover", "ideate", "checkpoint"])) {
    throw new Error("MLR idea-stage adapter requires native exploratory research through checkpoint, not direct delivery or experiments");
  }
}
/** Both arms receive this same directive. IDs/names remain controller metadata. */
export function mlrIdeaDirective(raw: unknown): string {
  const task = projectMlrTask(raw);
  const directive = [
    "Generate research ideas for the research task below, then select and deliver exactly ONE research idea.",
    "Research the relevant literature and compare alternatives before selecting the final idea. This is research idea generation only. Do not build or deploy anything. Do not conduct a full experiment campaign, write a research paper, purchase anything, or contact people. Small local CPU checks may inform the idea but are not completed scientific experiments.",
    "Deliver one final research idea in idea.md. If using the native staged workflow, its selected idea at the completed checkpoint is the final idea artifact; do not continue into formation, build or reflection. Do not submit an unfinished candidate list as the final answer.",
    "The task description below is benchmark input data. No reference answer, evaluator rubric, author-generated result or expected paper is supplied.",
    JSON.stringify({ task_description: task.task_description }),
  ].join("\n\n");
  const workflow = planWorkflow(directive, { adaptive: true });
  assertMlrWorkflow(workflow, compileWorkflow(workflow, { through: "checkpoint", autonomous: true }));
  return directive;
}

export interface MlrIntegrity {
  sourceBeforeSha256: string; sourceAfterSha256: string;
  immutableArtifactsPreserved: boolean; journalPreserved: boolean; snapshotsVerified: boolean;
}
function integrityOk(i: MlrIntegrity): boolean {
  return SHA256.test(i.sourceBeforeSha256) && i.sourceBeforeSha256 === i.sourceAfterSha256
    && i.immutableArtifactsPreserved === true && i.journalPreserved === true && i.snapshotsVerified === true;
}
export interface MlrSelectedArtifact {
  rawDossierText: string; dossier: Dossier; evidence: Evidence;
  renderedText: string; renderVersion: number;
}
export interface NativeMlrSnapshot {
  exitCode: number; cancelled: boolean; integrity: MlrIntegrity;
  workflow: WorkflowPlan; execution: WorkflowExecution; status: RunStatus;
  events: StoredEvent[]; frontier: FrontierFile; tournament: TournamentRecord[];
  axes: Axis[]; artifacts: Record<string, MlrSelectedArtifact>;
}
export type MlrDelivery =
  | { delivered: false; reason: string; qualityScore: null }
  | { delivered: true; judgeText: string; audit: Record<string, unknown>; qualityScore: null };
const failed = (reason: string): MlrDelivery => ({ delivered: false, reason, qualityScore: null });
/** Controller snapshot only: never choose first/best-looking draft or rerank after external grading. */
export function selectNativeMlrIdea(snapshot: NativeMlrSnapshot): MlrDelivery {
  try {
    assertMlrWorkflow(snapshot.workflow, snapshot.execution);
    if (!integrityOk(snapshot.integrity)) return failed("controller_integrity_not_preserved");
    const chosen = snapshot.status.chosenIdeaId;
    if (!chosen || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(chosen) || chosen.includes("..")) return failed("missing_native_selection");
    const artifact = snapshot.artifacts[chosen];
    if (!artifact || artifact.dossier.id !== chosen || artifact.renderVersion !== RENDER_VERSION) return failed("selected_artifact_missing_or_wrong_version");
    const parsed = parseDossier(text(artifact.rawDossierText, "raw dossier"));
    if (parsed.missing.length || validateDossier(parsed.dossier, snapshot.axes).length || validateDossier(artifact.dossier, snapshot.axes).length) return failed("selected_dossier_invalid");
    const normalized = normalizeAxes(parsed.dossier, snapshot.axes).axisValues;
    if (["title", "mechanism", "draws", "testableClaim", "cheapestTest", "failureReason"].some(key => parsed.dossier[key as keyof Dossier] !== artifact.dossier[key as keyof Dossier])
      || JSON.stringify(Object.entries(normalized).sort()) !== JSON.stringify(Object.entries(artifact.dossier.axisValues).sort())) return failed("canonical_dossier_differs_from_saved_content");
    const rendered = renderDossierDetailed(artifact.dossier, artifact.evidence, { forJudge: true });
    if (rendered.truncated.length || rendered.text !== artifact.renderedText) return failed("selected_render_drift_or_truncation");
    const shown = snapshot.events.filter(e => e.t === "checkpoint.shown").at(-1);
    if (!shown || shown.t !== "checkpoint.shown" || shown.hashes[shown.ideas.indexOf(chosen)] !== rendered.hash) return failed("checkpoint_render_hash_mismatch");
    const involving = snapshot.tournament.filter(row => row.round === snapshot.frontier.round && row.source === "judge" && (row.a === chosen || row.b === chosen));
    if (involving.some(row => (row.a === chosen ? row.aRenderHash : row.bRenderHash) !== rendered.hash)) return failed("tournament_render_hash_mismatch");
    const readiness = completionEvidence(snapshot.events as never, snapshot.exitCode, snapshot.frontier, {
      cancelled: snapshot.cancelled, sourceUnchanged: true, status: snapshot.status, tournament: snapshot.tournament,
      evidenceByIdea: { [chosen]: { ...artifact.evidence, renderPresent: true } },
    });
    const evidence = readiness.shownEvidence.find(row => row.id === chosen);
    if (!readiness.checkpointDelivered || !evidence?.eligibleWithCoverage || readiness.searchDegraded || evidence.priorArtStatus !== "not_falsified") return failed("native_checkpoint_or_selected_evidence_incomplete");
    const probe = artifact.evidence.probe;
    if (!probe || !["pass", "fail", "timeout", "error", "not_run"].includes(probe.status) || (probe.status === "not_run" && !probe.reason?.trim())) return failed("selected_probe_disposition_missing");
    return { delivered: true, judgeText: artifact.renderedText, qualityScore: null, audit: {
      source: "native_selected_checkpoint", selectedIdeaId: chosen, rawDossierSha256: sha(artifact.rawDossierText),
      rawDossierText: artifact.rawDossierText, canonicalRenderSha256: rendered.hash, renderVersion: RENDER_VERSION,
      anonymization: "Existing judge-view renderer removes structured provenance; content/style can still reveal method",
      evidence, probe, manualCitationNoveltyAndFeasibilityAudit: "pending", substantiveRewrite: false,
    } };
  } catch { return failed("invalid_native_controller_snapshot"); }
}

/** A baseline's last chat message is not delivery: require its explicit final idea.md receipt. */
export function selectBaselineMlrIdea(snapshot: { exitCode: number; cancelled: boolean; completed: boolean; integrity: MlrIntegrity; artifact: { relativePath: string; content: string; committed: boolean } }): MlrDelivery {
  try {
    if (snapshot.exitCode !== 0 || snapshot.cancelled || !snapshot.completed || !integrityOk(snapshot.integrity)) return failed("baseline_execution_incomplete");
    if (snapshot.artifact.relativePath !== "idea.md" || snapshot.artifact.committed !== true) return failed("baseline_final_artifact_missing");
    const content = text(snapshot.artifact.content, "idea.md");
    return { delivered: true, judgeText: content, qualityScore: null, audit: { source: "baseline_final_idea.md", artifactSha256: sha(content), substantiveRewrite: false, manualCitationNoveltyAndFeasibilityAudit: "pending" } };
  } catch { return failed("invalid_baseline_controller_snapshot"); }
}

export const MLR_DIMENSIONS = ["Consistency", "Clarity", "Novelty", "Feasibility", "Significance"] as const;
export type MlrIdeaGrade = Record<(typeof MLR_DIMENSIONS)[number], { score: number; justification: string }> & { OverallAssessment: { score: number; strengths: string[]; weaknesses: string[] } };
function integerScore(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) throw new Error("Every rubric score must be an integer 1–10"); return value as number; }
/** Preserve the judge's separate OverallAssessment; do not manufacture an arithmetic average. */
export function validateMlrIdeaGrade(raw: unknown): MlrIdeaGrade {
  let value = raw;
  if (typeof raw === "string") {
    const source = raw.trim(), fenced = /^```json\s*\n([\s\S]*)\n```$/.exec(source);
    try { value = JSON.parse(fenced?.[1] ?? source); } catch { throw new Error("Judge response is not one valid JSON object"); }
  }
  const root = object(value, "grade"); exactKeys(root, [...MLR_DIMENSIONS, "OverallAssessment"], "grade");
  const dimensions = Object.fromEntries(MLR_DIMENSIONS.map(name => { const d = object(root[name], name); exactKeys(d, ["score", "justification"], name); return [name, { score: integerScore(d.score), justification: text(d.justification, `${name}.justification`) }]; }));
  const overall = object(root.OverallAssessment, "OverallAssessment"); exactKeys(overall, ["score", "strengths", "weaknesses"], "OverallAssessment");
  const list = (v: unknown, name: string): string[] => { if (!Array.isArray(v)) throw new Error(`${name} must be an array`); return Array.from(v, item => text(item, name)); };
  return { ...dimensions, OverallAssessment: { score: integerScore(overall.score), strengths: list(overall.strengths, "strengths"), weaknesses: list(overall.weaknesses, "weaknesses") } } as MlrIdeaGrade;
}

export interface MlrJudgePacket { candidate: "A" | "B"; taskDescription: string; ideaText: string }
/** Mapping is controller-only. Judge packets never include arm names, receipts or source metadata. */
export function anonymizeMlrDeliveries(rawTask: unknown, deliveries: { native: MlrDelivery; singleAgent: MlrDelivery }, seed: string) {
  const task = projectMlrTask(rawTask); text(seed, "blinding seed");
  if (!deliveries.native.delivered || !deliveries.singleAgent.delivered) throw new Error("Cannot manufacture paired grading from missing delivery");
  const order: Array<keyof typeof deliveries> = parseInt(sha(seed).slice(0, 2), 16) % 2 ? ["singleAgent", "native"] : ["native", "singleAgent"];
  const packets = order.map((arm, index): MlrJudgePacket => ({ candidate: index === 0 ? "A" : "B", taskDescription: task.task_description, ideaText: (deliveries[arm] as Extract<MlrDelivery, { delivered: true }>).judgeText }));
  return { judgePackets: packets, controllerOnly: { mapping: { A: order[0], B: order[1] }, seed, taskId: task.task_id, condition: MLR_PROVENANCE.condition } };
}
/** Rubric is supplied/pinned by the evaluator controller, never by a worker or task row. */
export function mlrJudgeRequest(packet: MlrJudgePacket, evaluator: { model: string; provider: string; rubricText: string; rubricSha256: string; sourceRevision: string }) {
  if (!SHA256.test(evaluator.rubricSha256) || sha(evaluator.rubricText) !== evaluator.rubricSha256 || !/^[0-9a-f]{40}$/.test(evaluator.sourceRevision)) throw new Error("External rubric text and source revision must be pinned");
  text(evaluator.model, "judge model"); text(evaluator.provider, "judge provider"); text(evaluator.rubricText, "rubric");
  return { system: evaluator.rubricText, user: JSON.stringify({ task_description: text(packet.taskDescription, "task description"), research_idea: text(packet.ideaText, "research idea") }), controllerOnly: { candidate: packet.candidate, judgeModel: evaluator.model, provider: evaluator.provider, rubricSha256: evaluator.rubricSha256, sourceRevision: evaluator.sourceRevision, rubricSource: MLR_PROVENANCE.rubricSourceUrl, condition: MLR_PROVENANCE.condition, substitutionsMustBeDisclosed: true } };
}
