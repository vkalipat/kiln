import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { brainTools, type ExitKind, type ToolContext } from "../brain/tools";
import { RealGitRunner, type GitRunner } from "../build/git";
import { phaseAvailableUsd, spentByPhase } from "../core/budget";
import { classifyFailure } from "../core/failure";
import { acquireRunLock } from "../core/lock";
import { writeAtomic } from "../core/paths";
import { hashInput, type RunRecord } from "../core/record";
import { readStatus, writeStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { parseDossier, renderDossier, type Dossier, type Evidence } from "../ideation/dossier";
import { effortFor, NoModelError } from "../providers/models";
import { bindingItems, CritiqueRunError, runCritique } from "../formation/critique";
import { assignIds, derivedCaps, parseFeatures, validateFeatures, type FeaturesFile } from "../formation/features";
import { freeze } from "../formation/freeze";
import { verifyAcceptanceLock, type AcceptanceLock } from "../formation/lock";
import { materializeProjectPath, projectPaths, readProjectMarker, writeProjectMarker, type ProjectPaths } from "../formation/paths";
import { parseSpec, validateSpec, type ParsedSpec } from "../formation/spec";
import { runCheckpoint, type CheckpointIo } from "./checkpoint";
import { parseBrief, stopFailure, type PhaseDeps, type PhaseResult } from "./frame";
import { assertShapeFrozen } from "./guards";
import { runValidatedFile, type Promptable } from "./shared";

export interface FormDeps extends PhaseDeps { git?: GitRunner; onFreezeStep?: (step: number) => void }
export interface FormOptions { out?: string; force?: boolean; io?: CheckpointIo }

interface Candidate<T> { value?: T; problems: string[] }

export function lastChosenIdea(record: RunRecord): string | undefined {
  return record.read().flatMap((event) => event.t === "checkpoint.decision" && (event.kind === "pick" || event.kind === "autonomous_pick") && event.id ? [event.id] : []).at(-1);
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
  const stop = options.stopped(checked.result);
  if (stop) return { result: stop };
  if (checked.problems.length > 0 || !checked.parsed?.value) {
    return { result: { outcome: "failed", failureClass: "verify", message: `${options.label} is not usable: ${checked.problems.join("; ")}` } };
  }
  return { value: checked.parsed.value };
}

function ideaContext(deps: PhaseDeps, ideaId: string): string {
  const ideaPath = join(deps.run.ideasDir, `${ideaId}.md`);
  const evidencePath = join(deps.run.ideasDir, `${ideaId}.evidence.json`);
  const parsed = parseDossier(readFileSync(ideaPath, "utf8")).dossier;
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence;
  const dossier: Dossier = {
    id: ideaId, title: parsed.title ?? "", mechanism: parsed.mechanism ?? "", draws: parsed.draws ?? "",
    axisValues: parsed.axisValues ?? {}, testableClaim: parsed.testableClaim ?? "", cheapestTest: parsed.cheapestTest ?? "",
    failureReason: parsed.failureReason ?? "", parents: evidence.parents ?? [], vsProbability: parsed.vsProbability,
  };
  return renderDossier(dossier, evidence, { forJudge: false });
}

function critiqueBrief(brief: ReturnType<typeof parseBrief>): string {
  return ["## Constraints", brief.sections.Constraints ?? "", "## Non-goals", brief.sections["Non-goals"] ?? ""].join("\n");
}

function formPinned(project: ProjectPaths, brief: ReturnType<typeof parseBrief>, dossier: string, _turnCap: number, ideaPath: string, evidencePath: string, minFeatures: number, maxFeatures: number): string {
  return [
    "Phase: form. Produce the complete first milestone, not later aspirations.",
    `Write ${project.spec}, ${project.featuresMirror}, and ${project.initSh} in that order.`,
    `The feature JSON is version 1 with init.needs and ${minFeatures}-${maxFeatures} features carrying title, description and one shell/file/manual acceptance. Leave ids to the harness.`,
    `Source idea: ${ideaPath}. Evidence: ${evidencePath}. Re-reading either costs a turn.`,
    "## Constraints", brief.sections.Constraints ?? "", "## Non-goals", brief.sections["Non-goals"] ?? "",
    "## Search success", brief.sections["Search success"] ?? "", "## Chosen idea", dossier,
  ].join("\n\n");
}

function removeGenerated(deps: PhaseDeps, project: ProjectPaths): void {
  for (const path of [project.spec, project.featuresMirror, project.initSh, project.lockMirror, deps.run.features, deps.run.acceptanceLock]) rmSync(path, { force: true });
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

function frozenInputs(deps: PhaseDeps, project: ProjectPaths): { file: FeaturesFile; specHash: string; spec: ParsedSpec } {
  if (!existsSync(project.spec)) throw new Error("integrity: frozen formation is missing spec.md");
  if (!existsSync(project.initSh)) throw new Error("integrity: frozen formation is missing init.sh");
  if (!existsSync(deps.run.features)) throw new Error("integrity: frozen formation is missing authoritative features.json");
  const specText = readFileSync(project.spec, "utf8"); const spec = specCandidate(specText);
  const init = initCandidate(readFileSync(project.initSh, "utf8"));
  let file: FeaturesFile; let featureProblems: string[];
  try {
    file = readAuthoritativeFeatures(deps.run.features);
    const expectedIds = Array.from({ length: file.features.length }, (_, index) => `f${String(index + 1).padStart(2, "0")}`);
    featureProblems = validateFeatures(file, spec.value!, deps.cfg, { expectedIds });
  } catch (error) { throw new Error(`integrity: cannot read authoritative features: ${(error as Error).message}`); }
  const problems = [...spec.problems, ...init.problems, ...featureProblems];
  if (problems.length > 0) throw new Error(`integrity: frozen formation is invalid: ${problems.join("; ")}`);
  return { file, specHash: hashInput(specText), spec: spec.value! };
}

function finalStatus(deps: PhaseDeps, result: PhaseResult, specHash?: string): PhaseResult {
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
  else writeStatus(deps.run, { state: "stopped", outcome: { kind: "stopped", stopKind: result.stopKind } });
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
  const dossier = ideaContext(deps, ideaId);
  let declared: { kind: ExitKind; reasons: string[] } | undefined;
  const takeExit = () => declared;
  const ctx: ToolContext = {
    cwd: project.dir, roots: [project.dir], run: deps.run, record: deps.record, fetchImpl: deps.fetchImpl,
    protectedPaths: [project.projectJson], protectedDirs: [project.checksDir, project.blockedDir], allowedExitKinds: ["not_formable"],
    onExit: (kind, reasons) => { declared = { kind, reasons }; },
  };
  const brainSeat = deps.models("brain");
  const caps = derivedCaps(deps.cfg);
  const brain = createBrain({
    model: brainSeat.model, getApiKey: () => deps.apiKeyFor(String(brainSeat.model.provider)), tools: brainTools(ctx, "form"),
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "brain"), `## Playbook (form)\n${playbookSection(loadPlaybook(deps.home), "form")}`],
    pinned: formPinned(project, brief, dossier, deps.cfg.budgets.turns.form, join(deps.run.ideasDir, `${ideaId}.md`), join(deps.run.ideasDir, `${ideaId}.evidence.json`), deps.cfg.build.minFeatures, caps.maxFeatures), record: deps.record, role: "brain", phase: "form",
    turnCap: deps.cfg.budgets.turns.form, usdCap: ceiling, spentUsd: () => spent.value, effort: effortFor(deps.cfg, "brain", brainSeat.model),
    streamFn: deps.streamFn, onText: deps.onText, onTool: deps.onTool,
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const charge = (result: BrainResult) => { spent.value += result.costUsd; };
  const stop = (result: BrainResult) => stopFailure("form", deps.cfg.budgets.turns.form, result);
  const halt = (result: BrainResult) => takeExit() !== undefined || stop(result) !== undefined;

  const spec = await ensureFile({ brain, path: project.spec, parse: specCandidate, prompt: `Write ${project.spec} now.`, charge, halt, stopped: stop, exit: takeExit, label: "spec.md" });
  if (spec.result) return { result: spec.result };
  const feature = await ensureFile({ brain, path: project.featuresMirror, parse: (text) => featureCandidate(text, spec.value!, deps), prompt: `Write ${project.featuresMirror} now.`, charge, halt, stopped: stop, exit: takeExit, label: "features.json" });
  if (feature.result) return { result: feature.result };
  writeAtomic(project.featuresMirror, `${JSON.stringify(feature.value, null, 2)}\n`);
  const init = await ensureFile({ brain, path: project.initSh, parse: initCandidate, prompt: `Write ${project.initSh} now.`, charge, halt, stopped: stop, exit: takeExit, label: "init.sh" });
  if (init.result) return { result: init.result };

  const critique = async () => runCritique(deps, {
    spec: readFileSync(project.spec, "utf8"), features: readFileSync(project.featuresMirror, "utf8"), dossier,
    brief: critiqueBrief(brief), brainRef: brainSeat.ref, formationCeilingUsd: ceiling, spentUsd: () => spent.value, onResult: charge,
  });
  const first = await critique();
  const revision = ["Revise the complete formed project exactly once. Preserve every assigned feature id and order.",
    ...first.scopeCreep.map((item) => `Scope creep${item.featureId ? ` ${item.featureId}` : ""}: ${item.text}`),
    ...first.unverifiable.map((item) => `Unverifiable${item.featureId ? ` ${item.featureId}` : ""}: ${item.text}`),
    ...first.missing.map((item) => `Missing${item.featureId ? ` ${item.featureId}` : ""}: ${item.text}`),
    `Binding items: ${bindingItems(first, feature.value!).join("; ") || "none"}.`, `Rewrite ${project.spec}, ${project.featuresMirror}, and ${project.initSh} as needed.`].join("\n");
  if (!deps.record.read().some((event) => event.t === "formation.revision" && event.ideaId === ideaId && event.attempt === attempt)) {
    deps.record.append({ t: "formation.revision", ideaId, attempt });
  }
  let revisionResult = await brain.run(revision); charge(revisionResult);
  if (takeExit()) return { result: { outcome: "honest_exit", ...takeExit()! } };
  let halted = stop(revisionResult); if (halted) return { result: halted };
  const expectedIds = feature.value!.features.map((item) => item.id);
  const validateRevision = () => {
    const s = specCandidate(existsSync(project.spec) ? readFileSync(project.spec, "utf8") : "");
    const f = featureCandidate(existsSync(project.featuresMirror) ? readFileSync(project.featuresMirror, "utf8") : "", s.value ?? parseSpec(""), deps, expectedIds);
    const i = initCandidate(existsSync(project.initSh) ? readFileSync(project.initSh, "utf8") : "");
    return { spec: s, features: f, init: i, problems: [...s.problems, ...f.problems, ...i.problems] };
  };
  let revised = validateRevision();
  const revisedExecutable = () => revised.features.value?.features.filter((item) => item && typeof item === "object" && item.acceptance?.type !== "manual").length ?? -1;
  if (revisedExecutable() === 0) {
    const reasons = ["zero executable acceptance checks remain after revision"];
    deps.record.append({ t: "honest_exit", kind: "not_formable", reasons, source: "mechanical" });
    return { result: { outcome: "honest_exit", kind: "not_formable", reasons } };
  }
  if (revised.problems.length > 0) {
    revisionResult = await brain.run(`The one revision is invalid:\n${revised.problems.map((problem) => `- ${problem}`).join("\n")}\nCorrect all three files once, preserving ids and order.`); charge(revisionResult);
    if (takeExit()) return { result: { outcome: "honest_exit", ...takeExit()! } };
    halted = stop(revisionResult); if (halted) return { result: halted };
    revised = validateRevision();
  }
  if (revisedExecutable() === 0) {
    const reasons = ["zero executable acceptance checks remain after revision"];
    deps.record.append({ t: "honest_exit", kind: "not_formable", reasons, source: "mechanical" });
    return { result: { outcome: "honest_exit", kind: "not_formable", reasons } };
  }
  if (revised.problems.length > 0 || !revised.features.value) return { result: { outcome: "failed", failureClass: "verify", message: `formation revision is not usable: ${revised.problems.join("; ")}` } };
  writeAtomic(project.featuresMirror, `${JSON.stringify(revised.features.value, null, 2)}\n`);
  const second = await critique();
  const executable = revised.features.value.features.filter((item) => item.acceptance.type !== "manual").length;
  if (second.verdict === "revise" || executable === 0) {
    const reasons = [...second.scopeCreep, ...second.unverifiable, ...second.missing].map((item) => item.text);
    if (second.verdict === "revise" && reasons.length === 0) reasons.push("the second critic still requires revision");
    if (executable === 0) reasons.push("zero executable acceptance checks remain after revision");
    deps.record.append({ t: "honest_exit", kind: "not_formable", reasons, source: "mechanical" });
    return { result: { outcome: "honest_exit", kind: "not_formable", reasons } };
  }
  const finalSpecHash = hashInput(readFileSync(project.spec, "utf8"));
  await freeze(deps, revised.features.value, finalSpecHash, git, { afterStep: deps.onFreezeStep });
  return { result: { outcome: "ok" }, specHash: finalSpecHash };
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
      const heldAttempt = priorAttempts.find((event) => event.ideaId === selected)?.attempt;
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
          const stopped = stopFailure("form", deps.cfg.budgets.turns.form, error.result);
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
