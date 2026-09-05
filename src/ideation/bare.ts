import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import { classifyFailure } from "../core/failure";
import { Limiter } from "../core/limiter";
import { acquireRunLock } from "../core/lock";
import { writeAtomic } from "../core/paths";
import { readStatus, writeStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { effortFor } from "../providers/models";
import { Archive } from "./archive";
import { normalizeAxes, parseDossier, renderDossierDetailed, splitIdeas, validateDossier, type Dossier } from "./dossier";
import { writeMetrics } from "./metrics";
import { enrichEvidence, type FrontierFile } from "../phases/ideate";
import { parseBrief, type PhaseDeps, type PhaseResult } from "../phases/frame";
import { shapeHash } from "../phases/contracts";

const BARE_COUNT = 10;

function done(d: PhaseDeps, result: PhaseResult, patch: Parameters<typeof writeStatus>[1]): PhaseResult {
  d.record.append({ t: "phase.end", phase: "ideate", outcome: result.outcome });
  writeStatus(d.run, { usdSpent: d.record.costUsd(), ...patch });
  return result;
}

/** M1 baseline: one strong generation call, the same evidence/render path, no archive novelty,
 *  tournament, or evolution. */
async function runBareUnlocked(d: PhaseDeps): Promise<PhaseResult> {
  let brief: string;
  try { brief = readFileSync(d.run.brief, "utf8"); }
  catch (error) {
    const message = `cannot read bare-run brief: ${(error as Error).message}`;
    d.record.append({ t: "failure", class: "integrity", message });
    return done(d, { outcome: "failed", failureClass: "integrity", message }, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } });
  }
  const parsed = parseBrief(brief); const status = readStatus(d.run);
  if (!parsed.shape || (status.shapeHash && status.shapeHash !== shapeHash(parsed))) {
    const message = "the brief's idea shape does not match the shape frozen at frame; start a new run";
    d.record.append({ t: "failure", class: "integrity", message });
    return done(d, { outcome: "failed", failureClass: "integrity", message }, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } });
  }
  if (!d.record.read().some((event) => event.t === "phase.start" && event.phase === "ideate")) d.record.append({ t: "phase.start", phase: "ideate" });
  writeStatus(d.run, { searchHealth: status.searchHealth ?? 1, searchHealthFloor: d.cfg.ideation.searchHealthFloor, noveltyEnforced: status.noveltyEnforced ?? true });
  const { model } = d.models("generator");
  const brain = createBrain({
    model,
    getApiKey: () => d.apiKeyFor(String(model.provider)),
    tools: [],
    systemPrompt: [loadPrompt(d.home, "kernel"), loadPrompt(d.home, "generator")],
    pinned: `Bare baseline. Write exactly ${BARE_COUNT} dossiers in one answer. Axis vocabulary:\n${parsed.axes.map((axis) => `- ${axis.name}: ${axis.values.join(" | ")}`).join("\n")}`,
    record: d.record,
    role: "generator",
    phase: "ideate",
    turnCap: 1,
    effort: effortFor(d.cfg, "generator", model),
    streamFn: d.streamFn,
    shaping: { cfg: d.cfg, runId: d.run.id },
  });
  const result = await brain.run(`Brief:\n${brief}\n\nWrite exactly ${BARE_COUNT} \`# Idea <n>\` dossiers now.`);
  if (result.stopped === "error" || result.stopped === "turn_cap") {
    const message = result.error ?? `bare generator stopped: ${result.stopped}`;
    const failureClass = result.stopped === "turn_cap" ? "budget" : classifyFailure({ message, status: result.errorStatus });
    d.record.append({ t: "failure", class: failureClass, message });
    return done(d, { outcome: "failed", failureClass, message }, { state: "failed", outcome: { kind: "failure", failureClass, message } });
  }
  if (result.contextPressure) d.record.append({ t: "note", text: "context pressure observed in bare ideation; any resumed model seat rebuilds fresh from files" });
  const blocks = splitIdeas(result.text);
  if (blocks.length !== BARE_COUNT) {
    const message = `bare generator wrote ${blocks.length} ideas; expected ${BARE_COUNT}`;
    d.record.append({ t: "failure", class: "verify", message });
    return done(d, { outcome: "failed", failureClass: "verify", message }, { state: "failed", outcome: { kind: "failure", failureClass: "verify", message } });
  }
  const archive = new Archive(d.run, d.record);
  const ids: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const parsedDossier = parseDossier(blocks[i]!).dossier;
    const problems = validateDossier(parsedDossier, parsed.axes);
    if (problems.length > 0) {
      const message = `bare idea ${i + 1} is not a valid dossier: ${problems.join("; ")}`;
      d.record.append({ t: "failure", class: "verify", message });
      return done(d, { outcome: "failed", failureClass: "verify", message }, { state: "failed", outcome: { kind: "failure", failureClass: "verify", message } });
    }
    const axes = normalizeAxes(parsedDossier, parsed.axes);
    const axisValues = { ...axes.axisValues };
    for (const unknown of axes.unknown) if (unknown.allowed[0]) axisValues[unknown.axis] = unknown.allowed[0];
    const dossier: Dossier = {
      id: `bare-${i + 1}`,
      title: parsedDossier.title ?? "",
      mechanism: parsedDossier.mechanism ?? "",
      draws: parsedDossier.draws ?? "",
      axisValues,
      testableClaim: parsedDossier.testableClaim ?? "",
      cheapestTest: parsedDossier.cheapestTest ?? "",
      failureReason: parsedDossier.failureReason ?? "",
      parents: [],
      vsProbability: parsedDossier.vsProbability,
    };
    archive.insert(dossier, { source: `${blocks[i]!.trim()}\n` }); ids.push(dossier.id);
  }
  const enriched = await enrichEvidence(d, archive, ids, parsed.shape, 1, new Limiter(d.cfg.ideation.searchConcurrency));
  if (enriched.contextPressure) d.record.append({ t: "note", text: "context pressure observed in bare evidence collection; any resumed model seat rebuilds fresh from files" });
  writeStatus(d.run, { searchHealth: enriched.searchHealth, searchHealthFloor: d.cfg.ideation.searchHealthFloor, noveltyEnforced: enriched.noveltyEnforced });
  if (enriched.pause) {
    d.record.append({ t: "pause", reason: enriched.pause.reason, wakeAt: enriched.pause.wakeAt });
    return done(d, { outcome: "ok" }, { state: "paused", pausedReason: enriched.pause.reason, wakeAt: enriched.pause.wakeAt });
  }
  if (enriched.failure) return done(d, { outcome: "failed", ...enriched.failure }, { state: "failed", outcome: { kind: "failure", ...enriched.failure } });
  if (enriched.exit) return done(d, { outcome: "honest_exit", ...enriched.exit }, { state: "done", outcome: { kind: "honest_exit", exitKind: enriched.exit.kind, reasons: enriched.exit.reasons } });
  if (enriched.stalled) {
    d.record.append({ t: "stop", stopKind: "stalled", round: 1, stallTool: enriched.stalled.tool, stallFingerprint: enriched.stalled.fingerprint });
    return done(d, { outcome: "stopped", stopKind: "stalled" }, { state: "stopped", outcome: { kind: "stopped", stopKind: "stalled" } });
  }
  const ideas = ids.map((id) => {
    archive.mergeEvidence(id, {});
    const entry = archive.get(id)!; const rendered = renderDossierDetailed(entry.dossier, entry.evidence, { forJudge: true });
    writeAtomic(join(d.run.renderedDir, `${id}-r1.md`), rendered.text); archive.mergeEvidence(id, { truncated: rendered.truncated });
    return { id, backfill: false, cell: entry.evidence.cell };
  });
  const frontier: FrontierFile = {
    version: 1, mode: "bare", round: 1, rawFront: ids, shown: ids, eligible: ids, ideas,
    ladders: { value: [], feasibility: [] }, searchHealth: enriched.searchHealth,
    searchHealthFloor: d.cfg.ideation.searchHealthFloor, noveltyEnforced: enriched.noveltyEnforced,
  };
  writeAtomic(d.run.frontier, `${JSON.stringify(frontier, null, 2)}\n`);
  return done(d, { outcome: "ok" }, { phase: "ideate", state: "running", cursor: { round: 1, step: "checkpoint" } });
}

/** Bare mode is a phase entry point too, so it has the same lock/metrics guarantees as runIdeate. */
export async function runBare(d: PhaseDeps): Promise<PhaseResult> {
  throwIfRunCancelled();
  const lock = d.lockHeld ? undefined : acquireRunLock(d.run, { force: d.forceLock });
  try {
    try {
      const result = await runBareUnlocked(d);
      throwIfRunCancelled();
      return result;
    } catch (error) {
      rethrowIfRunCancelled(error);
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifyFailure({ error, message });
      d.record.append({ t: "failure", class: failureClass, message });
      return done(d, { outcome: "failed", failureClass, message }, {
        state: "failed",
        outcome: { kind: "failure", failureClass, message },
      });
    }
  } finally {
    try {
      writeMetrics(d.run);
    } finally {
      lock?.release();
    }
  }
}
