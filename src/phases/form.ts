import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { brainTools, type ExitKind, type ToolContext } from "../brain/tools";
import { RealGitRunner, type GitRunner } from "../build/git";
import { effectiveReflectReserveUsd, phaseAvailableUsd, spentByPhase } from "../core/budget";
import type { StoredEvent } from "../core/events";
import { classifyFailure } from "../core/failure";
import { acquireRunLock } from "../core/lock";
import { writeAtomic } from "../core/paths";
import { hashInput, type RunRecord } from "../core/record";
import { readStatus, writeStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { parseDossier, renderDossier, validateDossier, type Dossier, type Evidence } from "../ideation/dossier";
import { effortFor, NoModelError } from "../providers/models";
import { bindingItems, CritiqueRunError, runCritique, type Critique } from "../formation/critique";
import { formationExecutionEvidence } from "../formation/execution-evidence";
import { assignIds, derivedCaps, parseFeatures, validateFeatures, type FeaturesFile } from "../formation/features";
import { formationApprovalPath, freeze, verifyFormationApproval, writeFormationApproval } from "../formation/freeze";
import { verifyAcceptanceLock, type AcceptanceLock } from "../formation/lock";
import { materializeProjectPath, projectPaths, readProjectMarker, writeProjectMarker, type ProjectPaths } from "../formation/paths";
import { parseSpec, SPEC_SECTIONS, validateSpec, type ParsedSpec } from "../formation/spec";
import { runCheckpoint, type CheckpointIo } from "./checkpoint";
import { parseBrief, stopFailure, type PhaseDeps, type PhaseResult } from "./frame";
import { assertShapeFrozen } from "./guards";
import { runValidatedFile, type Promptable } from "./shared";

export interface FormDeps extends PhaseDeps {
  git?: GitRunner;
  onApprovalStep?: () => void;
  onFormStage?: (stage: "initial" | "first_critique" | "revised" | "second_critique" | "third_critique") => void;
  onFreezeStep?: (step: number) => void;
}
export interface FormOptions { out?: string; force?: boolean; io?: CheckpointIo }

interface Candidate<T> { value?: T; problems: string[] }

interface FormationSnapshot {
  spec: string;
  features: FeaturesFile;
  init: string;
  hash: string;
}

interface FormationProgress {
  version: 1;
  ideaId: string;
  attempt: number;
  stage: "initial" | "revised";
  snapshot: FormationSnapshot;
  /** Journal length immediately before this transaction's first critic dispatch. */
  eventOffset: number;
  firstCriticTurns?: number;
  /** Review cycles overlap: the preceding final review becomes the next repair's input. */
  cycle?: number;
  nextReviewOffset?: number;
  history?: FormationSnapshot[];
}

export function lastChosenIdea(record: RunRecord): string | undefined {
  return record.read().flatMap((event) => event.t === "checkpoint.decision" && (event.kind === "pick" || event.kind === "autonomous_pick") && event.id ? [event.id] : []).at(-1);
}

function formationProgressPath(deps: Pick<PhaseDeps, "run">): string {
  return join(deps.run.dir, "formation.progress.json");
}

function clearFormationProgress(deps: Pick<PhaseDeps, "run">): void {
  rmSync(formationProgressPath(deps), { force: true });
}

function snapshotHash(snapshot: Omit<FormationSnapshot, "hash">): string {
  return hashInput(snapshot);
}

function writeFormationProgress(
  deps: Pick<PhaseDeps, "run" | "record">,
  ideaId: string,
  attempt: number,
  stage: FormationProgress["stage"],
  snapshot: Omit<FormationSnapshot, "hash">,
  eventOffset: number,
  firstCriticTurns?: number,
  previous?: FormationProgress,
): FormationProgress {
  const progress: FormationProgress = {
    version: 1, ideaId, attempt, stage,
    snapshot: { ...snapshot, hash: snapshotHash(snapshot) },
    eventOffset,
    ...(firstCriticTurns === undefined ? {} : { firstCriticTurns }),
    cycle: previous?.cycle ?? 1,
    ...(stage === "revised" ? { nextReviewOffset: deps.record.read().length } : {}),
    history: previous ? [...(previous.history ?? []), previous.snapshot] : [],
  };
  writeAtomic(formationProgressPath(deps), `${JSON.stringify(progress, null, 2)}\n`);
  return progress;
}

function readFormationProgress(deps: PhaseDeps, ideaId: string, attempt: number): FormationProgress | undefined {
  const path = formationProgressPath(deps);
  try {
    if (!lstatSync(path).isFile()) throw new Error("integrity: formation progress must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`integrity: cannot read formation progress: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("integrity: formation progress is malformed");
  const progress = value as Partial<FormationProgress>;
  if (progress.version !== 1 || progress.ideaId !== ideaId || progress.attempt !== attempt || (progress.stage !== "initial" && progress.stage !== "revised")) {
    throw new Error("integrity: formation progress identity or stage mismatch");
  }
  if (!Number.isInteger(progress.eventOffset) || progress.eventOffset! < 0 || progress.eventOffset! > deps.record.read().length) {
    throw new Error("integrity: formation progress journal offset is invalid");
  }
  if (progress.cycle !== undefined && (!Number.isInteger(progress.cycle) || progress.cycle < 1 || progress.cycle > 2)) {
    throw new Error("integrity: formation repair cycle is invalid");
  }
  if (progress.nextReviewOffset !== undefined && (!Number.isInteger(progress.nextReviewOffset)
    || progress.nextReviewOffset < progress.eventOffset! || progress.nextReviewOffset > deps.record.read().length)) {
    throw new Error("integrity: formation review offset is invalid");
  }
  const snapshot = progress.snapshot;
  if (!snapshot || typeof snapshot.spec !== "string" || typeof snapshot.init !== "string" || !snapshot.features || typeof snapshot.hash !== "string") {
    throw new Error("integrity: formation progress snapshot is malformed");
  }
  const expected = snapshotHash({ spec: snapshot.spec, features: snapshot.features, init: snapshot.init });
  if (snapshot.hash !== expected) throw new Error("integrity: formation progress snapshot hash mismatch");
  const spec = specCandidate(snapshot.spec);
  const init = initCandidate(snapshot.init);
  const ids = Array.isArray(snapshot.features.features)
    ? snapshot.features.features.map((_, index) => `f${String(index + 1).padStart(2, "0")}`)
    : [];
  const feature = featureCandidate(JSON.stringify(snapshot.features), spec.value ?? parseSpec(""), deps, ids);
  const problems = [...spec.problems, ...init.problems, ...feature.problems];
  if (problems.length > 0 || !feature.value) throw new Error(`integrity: formation progress snapshot is invalid: ${problems.join("; ")}`);
  if (progress.stage === "revised" && (!Number.isInteger(progress.firstCriticTurns) || progress.firstCriticTurns! < 0)) {
    throw new Error("integrity: revised formation progress is missing first critic turn accounting");
  }
  return progress as FormationProgress;
}

function restoreFormationSnapshot(project: ProjectPaths, snapshot: FormationSnapshot): void {
  writeAtomic(project.spec, snapshot.spec);
  writeAtomic(project.featuresMirror, `${JSON.stringify(snapshot.features, null, 2)}\n`);
  writeAtomic(project.initSh, snapshot.init);
}

function currentFormationSnapshot(project: ProjectPaths, file: FeaturesFile): Omit<FormationSnapshot, "hash"> {
  return {
    spec: readFileSync(project.spec, "utf8"),
    features: file,
    init: readFileSync(project.initSh, "utf8"),
  };
}

function attemptEvents(record: RunRecord, ideaId: string, attempt: number): StoredEvent[] {
  const events = record.read();
  const start = events.findLastIndex((event) => event.t === "formation.attempt" && event.ideaId === ideaId && event.attempt === attempt);
  if (start < 0) return [];
  const next = events.findIndex((event, index) => index > start && event.t === "formation.attempt");
  return events.slice(start + 1, next < 0 ? undefined : next);
}

function durableTurns(record: RunRecord, ideaId: string, attempt: number, role: "brain" | "critic"): number {
  return attemptEvents(record, ideaId, attempt).filter((event) => event.t === "turn" && event.phase === "form" && event.role === role).length;
}

function durableTurnsSince(record: RunRecord, eventOffset: number, role: "critic"): number {
  const events = record.read().slice(eventOffset);
  const turns = events.filter((event) => event.t === "turn" && event.phase === "form" && event.role === role).length;
  // A truncated response never completed the review protocol. Keep its usage and turns in
  // the journal, but allow a resumed review after its output allowance is corrected.
  const truncated = events.filter((event) => event.t === "model.call" && event.role === role && event.stopReason === "length").length;
  return Math.max(0, turns - truncated);
}

function reusableCritiques(record: RunRecord, eventOffset: number): Critique[] {
  return record.read().slice(eventOffset).flatMap((event) => {
    if (event.t !== "critique" || (event.stopped !== "done" && event.stopped !== "refused")) return [];
    return [{
      verdict: event.verdict,
      scopeCreep: event.scopeCreep,
      unverifiable: event.unverifiable,
      missing: event.missing,
      crossProvider: event.crossProvider,
      costUsd: event.costUsd,
    }];
  });
}

function featureCandidate(text: string, spec: ParsedSpec, deps: PhaseDeps, expectedIds?: readonly string[]): Candidate<FeaturesFile> {
  try {
    const draft = parseFeatures(text);
    // The first model-authored list is never trusted to assign identity, even when it happens to
    // supply canonical-looking ids. Only the critique revision preserves and checks frozen ids.
    const file = expectedIds ? draft as FeaturesFile : assignIds(draft);
    return { value: file, problems: validateFeatures(file, spec, deps.cfg, expectedIds ? { expectedIds } : {}) };
  } catch (error) {
    return { problems: [(error as Error).message] };
  }
}

function specCandidate(text: string): Candidate<ParsedSpec> {
  const value = parseSpec(text);
  return { value, problems: validateSpec(value) };
}

function initCandidate(text: string): Candidate<string> {
  const problems: string[] = [];
  if (text.trim() === "") problems.push("init.sh must not be empty");
  else if (!text.startsWith("#!")) problems.push("init.sh must begin with #!");
  return { value: text, problems };
}

async function ensureFile<T>(options: {
  brain: Promptable; path: string; parse: (text: string) => Candidate<T>; prompt: string;
  charge: (result: BrainResult) => void; halt: (result: BrainResult) => boolean; stopped: (result: BrainResult) => PhaseResult | undefined;
  exit: () => { kind: ExitKind; reasons: string[] } | undefined; label: string;
}): Promise<{ value?: T; result?: PhaseResult }> {
  if (existsSync(options.path)) {
    const current = options.parse(readFileSync(options.path, "utf8"));
    if (current.problems.length === 0) return { value: current.value };
  }
  const checked = await runValidatedFile({
    brain: options.brain, path: options.path, parse: options.parse, validate: (candidate) => candidate.problems,
    prompt: options.prompt,
    fix: (problems, path) => `${path} is not usable:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nRewrite the complete file now.`,
    onResult: options.charge, halt: options.halt,
  });
  const exited = options.exit();
  if (exited) return { result: { outcome: "honest_exit", ...exited } };
  if (checked.problems.length === 0 && checked.parsed?.value !== undefined
    && (checked.result.stopped === "turn_cap" || checked.result.stopped === "usd_cap")) {
    return { value: checked.parsed.value };
  }
  const stop = options.stopped(checked.result);
  if (stop) return { result: stop };
  if (checked.problems.length > 0 || !checked.parsed?.value) {
    return { result: { outcome: "failed", failureClass: "verify", message: `${options.label} is not usable: ${checked.problems.join("; ")}` } };
  }
  return { value: checked.parsed.value };
}

interface InitialBundleInspection { file?: FeaturesFile; problems: string[]; fingerprint: string }
const FORMATION_COMPLETION_CREDIT_USD = 0.75;

function inspectInitialBundle(project: ProjectPaths, deps: PhaseDeps): InitialBundleInspection | undefined {
  if (!existsSync(project.spec) || !existsSync(project.featuresMirror) || !existsSync(project.initSh)) return undefined;
  const specText = readFileSync(project.spec, "utf8");
  const featureText = readFileSync(project.featuresMirror, "utf8");
  const initText = readFileSync(project.initSh, "utf8");
  const fingerprint = hashInput({ specText, featureText, initText });
  try {
    const spec = specCandidate(specText);
    const features = featureCandidate(featureText, spec.value ?? parseSpec(""), deps);
    const init = initCandidate(initText);
    return { file: features.value, problems: [...spec.problems, ...features.problems, ...init.problems], fingerprint };
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)], fingerprint };
  }
}

function validInitialBundle(project: ProjectPaths, deps: PhaseDeps): FeaturesFile | undefined {
  const inspected = inspectInitialBundle(project, deps);
  return inspected?.problems.length === 0 ? inspected.file : undefined;
}

function repairableInitialBundle(project: ProjectPaths, deps: PhaseDeps): FeaturesFile | undefined {
  const inspected = inspectInitialBundle(project, deps);
  if (!inspected?.file) return undefined;
  const spec = parseSpec(readFileSync(project.spec, "utf8"));
  const featureProblems = featureCandidate(readFileSync(project.featuresMirror, "utf8"), spec, deps).problems;
  const initProblems = initCandidate(readFileSync(project.initSh, "utf8")).problems;
  return spec.missing.length === 0 && featureProblems.length === 0 && initProblems.length === 0 ? inspected.file : undefined;
}

/** Borrow only after a complete saved bundle exists, preserving expected build work and reflect's reserve. */
function resumableFormationCeiling(deps: PhaseDeps, baseCeiling: number, file: FeaturesFile | undefined, completingRevision = false): number {
  if (!file) return baseCeiling;
  const globallyRemaining = Math.max(0, deps.cfg.budgets.usd - deps.record.costUsd());
  const protectedBuild = file.features.length * deps.cfg.build.expectedAttemptUsd;
  const downstreamHeadroom = Math.max(0, globallyRemaining - effectiveReflectReserveUsd(deps.cfg.budgets) - protectedBuild);
  // A validated interrupted revision gets one small finalization window even when conservative
  // expected build costs consume the remaining plan. The total target is unchanged, and the
  // revision's mechanical gate plus mandatory second critic bound what can use this credit.
  const completionHeadroom = completingRevision
    ? Math.min(FORMATION_COMPLETION_CREDIT_USD, Math.max(0, globallyRemaining - effectiveReflectReserveUsd(deps.cfg.budgets)))
    : 0;
  return Math.max(baseCeiling, downstreamHeadroom, completionHeadroom);
}

function revisionMarker(record: RunRecord, ideaId: string, attempt: number, after: number): boolean {
  return record.read().slice(after).some((event) => event.t === "formation.revision" && event.ideaId === ideaId && event.attempt === attempt);
}

function changedRevisionArtifacts(project: ProjectPaths, baseline: FormationSnapshot): Set<string> {
  const changed = new Set<string>();
  if (existsSync(project.spec) && readFileSync(project.spec, "utf8") !== baseline.spec) changed.add(resolve(project.spec));
  if (existsSync(project.initSh) && readFileSync(project.initSh, "utf8") !== baseline.init) changed.add(resolve(project.initSh));
  if (existsSync(project.featuresMirror)) {
    try {
      const current = assignIds(parseFeatures(readFileSync(project.featuresMirror, "utf8")));
      if (hashInput(current) !== hashInput(baseline.features)) changed.add(resolve(project.featuresMirror));
    } catch {
      changed.add(resolve(project.featuresMirror));
    }
  }
  return changed;
}

function revisionTargets(critique: Critique, project: ProjectPaths): Set<string> {
  const targets = new Set<string>();
  for (const item of [...critique.scopeCreep, ...critique.unverifiable, ...critique.missing]) {
    const text = item.text.toLowerCase();
    if (item.featureId?.startsWith("f") || /feature|acceptance|readme/.test(text)) targets.add(resolve(project.featuresMirror));
    if (item.featureId === "global" || /specification|spec\.md|milestone|scope|non-goal/.test(text)) targets.add(resolve(project.spec));
    if (/init\.sh|initiali[sz]/.test(text)) targets.add(resolve(project.initSh));
  }
  return targets;
}

function revisionRequirementsMet(required: ReadonlySet<string>, changed: ReadonlySet<string>): boolean {
  return required.size > 0 ? [...required].every((path) => changed.has(path)) : changed.size > 0;
}

function evidenceForFormation(path: string): Evidence {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`integrity: cannot read chosen-idea evidence: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("integrity: chosen-idea evidence must be an object");
  const evidence = value as Record<string, unknown>;
  if (evidence.status !== "active" && evidence.status !== "unranked" && evidence.status !== "rejected") {
    throw new Error("integrity: chosen-idea evidence has an invalid status");
  }
  if (evidence.status === "rejected") throw new Error("integrity: a rejected idea cannot enter formation");
  if (evidence.parents !== undefined && (!Array.isArray(evidence.parents) || evidence.parents.some((item) => typeof item !== "string"))) {
    throw new Error("integrity: chosen-idea evidence parents must be a string array");
  }
  const priorArt = evidence.priorArt;
  if (priorArt !== undefined) {
    if (!priorArt || typeof priorArt !== "object" || Array.isArray(priorArt)) throw new Error("integrity: chosen-idea prior-art evidence must be an object");
    const prior = priorArt as Record<string, unknown>;
    if (prior.status !== "collided" && prior.status !== "not_falsified" && prior.status !== "search_failed") {
      throw new Error("integrity: chosen-idea prior-art evidence has an invalid status");
    }
    if (prior.distance !== undefined && typeof prior.distance !== "string") throw new Error("integrity: chosen-idea prior-art distance must be text");
    if (prior.artifact !== undefined) {
      if (!prior.artifact || typeof prior.artifact !== "object" || Array.isArray(prior.artifact)) throw new Error("integrity: chosen-idea prior-art artifact must be an object");
      const artifact = prior.artifact as Record<string, unknown>;
      if (typeof artifact.title !== "string" || artifact.title.trim() === "" || typeof artifact.url !== "string" || artifact.url.trim() === "") {
        throw new Error("integrity: chosen-idea prior-art artifact requires title and url");
      }
    }
  }
  const probe = evidence.probe;
  if (probe !== undefined) {
    if (!probe || typeof probe !== "object" || Array.isArray(probe)) throw new Error("integrity: chosen-idea probe evidence must be an object");
    const item = probe as Record<string, unknown>;
    if (!["pass", "fail", "timeout", "error", "not_run"].includes(String(item.status))) {
      throw new Error("integrity: chosen-idea probe evidence has an invalid status");
    }
    for (const key of ["reason", "stdoutTail"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") throw new Error(`integrity: chosen-idea probe ${key} must be text`);
    }
    for (const key of ["exitCode", "durationMs"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isFinite(item[key]))) {
        throw new Error(`integrity: chosen-idea probe ${key} must be finite`);
      }
    }
  }
  return evidence as unknown as Evidence;
}

function ideaContext(deps: PhaseDeps, ideaId: string, brief: ReturnType<typeof parseBrief>): string {
  const ideaPath = join(deps.run.ideasDir, `${ideaId}.md`);
  const evidencePath = join(deps.run.ideasDir, `${ideaId}.evidence.json`);
  let source: string;
  try { source = readFileSync(ideaPath, "utf8"); }
  catch (error) { throw new Error(`integrity: cannot read chosen idea: ${(error as Error).message}`); }
  const parsed = parseDossier(source);
  const problems = validateDossier(parsed.dossier, brief.axes);
  if (problems.length > 0) throw new Error(`integrity: chosen idea is invalid: ${problems.join("; ")}`);
  const evidence = evidenceForFormation(evidencePath);
  const dossier: Dossier = {
    id: ideaId, title: parsed.dossier.title!, mechanism: parsed.dossier.mechanism!, draws: parsed.dossier.draws!,
    axisValues: parsed.dossier.axisValues!, testableClaim: parsed.dossier.testableClaim!, cheapestTest: parsed.dossier.cheapestTest!,
    failureReason: parsed.dossier.failureReason!, parents: evidence.parents ?? [], vsProbability: parsed.dossier.vsProbability,
  };
  return renderDossier(dossier, evidence, { forJudge: false });
}

function critiqueBrief(brief: ReturnType<typeof parseBrief>): string {
  return ["## Constraints", brief.sections.Constraints ?? "", "## Non-goals", brief.sections["Non-goals"] ?? ""].join("\n");
}

function formPinned(
  project: ProjectPaths,
  brief: ReturnType<typeof parseBrief>,
  dossier: string,
  _turnCap: number,
  ideaPath: string,
  evidencePath: string,
  minFeatures: number,
  maxFeatures: number,
  direct?: { seedPath: string; seed: string; briefPath: string; brief: string },
): string {
  const pinned = [
    "Phase: form. Produce the complete first milestone, not later aspirations.",
    `Write ${project.spec}, ${project.featuresMirror}, and ${project.initSh} in that order.`,
    `spec.md requires these ## sections: ${SPEC_SECTIONS.join(", ")}. Scope and Non-goals each need a '- ' bullet. First milestone must be 1-600 characters.`,
    `The feature JSON is version 1 with init.needs and ${minFeatures}-${maxFeatures} features carrying title, description and one shell/file/manual acceptance. Leave ids to the harness.`,
    "features.json accepts no extra state fields. The first feature and at least one feature overall need a nontrivial shell or safe repo-relative file check; manual checks need concrete instructions.",
    "init.needs and acceptance.needs entries are literal executable names (for example python3 or git; explicit executable paths and environment-variable names are also supported). Never put prose, version constraints, or command arguments in needs. Put descriptive requirements in spec.md and executable version checks in init.sh.",
    "init.sh must be nonempty and begin with #!. Stop once all three artifacts are complete; the harness validates them and independently critiques before freezing.",
    `Source idea: ${ideaPath}. Evidence: ${evidencePath}. Re-reading either costs a turn.`,
    "## Constraints", brief.sections.Constraints ?? "", "## Non-goals", brief.sections["Non-goals"] ?? "",
    "## Search success", brief.sections["Search success"] ?? "", "## Chosen idea", dossier,
  ];
  if (direct) pinned.push(
    `This is a direct supplied task. The original user request at ${direct.seedPath} is authoritative. The complete framing brief at ${direct.briefPath} is derived context, subordinate to that request; do not narrow the task to the capped dossier summary or treat provisional axes as a competitive ranking.`,
    "Distinguish requested behavior from discretionary implementation choices. Extra API shapes, exact error codes, diagnostic formats, test-method counts, import formatting, and platform/version promises are not additional acceptance requirements unless the user requested them. Keep useful choices provisional; reconcile or remove unsupported extra promises instead of expanding the contract. Preserve every user-required behavior and its executable acceptance checks.",
    "For a small self-contained task, prefer one independently verifiable feature encompassing implementation, tests, and documentation. Add multiple features only when the work has genuinely separable deliverables. Preserve all requested behavior and acceptance checks; do not add unrelated requirements to fill feature slots.",
    "## Original user request", direct.seed,
    "## Complete framing brief", direct.brief,
  );
  return pinned.join("\n\n");
}

function removeGenerated(deps: PhaseDeps, project: ProjectPaths): void {
  for (const path of [
    project.spec, project.featuresMirror, project.initSh, project.lockMirror,
    deps.run.features, deps.run.acceptanceLock, formationApprovalPath(deps), formationProgressPath(deps),
  ]) rmSync(path, { force: true });
  writeStatus(deps.run, { specHash: undefined, relocked: false });
}

function markerFor(deps: PhaseDeps, out?: string) {
  return out ? readProjectMarker(resolve(out)) : readProjectMarker(deps.run.project);
}

function prepareProject(deps: PhaseDeps, ideaId: string, out: string | undefined, force: boolean): ProjectPaths {
  const held = markerFor(deps, out);
  const differs = !held || held.runId !== deps.run.id || held.ideaId !== ideaId;
  if (differs) {
    if (existsSync(deps.run.featureState) && readFileSync(deps.run.featureState).length > 0) {
      throw new Error("integrity: cannot re-form a different project while durable state.jsonl is non-empty");
    }
    // Preflight resolves and adopts the actual target (and may relocate the run-side link under
    // force) without touching its marker. Cleanup therefore always precedes marker replacement.
    const target = materializeProjectPath(deps.run, out, { ideaId: held?.ideaId ?? ideaId, force, deferMarker: true });
    removeGenerated(deps, target);
    writeProjectMarker(target.dir, {
      runId: deps.run.id, ideaId, kilnVersion: held?.kilnVersion ?? "0.1.0", createdAt: new Date().toISOString(),
    });
  }
  return materializeProjectPath(deps.run, out, { ideaId, force });
}

function readAuthoritativeFeatures(path: string): FeaturesFile {
  return parseFeatures(readFileSync(path, "utf8")) as FeaturesFile;
}

function readLock(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`integrity: cannot read acceptance lock: ${(error as Error).message}`); }
}

function formationInputs(deps: PhaseDeps, project: ProjectPaths, featuresPath: string, label: string): { file: FeaturesFile; specHash: string; spec: ParsedSpec } {
  if (!existsSync(project.spec)) throw new Error("integrity: frozen formation is missing spec.md");
  if (!existsSync(project.initSh)) throw new Error("integrity: frozen formation is missing init.sh");
  if (!existsSync(featuresPath)) throw new Error(`integrity: frozen formation is missing ${label}`);
  const specText = readFileSync(project.spec, "utf8"); const spec = specCandidate(specText);
  const init = initCandidate(readFileSync(project.initSh, "utf8"));
  let file: FeaturesFile; let featureProblems: string[];
  try {
    file = readAuthoritativeFeatures(featuresPath);
    const expectedIds = Array.from({ length: file.features.length }, (_, index) => `f${String(index + 1).padStart(2, "0")}`);
    featureProblems = validateFeatures(file, spec.value!, deps.cfg, { expectedIds });
  } catch (error) { throw new Error(`integrity: cannot read authoritative features: ${(error as Error).message}`); }
  const problems = [...spec.problems, ...init.problems, ...featureProblems];
  if (problems.length > 0) throw new Error(`integrity: frozen formation is invalid: ${problems.join("; ")}`);
  return { file, specHash: hashInput(specText), spec: spec.value! };
}

function frozenInputs(deps: PhaseDeps, project: ProjectPaths): { file: FeaturesFile; specHash: string; spec: ParsedSpec } {
  return formationInputs(deps, project, deps.run.features, "authoritative features.json");
}

function approvedInputs(deps: PhaseDeps, project: ProjectPaths): { file: FeaturesFile; specHash: string; spec: ParsedSpec } {
  return formationInputs(deps, project, project.featuresMirror, "approved project features.json");
}

function finalStatus(deps: PhaseDeps, result: PhaseResult, specHash?: string): PhaseResult {
  const outputLimitMessage = result.outcome === "failed" && result.failureClass === "budget" && /output.*limit/i.test(result.message)
    ? result.message : undefined;
  if (outputLimitMessage) {
    deps.record.append({ t: "note", text: outputLimitMessage });
    result = { outcome: "stopped", stopKind: "budget" };
  }
  if (result.outcome === "failed" && result.failureClass === "budget" && result.message === "dollar cap reached in form") {
    result = { outcome: "stopped", stopKind: "budget", budgetTargetUsd: deps.cfg.budgets.usd };
  }
  if (result.outcome === "failed") {
    const last = deps.record.read().at(-1);
    if (!(last?.t === "failure" && last.class === result.failureClass && last.message === result.message)) {
      deps.record.append({ t: "failure", class: result.failureClass, message: result.message });
    }
  }
  deps.record.append({ t: "phase.end", phase: "form", outcome: result.outcome });
  if (result.outcome === "ok") writeStatus(deps.run, { phase: "build", state: "running", outcome: undefined, specHash });
  else if (result.outcome === "honest_exit") writeStatus(deps.run, { state: "done", outcome: { kind: "honest_exit", exitKind: result.kind, reasons: result.reasons } });
  else if (result.outcome === "failed") writeStatus(deps.run, { state: "failed", outcome: { kind: "failure", failureClass: result.failureClass, message: result.message } });
  else writeStatus(deps.run, { state: "stopped", outcome: {
    kind: "stopped", stopKind: result.stopKind,
    budgetTargetUsd: result.budgetTargetUsd, wallTargetSeconds: result.wallTargetSeconds,
    ...(outputLimitMessage ? { message: outputLimitMessage } : {}),
  } });
  return result;
}

async function formIdea(deps: FormDeps, git: GitRunner, ideaId: string, attempt: number, options: FormOptions, ceiling: number, spent: { value: number }): Promise<{ result: PhaseResult; specHash?: string }> {
  const status = readStatus(deps.run);
  const defaultAlreadyMaterialized = existsSync(deps.run.project) && !lstatSync(deps.run.project).isSymbolicLink();
  let recoveredOut: string | undefined;
  if (!defaultAlreadyMaterialized && existsSync(deps.run.project) && lstatSync(deps.run.project).isSymbolicLink()) {
    try { recoveredOut = realpathSync(deps.run.project); } catch { /* materialization reports the dangling link */ }
  }
  const out = options.out ?? (defaultAlreadyMaterialized ? undefined : status.projectDir ?? recoveredOut);
  const project = prepareProject(deps, ideaId, out, options.force === true);
  writeStatus(deps.run, { projectDir: realpathSync(project.dir), chosenIdeaId: ideaId });

  if (existsSync(deps.run.features)) {
    const frozen = frozenInputs(deps, project);
    if (!existsSync(deps.run.acceptanceLock)) {
      verifyFormationApproval(deps, ideaId, frozen.file, frozen.specHash);
      await freeze(deps, frozen.file, frozen.specHash, git, { afterStep: deps.onFreezeStep });
      return { result: { outcome: "ok" }, specHash: frozen.specHash };
    }
    let held: unknown; let verified: ReturnType<typeof verifyAcceptanceLock>;
    try {
      held = readLock(deps.run.acceptanceLock);
      verified = verifyAcceptanceLock(frozen.file, held, frozen.specHash);
    } catch (error) { throw new Error(`integrity: cannot verify frozen formation: ${(error as Error).message}`); }
    if (!verified.ok) throw new Error(`integrity: acceptance lock mismatch (${verified.changed.join(", ")})`);
    const lock = held as AcceptanceLock;
    if (verified.specDrift && !deps.record.read().some((event) => event.t === "spec.drift" && event.expected === lock.specHash && event.actual === frozen.specHash)) {
      deps.record.append({ t: "spec.drift", expected: lock.specHash, actual: frozen.specHash });
    }
    await freeze(deps, frozen.file, lock.specHash, git, { afterStep: deps.onFreezeStep });
    return { result: { outcome: "ok" }, specHash: lock.specHash };
  }
  if (existsSync(deps.run.acceptanceLock)) throw new Error("integrity: acceptance lock exists without authoritative features");

  const briefText = readFileSync(deps.run.brief, "utf8"); const brief = parseBrief(briefText);
  if (existsSync(formationApprovalPath(deps))) {
    const approved = approvedInputs(deps, project);
    verifyFormationApproval(deps, ideaId, approved.file, approved.specHash);
    await freeze(deps, approved.file, approved.specHash, git, { afterStep: deps.onFreezeStep });
    return { result: { outcome: "ok" }, specHash: approved.specHash };
  }
  const dossier = ideaContext(deps, ideaId, brief);
  let progress = readFormationProgress(deps, ideaId, attempt);
  let resumedPartialRevision = false;
  if (progress) {
    const current = validInitialBundle(project, deps);
    resumedPartialRevision = progress.stage === "initial" && current !== undefined
      && revisionMarker(deps.record, ideaId, attempt, progress.eventOffset)
      && snapshotHash(currentFormationSnapshot(project, current)) !== progress.snapshot.hash;
    if (!resumedPartialRevision) restoreFormationSnapshot(project, progress.snapshot);
  }
  const formationCeiling = resumableFormationCeiling(deps, ceiling, repairableInitialBundle(project, deps), resumedPartialRevision);
  let declared: { kind: ExitKind; reasons: string[] } | undefined;
  const takeExit = () => declared;
  let autoCompleteInitial = true;
  let revisionBaseline: FormationSnapshot | undefined;
  let requiredRevisionTargets: Set<string> | undefined;
  const ctx: ToolContext = {
    cwd: project.dir, roots: [project.dir], run: deps.run, record: deps.record, fetchImpl: deps.fetchImpl,
    protectedPaths: [project.projectJson], protectedDirs: [project.checksDir, project.blockedDir], allowedExitKinds: ["not_formable"],
    onExit: (kind, reasons) => { declared = { kind, reasons }; },
  };
  const brainSeat = deps.models("brain");
  const caps = derivedCaps(deps.cfg);
  let lastInvalidBundle: string | undefined;
  let brain!: ReturnType<typeof createBrain>;
  brain = createBrain({
    model: brainSeat.model, getApiKey: () => deps.apiKeyFor(String(brainSeat.model.provider)), tools: brainTools(ctx, "form"),
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "brain"), `## Playbook (form)\n${playbookSection(loadPlaybook(deps.home), "form")}`],
    pinned: formPinned(
      project, brief, dossier, deps.cfg.budgets.turns.form,
      join(deps.run.ideasDir, `${ideaId}.md`), join(deps.run.ideasDir, `${ideaId}.evidence.json`),
      deps.cfg.build.minFeatures, caps.maxFeatures,
      ideaId === "supplied-task" ? {
        seedPath: deps.run.seed, seed: readFileSync(deps.run.seed, "utf8"),
        briefPath: deps.run.brief, brief: briefText,
      } : undefined,
    ), record: deps.record, role: "brain", phase: "form",
    turnCap: deps.cfg.budgets.turns.form,
    priorTurns: () => durableTurns(deps.record, ideaId, attempt, "brain"),
    usdCap: formationCeiling, spentUsd: () => spent.value, effort: effortFor(deps.cfg, "brain", brainSeat.model),
    streamFn: deps.streamFn, onText: deps.onText, onTool: deps.onTool,
    afterTool: (event) => {
      if (!event.ok) return false;
      const inspected = inspectInitialBundle(project, deps);
      if (!inspected) return false;
      if (autoCompleteInitial && inspected.problems.length === 0 && inspected.file) return true;
      if (!autoCompleteInitial && revisionBaseline && requiredRevisionTargets && requiredRevisionTargets.size > 0
        && inspected.problems.length === 0 && inspected.file) {
        const changed = changedRevisionArtifacts(project, revisionBaseline);
        if ([...requiredRevisionTargets].every((path) => changed.has(path))) return true;
      }
      if (inspected.problems.length > 0 && inspected.fingerprint !== lastInvalidBundle) {
        lastInvalidBundle = inspected.fingerprint;
        brain.agent.steer({
          role: "user", steering: true, attribution: "user", timestamp: Date.now(),
          content: `Harness validation still fails:\n${inspected.problems.map((problem) => `- ${problem}`).join("\n")}\nCorrect the artifacts now, then stop.`,
        });
      }
      return false;
    },
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const charge = (result: BrainResult) => { spent.value += result.costUsd; };
  const stop = (result: BrainResult) => stopFailure("form", deps.cfg.budgets.turns.form, result);
  const halt = (result: BrainResult) => takeExit() !== undefined || stop(result) !== undefined;

  let initialFile: FeaturesFile;
  if (progress) {
    initialFile = progress.snapshot.features;
  } else {
    const spec = await ensureFile({ brain, path: project.spec, parse: specCandidate, prompt: `Write ${project.spec} now.`, charge, halt, stopped: stop, exit: takeExit, label: "spec.md" });
    if (spec.result) return { result: spec.result };
    const feature = await ensureFile({ brain, path: project.featuresMirror, parse: (text) => featureCandidate(text, spec.value!, deps), prompt: `Write ${project.featuresMirror} now.`, charge, halt, stopped: stop, exit: takeExit, label: "features.json" });
    if (feature.result) return { result: feature.result };
    writeAtomic(project.featuresMirror, `${JSON.stringify(feature.value, null, 2)}\n`);
    const init = await ensureFile({ brain, path: project.initSh, parse: initCandidate, prompt: `Write ${project.initSh} now.`, charge, halt, stopped: stop, exit: takeExit, label: "init.sh" });
    if (init.result) return { result: init.result };
    initialFile = feature.value!;
    progress = writeFormationProgress(deps, ideaId, attempt, "initial", currentFormationSnapshot(project, initialFile), deps.record.read().length);
    deps.onFormStage?.("initial");
    throwIfRunCancelled();
  }
  autoCompleteInitial = false;

  // Three independent reviews at most: initial, after the first repair, and after
  // one additional repair. Dollar and producer turn caps remain shared throughout.
  for (;;) {
    const critique = async (priorTurns: () => number) => runCritique(deps, {
      spec: readFileSync(project.spec, "utf8"), features: readFileSync(project.featuresMirror, "utf8"), dossier,
      brief: critiqueBrief(brief), brainRef: brainSeat.ref, formationCeilingUsd: formationCeiling, spentUsd: () => spent.value, onResult: charge,
      ...(ideaId === "supplied-task" ? { originalRequest: readFileSync(deps.run.seed, "utf8") } : {}),
      executionEvidence: formationExecutionEvidence(attemptEvents(deps.record, ideaId, attempt)),
      priorTurns,
    });
    const progressOffset = progress.eventOffset;
    const priorCritiques = reusableCritiques(deps.record, progressOffset);
    if (progress.stage === "revised" && priorCritiques.length === 0) {
      throw new Error("integrity: revised formation progress has no durable first critique");
    }
    const first = priorCritiques[0] ?? await critique(() => durableTurnsSince(deps.record, progressOffset, "critic"));
    const firstCriticTurns = progress.stage === "revised" ? progress.firstCriticTurns! : durableTurnsSince(deps.record, progressOffset, "critic");
    if ((progress.cycle ?? 1) === 1) deps.onFormStage?.("first_critique");
    throwIfRunCancelled();

    // Newly planned adaptive direct tasks do not rewrite a bundle an independent critic already
    // approved. Bind approval to the exact reviewed snapshot: a changed byte or a durable revision
    // marker must follow the ordinary repair/re-review path and can never borrow this verdict.
    const revisionStarted = revisionMarker(deps.record, ideaId, attempt, progressOffset);
    if (deps.workflow?.directFrame === "deterministic-v1" && ideaId === "supplied-task"
      && progress.stage === "initial" && (progress.cycle ?? 1) === 1 && first.verdict === "ok" && !revisionStarted) {
      const reviewedFile = validInitialBundle(project, deps);
      if (!reviewedFile) throw new Error("integrity: the formation bundle changed or became invalid after its approving critique");
      const current = currentFormationSnapshot(project, reviewedFile);
      const exactBytes = current.spec === progress.snapshot.spec
        && current.init === progress.snapshot.init
        && readFileSync(project.featuresMirror, "utf8") === `${JSON.stringify(progress.snapshot.features, null, 2)}\n`;
      if (!exactBytes || snapshotHash(current) !== progress.snapshot.hash) {
        throw new Error("integrity: the formation bundle changed after its approving critique");
      }
      const finalSpecHash = hashInput(current.spec);
      writeFormationApproval(deps, ideaId, reviewedFile, finalSpecHash);
      deps.onApprovalStep?.();
      throwIfRunCancelled();
      await freeze(deps, reviewedFile, finalSpecHash, git, { afterStep: deps.onFreezeStep });
      return { result: { outcome: "ok" }, specHash: finalSpecHash };
    }

    let revisedFile: FeaturesFile;
    if (progress.stage === "revised") {
      revisedFile = progress.snapshot.features;
    } else {
      if (!resumedPartialRevision) restoreFormationSnapshot(project, progress.snapshot);
      revisionBaseline = progress.snapshot;
      requiredRevisionTargets = revisionTargets(first, project);
      const alreadyChanged = changedRevisionArtifacts(project, progress.snapshot);
      const remainingTargets = [...requiredRevisionTargets].filter((path) => !alreadyChanged.has(path));
      const revision = ["Revise the complete formed project for this review cycle. Preserve every assigned feature id and order.",
        ...(resumedPartialRevision ? ["Resume the interrupted revision from the valid files currently on disk; preserve completed edits and do not restart or reread unchanged work."] : []),
        ...(remainingTargets.length > 0 ? [`Remaining critic-implicated artifacts: ${remainingTargets.join(", ")}. Make their smallest sufficient corrections first.`] : []),
        ...first.scopeCreep.map((item) => `Scope creep${item.featureId ? ` ${item.featureId}` : ""}: ${item.text}`),
        ...first.unverifiable.map((item) => `Unverifiable${item.featureId ? ` ${item.featureId}` : ""}: ${item.text}`),
        ...first.missing.map((item) => `Missing${item.featureId ? ` ${item.featureId}` : ""}: ${item.text}`),
        ...((progress.cycle ?? 1) > 1 ? [`Preserve fixes for all earlier review feedback as well:\n${JSON.stringify(attemptEvents(deps.record, ideaId, attempt).filter((event) => event.t === "critique").map((event) => event.t === "critique" ? { scopeCreep: event.scopeCreep, unverifiable: event.unverifiable, missing: event.missing } : {}))}`] : []),
        `Binding items: ${bindingItems(first, initialFile).join("; ") || "none"}.`, `Rewrite ${project.spec}, ${project.featuresMirror}, and ${project.initSh} as needed.`].join("\n");
      if (!revisionMarker(deps.record, ideaId, attempt, progressOffset)) {
        deps.record.append({ t: "formation.revision", ideaId, attempt });
      }
      const expectedIds = initialFile.features.map((item) => item.id);
      const validateRevision = () => {
        const s = specCandidate(existsSync(project.spec) ? readFileSync(project.spec, "utf8") : "");
        const f = featureCandidate(existsSync(project.featuresMirror) ? readFileSync(project.featuresMirror, "utf8") : "", s.value ?? parseSpec(""), deps, expectedIds);
        const i = initCandidate(existsSync(project.initSh) ? readFileSync(project.initSh, "utf8") : "");
        return { spec: s, features: f, init: i, problems: [...s.problems, ...f.problems, ...i.problems] };
      };
      let revisionResult = await brain.run(revision); charge(revisionResult);
      if (takeExit()) { clearFormationProgress(deps); return { result: { outcome: "honest_exit", ...takeExit()! } }; }
      let revised = validateRevision();
      let halted = stop(revisionResult);
      const requirementsMet = requiredRevisionTargets !== undefined
        && revisionRequirementsMet(requiredRevisionTargets, changedRevisionArtifacts(project, revisionBaseline));
      const validAtCap = revised.problems.length === 0 && revised.features.value !== undefined && requirementsMet
        && (revisionResult.stopped === "turn_cap" || revisionResult.stopped === "usd_cap");
      if (halted && !validAtCap) return { result: halted };
      const revisedExecutable = () => revised.features.value?.features.filter((item) => item && typeof item === "object" && item.acceptance?.type !== "manual").length ?? -1;
      if (revisedExecutable() === 0) {
        const reasons = ["zero executable acceptance checks remain after revision"];
        deps.record.append({ t: "honest_exit", kind: "not_formable", reasons, source: "mechanical" });
        clearFormationProgress(deps);
        return { result: { outcome: "honest_exit", kind: "not_formable", reasons } };
      }
      if (revised.problems.length > 0) {
        revisionResult = await brain.run(`The one revision is invalid:\n${revised.problems.map((problem) => `- ${problem}`).join("\n")}\nCorrect all three files once, preserving ids and order.`); charge(revisionResult);
        if (takeExit()) { clearFormationProgress(deps); return { result: { outcome: "honest_exit", ...takeExit()! } }; }
        revised = validateRevision();
        halted = stop(revisionResult);
        const correctedRequirementsMet = requiredRevisionTargets !== undefined
          && revisionRequirementsMet(requiredRevisionTargets, changedRevisionArtifacts(project, revisionBaseline));
        const correctedValidAtCap = revised.problems.length === 0 && revised.features.value !== undefined && correctedRequirementsMet
          && (revisionResult.stopped === "turn_cap" || revisionResult.stopped === "usd_cap");
        if (halted && !correctedValidAtCap) return { result: halted };
      }
      if (revisedExecutable() === 0) {
        const reasons = ["zero executable acceptance checks remain after revision"];
        deps.record.append({ t: "honest_exit", kind: "not_formable", reasons, source: "mechanical" });
        clearFormationProgress(deps);
        return { result: { outcome: "honest_exit", kind: "not_formable", reasons } };
      }
      if (revised.problems.length > 0 || !revised.features.value) return { result: { outcome: "failed", failureClass: "verify", message: `formation revision is not usable: ${revised.problems.join("; ")}` } };
      revisedFile = revised.features.value;
      writeAtomic(project.featuresMirror, `${JSON.stringify(revisedFile, null, 2)}\n`);
      progress = writeFormationProgress(deps, ideaId, attempt, "revised", currentFormationSnapshot(project, revisedFile), progressOffset, firstCriticTurns, progress);
      deps.onFormStage?.("revised");
      throwIfRunCancelled();
    }

    const currentCritiques = reusableCritiques(deps.record, progressOffset);
    // Older progress files predate explicit review offsets. The completed first
    // review is followed only by producer work before this review's critic turns.
    const secondOffset = progress.nextReviewOffset ?? deps.record.read().findIndex((event, index) =>
      index >= progressOffset && event.t === "critique" && (event.stopped === "done" || event.stopped === "refused")) + 1;
    const priorSecondTurns = () => {
      const total = durableTurnsSince(deps.record, progressOffset, "critic");
      if (total < firstCriticTurns) throw new Error("integrity: critic turn journal is shorter than formation progress");
      return total - firstCriticTurns;
    };
    const second = currentCritiques[1] ?? await critique(priorSecondTurns);
    deps.onFormStage?.((progress.cycle ?? 1) === 1 ? "second_critique" : "third_critique");
    throwIfRunCancelled();
    const executable = revisedFile.features.filter((item) => item.acceptance.type !== "manual").length;
    if (second.verdict === "revise" && executable > 0) {
      if ((progress.cycle ?? 1) >= 2) {
        return { result: { outcome: "failed", failureClass: "budget", message: "Formation reached its three-review repair limit; unresolved feedback and progress are retained. The concept has not been classified as infeasible." } };
      }
      progress = writeFormationProgress(deps, ideaId, attempt, "initial", currentFormationSnapshot(project, revisedFile), secondOffset, undefined,
        { ...progress, cycle: 2 });
      resumedPartialRevision = false;
      continue;
    }
    if (executable === 0) {
      const reasons = [...second.scopeCreep, ...second.unverifiable, ...second.missing].map((item) => item.text);
      if (second.verdict === "revise" && reasons.length === 0) reasons.push("the second critic still requires revision");
      if (executable === 0) reasons.push("zero executable acceptance checks remain after revision");
      deps.record.append({ t: "honest_exit", kind: "not_formable", reasons, source: "mechanical" });
      clearFormationProgress(deps);
      return { result: { outcome: "honest_exit", kind: "not_formable", reasons } };
    }
    const finalSpecHash = hashInput(readFileSync(project.spec, "utf8"));
    writeFormationApproval(deps, ideaId, revisedFile, finalSpecHash);
    deps.onApprovalStep?.();
    throwIfRunCancelled();
    await freeze(deps, revisedFile, finalSpecHash, git, { afterStep: deps.onFreezeStep });
    return { result: { outcome: "ok" }, specHash: finalSpecHash };
  }
}

function frontierAlternative(path: string, excluded: ReadonlySet<string>): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { rawFront?: unknown[]; ideas?: Array<{ id?: unknown }>; ladders?: { value?: unknown[] } };
    const ids = Array.isArray(value.ladders?.value) ? value.ladders!.value : Array.isArray(value.rawFront) ? value.rawFront : value.ideas?.map((item) => item.id) ?? [];
    return ids.some((id) => typeof id === "string" && !excluded.has(id));
  } catch { return false; }
}

export async function runForm(deps: FormDeps, ideaId?: string, options: FormOptions = {}): Promise<PhaseResult> {
  throwIfRunCancelled();
  const heldLock = deps.lockHeld ? undefined : acquireRunLock(deps.run, { force: deps.forceLock });
  try {
    const frozen = assertShapeFrozen(deps); if (frozen) return frozen;
    const initialStatus = readStatus(deps.run);
    let selected = ideaId ?? initialStatus.chosenIdeaId ?? lastChosenIdea(deps.record);
    if (!selected) {
      const result: PhaseResult = { outcome: "failed", failureClass: "verify", message: "formation has no chosen idea" };
      deps.record.append({ t: "failure", class: "verify", message: result.message });
      writeStatus(deps.run, { state: "failed", outcome: { kind: "failure", failureClass: "verify", message: result.message } });
      return result;
    }
    deps.record.append({ t: "phase.start", phase: "form" });
    const ceiling = phaseAvailableUsd(deps.cfg.budgets, "form", spentByPhase(deps.record.read()));
    const spent = { value: 0 }; const git = deps.git ?? new RealGitRunner(); const excluded = new Set<string>();
    const attempts = derivedCaps(deps.cfg).formationAttempts;
    for (let index = 0; index < attempts; index += 1) {
      const priorAttempts = deps.record.read().filter((event) => event.t === "formation.attempt");
      const latestAttempt = priorAttempts.at(-1);
      const heldAttempt = latestAttempt?.ideaId === selected ? latestAttempt.attempt : undefined;
      const attempt = heldAttempt ?? Math.max(0, ...priorAttempts.map((event) => event.attempt)) + 1;
      if (heldAttempt === undefined) deps.record.append({ t: "formation.attempt", ideaId: selected, attempt });
      let formed: { result: PhaseResult; specHash?: string };
      try {
        formed = await formIdea({ ...deps, lockHeld: true }, git, selected, attempt, options, ceiling, spent);
        throwIfRunCancelled();
      }
      catch (error) {
        rethrowIfRunCancelled(error);
        if (error instanceof NoModelError) throw error;
        if (error instanceof CritiqueRunError) {
          const stopped: PhaseResult | undefined = error.result.stopDetails?.type === "output_limit"
            ? { outcome: "failed", failureClass: "budget", message: error.message }
            : stopFailure("form", deps.cfg.budgets.turns.form, error.result);
          formed = { result: stopped ?? { outcome: "failed", failureClass: classifyFailure({ message: error.message }), message: error.message } };
        } else {
          const message = error instanceof Error ? error.message : String(error);
          formed = { result: { outcome: "failed", failureClass: classifyFailure({ error }), message } };
        }
      }
      if (formed.result.outcome !== "honest_exit" || formed.result.kind !== "not_formable") return finalStatus(deps, formed.result, formed.specHash);
      excluded.add(selected);
      if (index + 1 >= attempts || !existsSync(deps.run.frontier) || !frontierAlternative(deps.run.frontier, excluded)) return finalStatus(deps, formed.result);
      const io = options.io ?? { write: () => {}, ask: async () => "" };
      const checkpoint = await runCheckpoint({ ...deps, lockHeld: true }, io, { exclude: [...excluded], autonomous: deps.cfg.autonomous });
      if (checkpoint.outcome !== "ok") return finalStatus(deps, checkpoint);
      const next = readStatus(deps.run).chosenIdeaId;
      if (!next) return finalStatus(deps, formed.result);
      selected = next;
    }
    return finalStatus(deps, { outcome: "failed", failureClass: "verify", message: "formation attempt accounting failed" });
  } finally { heldLock?.release(); }
}
