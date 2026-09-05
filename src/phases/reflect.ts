import { readFileSync } from "node:fs";
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

/** Combined metrics are written before reflect so the reflector can cite them; a fold failure falls back to the file on disk. */
function metricsSnapshot(run: RunPaths): { metrics: unknown; text: string } {
  try { const metrics = writeMetrics(run); return { metrics, text: JSON.stringify(metrics, null, 2) }; }
  catch {
    try { const text = readFileSync(run.metrics, "utf8"); return { metrics: JSON.parse(text), text }; } catch { return { metrics: {}, text: "{}" }; }
  }
}

function recordRejected(record: RunRecord, raw: unknown, reason: string): void {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (!DELTA_OPS.includes(value.op as DeltaOp) || typeof value.section !== "string") return;
  record.append({ t: "delta", op: value.op as DeltaOp, section: value.section, ...(typeof value.id === "string" ? { id: value.id } : {}), accepted: false, reason, source: "reflector" });
}

const ALREADY_ACCEPTED = "a delta was already accepted";

/** The reflector's only tool: the first validated delta ends the session; every later or rejected call is recorded and explained. */
function playbookDeltaTool(ctx: ToolContext, validate: (delta: PlaybookDelta) => DeltaValidation, accept: (delta: PlaybookDelta) => void): AgentTool<any> {
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
      ctx.record.append({ t: "delta", op: delta.op, section: delta.section, ...(delta.id ? { id: delta.id } : {}), accepted: result.ok, ...(result.ok ? {} : { reason: result.reason }), source: "reflector" });
      if (!result.ok) return fail(result.reason);
      accepted = true;
      accept(delta);
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

/**
 * Reflect (record §13). Runs after every build terminal, holds no run lock of its own, and never
 * rewrites the build's `state`, `outcome`, `pausedReason` or `wakeAt`: §12 resume routing keys off
 * them. The one exception is the success path, which `buildSuccess` leaves open as
 * `phase: reflect, state: running`; reflect closes it as `done/success` whatever it finds, since the
 * build did succeed and a reflect is never retried.
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
  const closing: Partial<RunStatus> = entry.phase === "reflect" && entry.state === "running" ? { state: "done", outcome: { kind: "success" } } : {};
  if (reflected(record.read())) {
    // The phase-end append precedes status persistence. Complete that suffix after a kill.
    if (entry.cursor?.step !== "reflected" || Object.keys(closing).length > 0) {
      writeStatus(run, { ...closing, cursor: { step: "reflected" } });
      try { writeMetrics(run); } catch { /* terminal status remains authoritative */ }
    }
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
  const now = deps.now?.() ?? Date.now();
  const events = record.read();
  const usdCap = phaseAvailableUsd(cfg.budgets, "reflect", spentByPhase(events));
  const wallSeconds = phaseAvailableWallSeconds(cfg.budgets, "reflect", elapsedByPhase(events, now));
  const turnCap = cfg.budgets.turns.reflect;
  if (wallSeconds <= 0) return { outcome: "failed", failureClass: "deadline", message: "wall budget exhausted before reflect" };

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
  const tool = recorded(ctx, playbookDeltaTool(ctx, (delta) => validateDelta(delta, validation), (delta) => {
    writeCandidate(candidatePath(deps.home, run.id), {
      runId: run.id, digestHash: digest.hash, playbookHash: hashInput(stripCounters(playbook)), reflectorModelRef: seat.ref, delta,
      createdAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    });
  }));
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
    effort: effortFor(deps.cfg, "reflector", seat.model),
    streamFn: deps.streamFn,
    onText: deps.onText,
    onTool: deps.onTool,
    terminalTools: ["playbook_delta"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const result = await brain.run(REFLECT_PROMPT);
  return stopFailure("reflect", turnCap, result) ?? { outcome: "ok" };
}
