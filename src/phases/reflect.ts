import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPlaybook, loadPrompt } from "../brain/prompts";
import { recorded, type ToolContext } from "../brain/tools";
import { fail, ok } from "../brain/tools/shape";
import { bundleMarkdown, bundleProjectDir } from "../build/bundle";
import { DELTA_OPS, EVIDENCE_KINDS, parseDelta, stripCounters, validateDelta, writeCandidate, type DeltaOp, type DeltaValidation, type PlaybookDelta } from "../build/delta";
import { buildDigest, digestHeadings } from "../build/digest";
import { writeMetrics } from "../build/metrics";
import { elapsedByPhase, phaseAvailableUsd, phaseAvailableWallSeconds, spentByPhase } from "../core/budget";
import type { StoredEvent } from "../core/events";
import { classifyFailure } from "../core/failure";
import { candidatePath } from "../core/paths";
import { hashInput, type RunRecord } from "../core/record";
import { readStatus, writeStatus, type RunPaths, type RunStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { effortFor } from "../providers/models";
import { stopFailure, type PhaseDeps, type PhaseResult } from "./frame";
import { assertShapeFrozen } from "./guards";

export interface ReflectDeps extends PhaseDeps { now?: () => number }

/** True once a reflect has ended after the build's latest terminal; a later build terminal makes a new reflect legitimate. */
export function reflected(events: readonly StoredEvent[]): boolean {
  const build = events.findLast((event) => event.t === "phase.end" && event.phase === "build")?.seq ?? -1;
  const reflect = events.findLast((event) => event.t === "phase.end" && event.phase === "reflect")?.seq;
  return reflect !== undefined && reflect > build;
}

/** Combined metrics are written before reflect; a fold failure is explicit and never reuses a stale metrics file. */
function metricsSnapshot(run: RunPaths): { metrics: unknown; text: string } {
  try { const metrics = writeMetrics(run); return { metrics, text: JSON.stringify(metrics, null, 2) }; }
  catch {
    const metrics = { available: false, reason: "current metrics unavailable because authoritative run state could not be folded" };
    return { metrics, text: JSON.stringify(metrics, null, 2) };
  }
}

function recordRejected(record: RunRecord, raw: unknown, reason: string): void {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (!DELTA_OPS.includes(value.op as DeltaOp) || typeof value.section !== "string") return;
  record.append({ t: "delta", op: value.op as DeltaOp, section: value.section, ...(typeof value.id === "string" ? { id: value.id } : {}), accepted: false, reason, source: "reflector" });
}

const ALREADY_ACCEPTED = "a delta was already accepted";
const TRANSIENT_ATTEMPT_CAP = 3;

/** The reflector's only tool: the first validated delta ends the session; every later or rejected call is recorded and explained. */
function playbookDeltaTool(
  ctx: ToolContext,
  validate: (delta: PlaybookDelta) => DeltaValidation,
  accept: (delta: PlaybookDelta) => void,
  onPersistenceFailure: (reason: string) => void,
): AgentTool<any> {
  let accepted = false;
  return {
    name: "playbook_delta",
    label: "Playbook delta",
    intent: "omit",
    lenientArgValidation: true,
    description: "Propose one evidence-backed playbook change. Add/edit must be one <=240-character sentence plus a Why clause and kind; retire must cite a metric.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: [...DELTA_OPS] },
        section: { type: "string", description: "An existing `## <section>` heading of the playbook." },
        id: { type: "string", description: "Bullet id; required for edit and retire, optional for add." },
        text: { type: "string", description: "The bullet's full text (one lesson, one line)." },
        why: { type: "string", description: "Why the evidence supports this change." },
        kind: { type: "string", enum: ["correction", "confirmed"], description: "The lesson category; omitted add/edit values default to correction." },
        evidence: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: [...EVIDENCE_KINDS] }, ref: { type: "string" } }, required: ["kind", "ref"] } },
      },
      required: ["op", "section", "text", "evidence"],
    },
    async execute(_id, raw: unknown) {
      const parsed = parseDelta(raw);
      if ("reason" in parsed) { recordRejected(ctx.record, raw, parsed.reason); return fail(parsed.reason); }
      const { delta } = parsed;
      // Two calls in one assistant turn both execute before the terminal abort; §13 allows exactly one delta.
      const result: DeltaValidation = accepted ? { ok: false, reason: ALREADY_ACCEPTED } : validate(delta);
      if (!result.ok) {
        ctx.record.append({ t: "delta", op: delta.op, section: delta.section, ...(delta.id ? { id: delta.id } : {}), accepted: false, reason: result.reason, source: "reflector" });
        return fail(result.reason);
      }
      // The candidate file is the durable artifact. Never journal acceptance before it exists:
      // a failed atomic rename must remain a rejected proposal rather than a phantom lesson.
      try { accept(delta); }
      catch (error) {
        const reason = `candidate persistence failed: ${error instanceof Error ? error.message : String(error)}`;
        onPersistenceFailure(reason);
        ctx.record.append({ t: "delta", op: delta.op, section: delta.section, ...(delta.id ? { id: delta.id } : {}), accepted: false, reason, source: "reflector" });
        return fail(reason);
      }
      ctx.record.append({ t: "delta", op: delta.op, section: delta.section, ...(delta.id ? { id: delta.id } : {}), accepted: true, source: "reflector" });
      accepted = true;
      return ok(`playbook delta recorded: ${delta.op} ${delta.section}${delta.id ? ` ${delta.id}` : ""}`);
    },
  };
}

/** Record §13: only the digest, the bundle, the whole playbook, and metrics.json; nothing from record.jsonl, evals/, or any prompt file. */
function pinnedContext(digest: string, bundle: string, playbook: string, metrics: string): string {
  return ["# Digest", digest.trimEnd(), "# Artifact bundle", bundle.trimEnd() || "(no markdown artifacts)", "# Playbook", playbook.trimEnd(), "# Metrics", metrics.trimEnd()].join("\n\n");
}

const REFLECT_PROMPT = "Read the pinned digest, artifact bundle, playbook and metrics. If this run teaches one lesson, call playbook_delta once. For add/edit, write one <=240-character sentence, a separate Why clause, and kind correction or confirmed. For retire, cite metric evidence. Otherwise reply in one line without calling it.";

/** A throw inside the session is a reflect failure, classified the way the build loop classifies its own (`guarded()` in build/loop.ts). */
function thrown(error: unknown): PhaseResult {
  const message = error instanceof Error ? error.message : String(error);
  const failureClass = /^(integrity:|cannot read|acceptance lock)/i.test(message) ? "integrity" : "verify";
  return { outcome: "failed", failureClass, message };
}

function latestBuildTerminal(events: readonly StoredEvent[]): Extract<StoredEvent, { t: "phase.end" }> | undefined {
  const start = events.findLast((event) => event.t === "phase.start" && event.phase === "build")?.seq ?? -1;
  const end = events.findLast((event) => event.t === "phase.end" && event.phase === "build");
  if (!end || end.t !== "phase.end") return undefined;
  return end && end.seq > start ? end : undefined;
}

/** Spend and turns since the latest build terminal belong to one reflect unit across process restarts. */
function reflectCycleUsage(events: readonly StoredEvent[]): { buildSeq: number; costUsd: number; turns: number; transientFailures: number; lengthStops: number; lastTransientError?: string; startedAt?: number } {
  const buildSeq = events.findLast((event) => event.t === "phase.end" && event.phase === "build")?.seq ?? -1;
  const cycle = events.filter((event) => event.seq > buildSeq);
  const firstStart = cycle.find((event) => event.t === "phase.start" && event.phase === "reflect");
  const calls = cycle.filter((event): event is Extract<StoredEvent, { t: "model.call" }> => event.t === "model.call" && event.role === "reflector");
  let transientFailures = 0;
  let lengthStops = 0;
  let lastTransientError: string | undefined;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    if (call.stopReason === "length") {
      if (transientFailures > 0) break;
      lengthStops += 1;
      continue;
    }
    if (call.stopReason === "error" && classifyFailure({ message: call.error, status: call.errorStatus, stopDetails: call.stopDetails }) === "transient") {
      if (lengthStops > 0) break;
      transientFailures += 1;
      lastTransientError ??= call.error;
      continue;
    }
    break;
  }
  return {
    buildSeq,
    costUsd: cycle.reduce((sum, event) => sum + (event.t === "model.call" ? event.costUsd : 0), 0),
    turns: cycle.filter((event) => event.t === "turn" && event.phase === "reflect").length,
    transientFailures,
    lengthStops,
    ...(lastTransientError ? { lastTransientError } : {}),
    ...(firstStart ? { startedAt: Date.parse(firstStart.ts) } : {}),
  };
}

/** A matching candidate or a final text response proves terminal reflect work survived a crash. */
function durableReflectCompletion(home: string, run: RunPaths, events: readonly StoredEvent[]): "candidate" | "text" | undefined {
  const usage = reflectCycleUsage(events);
  const started = events.some((event) => event.seq > usage.buildSeq && event.t === "phase.start" && event.phase === "reflect");
  if (!started) return undefined;
  const accepted = events.findLast((event) => event.seq > usage.buildSeq && event.t === "delta" && event.source === "reflector" && event.accepted);
  if (accepted?.t === "delta" && existsSync(run.digest)) {
    try {
      const candidate = JSON.parse(readFileSync(candidatePath(home, run.id), "utf8")) as { runId?: unknown; digestHash?: unknown; delta?: { op?: unknown; section?: unknown; id?: unknown } };
      const delta = candidate.delta;
      if (candidate.runId === run.id
        && candidate.digestHash === hashInput(readFileSync(run.digest, "utf8"))
        && delta?.op === accepted.op
        && delta.section === accepted.section
        && delta.id === accepted.id) return "candidate";
    } catch {
      // A malformed/missing candidate is not durable completion; the phase must run again.
    }
  }
  const lastCall = events.findLast((event) => event.seq > usage.buildSeq && event.t === "model.call" && event.role === "reflector");
  return lastCall?.t === "model.call" && lastCall.stopReason === "stop" && lastCall.excerpt.trim() !== "" ? "text" : undefined;
}

/**
 * Reflect (record §13). Runs after every build terminal, holds no run lock of its own, and never
 * rewrites the build's `state`, `outcome`, `pausedReason` or `wakeAt`: §12 resume routing keys off
 * them. The one exception is the success path, which `buildSuccess` leaves open as
 * `phase: reflect, state: running`; reflect closes it as `done/success` whatever it finds, since the
 * build did succeed. Transient provider failures receive a small bounded retry window; all other
 * terminal failures remain single-shot.
 */
export async function runReflect(deps: ReflectDeps): Promise<PhaseResult> {
  throwIfRunCancelled();
  const { run, record } = deps;
  const entry = readStatus(run);
  if (entry.seed?.split === "heldout") {
    const message = `policy: held-out eval seed ${entry.seed.id} may not enter reflection`;
    record.append({ t: "phase.start", phase: "reflect" });
    record.append({ t: "failure", class: "policy", message });
    record.append({ t: "phase.end", phase: "reflect", outcome: "failed" });
    writeStatus(run, { state: "failed", outcome: { kind: "failure", failureClass: "policy", message }, cursor: { step: "reflected" } });
    return { outcome: "failed", failureClass: "policy", message };
  }
  const initialEvents = record.read();
  const pendingSuccessfulDelivery = entry.phase === "reflect" && entry.state === "running";
  if (pendingSuccessfulDelivery && latestBuildTerminal(initialEvents)?.outcome !== "ok") {
    const message = "integrity: reflect/running requires a successful build terminal before delivery can be recorded";
    record.append({ t: "phase.start", phase: "reflect" });
    record.append({ t: "failure", class: "integrity", message });
    record.append({ t: "phase.end", phase: "reflect", outcome: "failed" });
    writeStatus(run, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message }, cursor: { step: "reflected" } });
    try { writeMetrics(run); } catch { /* the record and failed status stay authoritative */ }
    return { outcome: "failed", failureClass: "integrity", message };
  }
  const closing: Partial<RunStatus> = entry.phase === "reflect" && entry.state === "running" ? { state: "done", outcome: { kind: "success" } } : {};
  if (reflected(initialEvents)) {
    // The phase-end append precedes status persistence. Complete that suffix after a kill.
    if (entry.cursor?.step !== "reflected" || Object.keys(closing).length > 0) {
      writeStatus(run, { ...closing, cursor: { step: "reflected" } });
      try { writeMetrics(run); } catch { /* terminal status remains authoritative */ }
    }
    return { outcome: "ok" };
  }
  const durableCompletion = durableReflectCompletion(deps.home, run, initialEvents);
  if (durableCompletion) {
    record.append({ t: "note", text: `Recovered a durable reflect ${durableCompletion === "candidate" ? "candidate" : "response"} after interruption; no second provider call was made.` });
    record.append({ t: "phase.end", phase: "reflect", outcome: "ok" });
    writeStatus(run, { ...closing, cursor: { step: "reflected" } });
    try { writeMetrics(run); } catch { /* the record and status stay authoritative */ }
    return { outcome: "ok" };
  }
  const frozen = assertShapeFrozen(deps);
  if (frozen) {
    // The guard writes a failed status of its own; hand the build's terminal fields back (or close the open success).
    writeStatus(run, { phase: entry.phase, state: entry.state, outcome: entry.outcome, pausedReason: entry.pausedReason, wakeAt: entry.wakeAt, ...closing });
    return frozen;
  }
  writeStatus(run, { cursor: { step: "reflect" } });
  record.append({ t: "phase.start", phase: "reflect" });
  let result: PhaseResult;
  try { result = await reflectSession(deps); throwIfRunCancelled(); }
  catch (error) { rethrowIfRunCancelled(error); result = thrown(error); }
  if (result.outcome === "failed") {
    const last = record.read().at(-1);
    if (!(last?.t === "failure" && last.class === result.failureClass && last.message === result.message)) record.append({ t: "failure", class: result.failureClass, message: result.message });
  }
  record.append({ t: "phase.end", phase: "reflect", outcome: result.outcome });
  writeStatus(run, { ...closing, cursor: { step: "reflected" } });
  try { writeMetrics(run); } catch { /* the record and status stay authoritative */ }
  return result;
}

/** Everything between `phase.start` and `phase.end`: caps, digest, bundle, context, and the one brain run. */
async function reflectSession(deps: ReflectDeps): Promise<PhaseResult> {
  const { run, record, cfg } = deps;
  const events = record.read();
  const now = deps.now?.() ?? Date.now();
  const cycle = reflectCycleUsage(events);
  const usdCap = phaseAvailableUsd(cfg.budgets, "reflect", spentByPhase(events));
  const wallAllowance = phaseAvailableWallSeconds(cfg.budgets, "reflect", elapsedByPhase(events, now));
  const priorWallSeconds = cycle.startedAt === undefined || !Number.isFinite(cycle.startedAt) ? 0 : Math.max(0, now - cycle.startedAt) / 1_000;
  const wallSeconds = wallAllowance - priorWallSeconds;
  const turnCap = cfg.budgets.turns.reflect;
  if (wallSeconds <= 0) return { outcome: "failed", failureClass: "deadline", message: "wall budget exhausted before reflect" };
  if (cycle.transientFailures >= TRANSIENT_ATTEMPT_CAP) {
    return { outcome: "failed", failureClass: "transient", message: cycle.lastTransientError ?? "transient provider failures exhausted in reflect" };
  }
  if (cycle.lengthStops >= 2) return { outcome: "failed", failureClass: "budget", message: "reflector output limit reached twice before reflection completed" };

  const snapshot = metricsSnapshot(run);
  const digest = buildDigest(run);
  record.append({ t: "digest", hash: digest.hash, bytes: digest.bytes, truncated: digest.truncated });
  const projectDir = bundleProjectDir(run, readStatus(run));
  const bundle = bundleMarkdown(run, projectDir);
  const playbook = loadPlaybook(deps.home);
  const seat = deps.models("reflector");
  const ctx: ToolContext = { cwd: run.dir, roots: [], run, record };
  const validation = {
    digestHeadings: digestHeadings(digest.text), runDir: run.dir, projectDir, metrics: snapshot.metrics, playbook,
    kernel: loadPrompt(deps.home, "kernel"), rolePrompt: loadPrompt(deps.home, "reflector"),
  };
  let persistenceFailure: string | undefined;
  const tool = recorded(ctx, playbookDeltaTool(ctx, (delta) => validateDelta(delta, validation), (delta) => {
    writeCandidate(candidatePath(deps.home, run.id), {
      runId: run.id, digestHash: digest.hash, playbookHash: hashInput(stripCounters(playbook)), reflectorModelRef: seat.ref, delta,
      createdAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    });
  }, (reason) => { persistenceFailure = reason; }));
  let priorCost = cycle.costUsd;
  const brain = createBrain({
    model: seat.model,
    getApiKey: () => deps.apiKeyFor(String(seat.model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "reflector")],
    pinned: pinnedContext(digest.text, bundle.text, playbook, snapshot.text),
    record,
    role: "reflector",
    phase: "reflect",
    turnCap,
    usdCap,
    spentUsd: () => priorCost,
    priorTurns: () => cycle.turns,
    effort: effortFor(deps.cfg, "reflector", seat.model),
    streamFn: deps.streamFn,
    onText: deps.onText,
    onTool: deps.onTool,
    afterTool: () => persistenceFailure !== undefined,
    terminalTools: ["playbook_delta"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  let transientAttempts = cycle.transientFailures;
  let lengthStops = cycle.lengthStops;
  let prompt = lengthStops > 0
    ? "Your previous response reached its output limit. Finish concisely now: call playbook_delta once with only the required fields, or reply in one short line that there is no lesson."
    : transientAttempts > 0
      ? "Retry the same reflection after the transient provider failure. Do not broaden or duplicate the requested lesson."
      : REFLECT_PROMPT;
  for (;;) {
    const result = await brain.run(prompt);
    if (persistenceFailure) return { outcome: "failed", failureClass: "verify", message: persistenceFailure };
    // Reflection owns one bounded output-limit retry. Handle that resource signal below
    // before the generic error path, while still honoring any dollar or turn cap.
    const outputLimited = result.stopped === "error" && result.stopDetails?.type === "output_limit";
    const stop = outputLimited ? undefined : stopFailure("reflect", turnCap, result);
    if (stop) {
      if (stop.outcome !== "failed" || stop.failureClass !== "transient") return stop;
      priorCost += result.costUsd;
      transientAttempts += 1;
      lengthStops = 0;
      if (transientAttempts >= TRANSIENT_ATTEMPT_CAP) return stop;
      prompt = "Retry the same reflection after the transient provider failure. Do not broaden or duplicate the requested lesson.";
    } else {
      const lastCall = record.read().findLast((event) => event.t === "model.call" && event.role === "reflector");
      if (!outputLimited && (lastCall?.t !== "model.call" || lastCall.stopReason !== "length")) return { outcome: "ok" };
      priorCost += result.costUsd;
      lengthStops += 1;
      transientAttempts = 0;
      if (lengthStops >= 2) return { outcome: "failed", failureClass: "budget", message: "reflector output limit reached twice before reflection completed" };
      prompt = "Your previous response reached its output limit. Finish concisely now: call playbook_delta once with only the required fields, or reply in one short line that there is no lesson.";
    }
    const retryNow = deps.now?.() ?? Date.now();
    if (cycle.startedAt !== undefined && Number.isFinite(cycle.startedAt) && (retryNow - cycle.startedAt) / 1_000 >= wallAllowance) {
      return { outcome: "failed", failureClass: "deadline", message: "wall budget exhausted during reflect retries" };
    }
    throwIfRunCancelled();
  }
}
