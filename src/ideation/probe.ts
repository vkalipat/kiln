import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import type { Limiter } from "../core/limiter";
import { predicateMatches, type Predicate } from "../core/predicate";
import { writeAtomic } from "../core/paths";
import { runProcess } from "../core/process";
import { hashInput, type RunRecord } from "../core/record";
import type { RunPaths } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
import { classifyFailure, type FailureClass } from "../core/failure";
import { redactEnv } from "../core/secrets";
import type { PhaseDeps } from "../phases/frame";
import { effortFor } from "../providers/models";
import { CAPS, renderDossier, type Dossier, type Evidence } from "./dossier";

/**
 * Feasibility probes (record §6). A stateless prober writes a small self-contained script from the
 * dossier alone; the harness materializes it, runs it under a process-group deadline with a
 * credential-stripped environment, and records the outcome. Neither the brain nor the prober ever
 * reports a result: every status here comes from `runProcess`.
 */

export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 120;
const TAIL_CHARS = CAPS.stdoutTail;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ProbeSpec {
  ideaId: string;
  files: { path: string; content: string }[];
  command: string;
  needs: string[];
  networkRequired: boolean;
  timeoutSeconds: number;
  successPredicate: Predicate;
  scope?: "precondition" | "end_to_end";
  assignmentHash?: string;
  assignmentContext?: ProbeAssignmentContext;
}

export interface ProbeAssignment { rationale: string }
interface ProbeAssignmentContext { version: 1; assignment: ProbeAssignment; dossier: Dossier; priorArt: Evidence["priorArt"] | null }
function assignmentContext(dossier: Dossier, evidence: Evidence | undefined, assignment: ProbeAssignment): ProbeAssignmentContext {
  // Use the persisted JSON representation so absent optional fields hash identically on resume.
  return JSON.parse(JSON.stringify({ version: 1, assignment: { rationale: assignment.rationale }, dossier, priorArt: evidence?.priorArt ?? null })) as ProbeAssignmentContext;
}
export function probeAssignmentHash(dossier: Dossier, evidence: Evidence | undefined, assignment: ProbeAssignment): string {
  return hashInput(assignmentContext(dossier, evidence, assignment));
}

export const PROBE_SPEC_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    command: { type: "string" },
    needs: { type: "array", items: { type: "string" } },
    networkRequired: { type: "boolean" },
    timeoutSeconds: { type: "number" },
    successPredicate: {
      type: "object",
      properties: { type: { type: "string", enum: ["substring", "regex"] }, value: { type: "string" } },
      required: ["type", "value"],
      additionalProperties: false,
    },
  },
  required: ["files", "command", "needs", "networkRequired", "timeoutSeconds", "successPredicate"],
  additionalProperties: false,
} as const;

export type ProbeStatus = "pass" | "fail" | "timeout" | "error" | "not_run";

/** Keep both legacy and assigned decision schemas total for strict provider validation. */
export const ASSIGNED_PROBE_SPEC_SCHEMA = {
  ...PROBE_SPEC_SCHEMA,
  properties: { ...PROBE_SPEC_SCHEMA.properties, scope: { type: "string", enum: ["precondition", "end_to_end"] } },
  required: [...PROBE_SPEC_SCHEMA.required, "scope"],
} as const;

export interface ProbeResult {
  ideaId: string;
  status: ProbeStatus;
  reason?: string;
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  durationMs: number;
  predicateMatched?: boolean;
  /** The prober's own failure text when no spec could be written. */
  error?: string;
  costUsd?: number;
  /** A model worker failed before producing semantic probe evidence; callers must not persist it as not-probeable. */
  workerFailure?: FailureClass;
  /** Explicit optional-stage policy recorded a refusal as unrun evidence, not task completion. */
  optionalRefusal?: true;
  assignmentHash?: string;
  scope?: "precondition" | "end_to_end";
}

export function probeDir(run: RunPaths, ideaId: string): string {
  return join(run.probesDir, ideaId);
}

/** Static checks on a spec before anything touches the disk. Returns the problems, empty when clean. */
export function validateSpec(spec: ProbeSpec): string[] {
  const problems: string[] = [];
  if (spec.scope !== undefined && spec.scope !== "precondition" && spec.scope !== "end_to_end") problems.push("scope must be precondition or end_to_end");
  if (spec.assignmentHash !== undefined && (!spec.assignmentContext || hashInput(spec.assignmentContext) !== spec.assignmentHash || spec.scope === undefined)) problems.push("assigned probe requires matching assignment provenance and an explicit scope");
  spec.files.forEach((f, i) => {
    if (typeof f.path !== "string" || f.path.trim() === "") problems.push(`files[${i}].path is empty`);
    else if (isAbsolute(f.path)) problems.push(`files[${i}].path must be relative and inside the probe directory; absolute paths escape it`);
    else if (normalize(f.path).split(/[\\/]/).includes("..")) problems.push(`files[${i}].path must stay inside the probe directory (".." would escape it)`);
    if (typeof f.content !== "string") problems.push(`files[${i}].content must be a string`);
  });
  if (typeof spec.command !== "string" || spec.command.trim() === "") problems.push("command is empty");
  if (!Number.isFinite(spec.timeoutSeconds) || spec.timeoutSeconds < MIN_TIMEOUT_SECONDS || spec.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    problems.push(`timeoutSeconds must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`);
  }
  const p = spec.successPredicate;
  if (!p || (p.type !== "substring" && p.type !== "regex")) problems.push("successPredicate.type must be substring or regex");
  else if (typeof p.value !== "string" || p.value === "") problems.push("successPredicate.value is empty");
  else if (p.type === "regex") {
    try {
      new RegExp(p.value);
    } catch (e) {
      problems.push(`successPredicate.value is not a valid regex: ${(e as Error).message}`);
    }
  }
  if (!Array.isArray(spec.needs)) problems.push("needs must be a list");
  return problems;
}

/**
 * Which declared dependencies are absent. A need is satisfied by a non-empty variable in the
 * environment the probe will actually see (credentials stripped, so a token can never satisfy it)
 * or by an executable on PATH. Relative executable paths resolve against the execution cwd.
 */
export function checkNeeds(needs: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; which?: (name: string) => string | null } = {}): string[] {
  const env = opts.env ?? redactEnv();
  const which = opts.which ?? ((name: string) => Bun.which(name, { cwd: opts.cwd }));
  return needs.filter((n) => !(typeof env[n] === "string" && env[n] !== "") && which(n) === null);
}

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(text.length - TAIL_CHARS);
}

function refuseSymlinkComponents(base: string, target: string): void {
  const rel = relative(base, target);
  const parts = rel === "" ? [] : rel.split(/[\\/]/);
  let current = base;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`materialize refused symbolic link: ${current}`);
    }
  }
}

export { predicateMatches, type Predicate } from "../core/predicate";

/** Merge a probe outcome into the idea's harness-owned evidence sidecar; an unreadable file starts fresh. */
export function mergeProbeEvidence(run: RunPaths, ideaId: string, probe: NonNullable<Evidence["probe"]>): Evidence {
  const path = join(run.ideasDir, `${ideaId}.evidence.json`);
  let existing: Evidence = { status: "active" };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Evidence;
      if (parsed && typeof parsed === "object") existing = parsed;
    } catch {
      // A torn or hand-edited sidecar must not lose a probe result that cost real time to produce.
    }
  }
  const next: Evidence = { ...existing, probe };
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function finish(run: RunPaths, record: RunRecord, r: ProbeResult, recordEvidence: boolean): ProbeResult {
  if (recordEvidence) {
    mergeProbeEvidence(run, r.ideaId, { status: r.status, reason: r.reason, exitCode: r.exitCode, stdoutTail: r.stdoutTail, durationMs: r.durationMs, ...(r.assignmentHash ? { assignmentHash: r.assignmentHash } : {}), ...(r.scope ? { scope: r.scope } : {}) });
  }
  record.append({ t: "probe", id: r.ideaId, status: r.status, reason: r.reason, exitCode: r.exitCode, durationMs: r.durationMs });
  return r;
}

/** Materialize and run one spec; every outcome is recorded in the sidecar, the journal, and `probes/<id>.json`. */
export async function runProbe(run: RunPaths, spec: ProbeSpec, cfg: { timeoutSeconds: number }, record: RunRecord): Promise<ProbeResult> {
  const started = Date.now();
  const id = spec.ideaId;
  const finishProbe = (r: ProbeResult, recordEvidence: boolean) => finish(run, record, { ...r, ...(spec.assignmentHash ? { assignmentHash: spec.assignmentHash, scope: spec.scope } : {}) }, recordEvidence);
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    return finishProbe({ ideaId: String(id), status: "error", reason: "invalid_idea_id", durationMs: 0 }, false);
  }
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    return finishProbe({ ideaId: id, status: "error", reason: `spec_invalid: ${problems.join("; ")}`, durationMs: 0 }, true);
  }
  const dir = probeDir(run, id);
  const missing = checkNeeds(spec.needs, { cwd: dir });
  if (missing.length > 0) {
    return finishProbe({ ideaId: id, status: "not_run", reason: `missing_dependency:${missing[0]}`, durationMs: 0 }, true);
  }
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of spec.files) {
      const target = resolve(dir, f.path);
      const rel = relative(dir, target);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`file path ${f.path} would escape the probe directory`);
      refuseSymlinkComponents(dir, target);
      mkdirSync(dirname(target), { recursive: true });
      refuseSymlinkComponents(dir, target);
      writeFileSync(target, f.content);
    }
  } catch (e) {
    return finishProbe({ ideaId: id, status: "error", reason: `materialize failed: ${(e as Error).message}`, durationMs: Date.now() - started }, true);
  }
  if (spec.networkRequired) record.append({ t: "note", text: `probe ${id} declares networkRequired: true (recorded, not enforced)` });
  const timeoutMs = Math.min(spec.timeoutSeconds, cfg.timeoutSeconds) * 1000;
  const p = await runProcess({ cmd: "sh", args: ["-c", spec.command], cwd: dir, env: redactEnv(), envReplace: true, timeoutMs });
  throwIfRunCancelled();
  const stdoutTail = tail(p.stdout.trim() === "" ? p.stderr : p.stdout);
  const stderrTail = tail(p.stderr);
  const matched = predicateMatches(spec.successPredicate, p.stdout.trim() === "" ? p.stderr : p.stdout);
  let r: ProbeResult;
  if (p.timedOut) r = { ideaId: id, status: "timeout", reason: `deadline ${timeoutMs / 1000}s`, exitCode: p.exitCode ?? undefined, stdoutTail, stderrTail, durationMs: p.durationMs, predicateMatched: matched };
  else if (p.exitCode === 127) r = { ideaId: id, status: "error", reason: "command_not_found", exitCode: 127, stdoutTail, stderrTail, durationMs: p.durationMs, predicateMatched: matched };
  else if (p.exitCode === null) r = { ideaId: id, status: "error", reason: `signal:${p.signal ?? "unknown"}`, stdoutTail, stderrTail, durationMs: p.durationMs, predicateMatched: matched };
  else if (p.exitCode === 0 && matched) r = { ideaId: id, status: "pass", exitCode: 0, stdoutTail, stderrTail, durationMs: p.durationMs, predicateMatched: true };
  else r = { ideaId: id, status: "fail", exitCode: p.exitCode, stdoutTail, stderrTail, durationMs: p.durationMs, predicateMatched: matched };
  if (spec.assignmentHash) r = { ...r, assignmentHash: spec.assignmentHash, scope: spec.scope };
  const artifact = `${JSON.stringify({ spec, specHash: hashInput(spec), result: r }, null, 2)}\n`;
  const currentPath = join(run.probesDir, `${id}.json`);
  if (existsSync(currentPath)) {
    const previous = readFileSync(currentPath, "utf8");
    const previousPath = join(run.probesDir, `${id}.history-${hashInput(previous)}.json`);
    if (!existsSync(previousPath)) writeAtomic(previousPath, previous);
  }
  if (spec.assignmentHash) writeAtomic(join(run.probesDir, `${id}.${spec.assignmentHash}.json`), artifact);
  writeAtomic(currentPath, artifact);
  return finish(run, record, r, true);
}

/** Ask the prober role for a spec; the dossier is all it sees (never the archive standing). */
export async function writeProbe(deps: PhaseDeps, dossier: Dossier, evidence?: Evidence, assignment?: ProbeAssignment): Promise<{ spec?: ProbeSpec; costUsd: number; error?: string; stopped?: "done" | "turn_cap" | "usd_cap" | "exit" | "error" | "refused"; workerFailure?: FailureClass; refusalCategory?: string; cannotProbeReason?: string }> {
  const packet = assignment ? assignmentContext(dossier, evidence, assignment) : undefined;
  if (assignment && (typeof assignment.rationale !== "string" || !assignment.rationale.trim() || assignment.rationale.length > 8000 || JSON.stringify(packet).length > 32000)) return { costUsd: 0, error: "Assigned probe packet exceeds its explicit bounds or has an empty rationale; no content was clipped and no model was called.", stopped: "error", workerFailure: "verify" };
  const { model } = deps.models("prober");
  let captured: ProbeSpec | undefined;
  let cannotProbeReason: string | undefined;
  let problem: string | undefined;
  const tool: AgentTool<any> = {
    name: "probe_spec",
    label: "Probe spec",
    intent: "omit",
    description: "Declare the one cheap probe for this idea: files, command, needs, networkRequired, timeoutSeconds, successPredicate.",
    parameters: assignment ? ASSIGNED_PROBE_SPEC_SCHEMA : PROBE_SPEC_SCHEMA,
    examples: [{ caption: "A shell probe", call: { files: [{ path: "check.sh", content: "echo ok" }], command: "sh check.sh", needs: ["sh"], networkRequired: false, timeoutSeconds: 20, successPredicate: { type: "substring", value: "ok" }, ...(assignment ? { scope: "precondition" } : {}) } }],
    async execute(_id, p: Omit<ProbeSpec, "ideaId">) {
      const spec: ProbeSpec = { ideaId: dossier.id, files: p.files ?? [], command: p.command, needs: p.needs ?? [], networkRequired: p.networkRequired === true, timeoutSeconds: Number(p.timeoutSeconds), successPredicate: p.successPredicate, ...(p.scope ? { scope: p.scope } : {}), ...(packet ? { assignmentContext: packet, assignmentHash: hashInput(packet) } : {}) };
      const problems = validateSpec(spec);
      if (problems.length > 0) {
        problem = problems.join("; ");
        return { content: [{ type: "text" as const, text: `error: invalid probe spec: ${problem}` }], isError: true };
      }
      captured = spec;
      return { content: [{ type: "text" as const, text: "probe spec recorded" }] };
    },
  };
  const cannotProbe: AgentTool<any> = {
    name: "cannot_probe", label: "Cannot perform assigned probe", description: "Explain why the exact assigned bounded test cannot be performed; do not substitute a toy test.",
    parameters: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["reason"], additionalProperties: false },
    async execute(_id, args: { reason?: unknown }) {
      if (typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 4000) return { isError: true, content: [{ type: "text", text: "Provide a nonempty concrete limitation, at most 4000 characters." }] };
      cannotProbeReason = args.reason;
      return { content: [{ type: "text", text: "Assigned probe was not performed; limitation recorded." }] };
    },
  };
  const brain = createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: assignment ? [tool, cannotProbe] : [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "prober")],
    pinned: packet ? `Exact assigned probe packet (unabridged):\n${JSON.stringify(packet)}\nImplement this assigned bounded test only. Do not replace data availability, a real metric, or the selected acceptance condition with a synthetic demonstration. If it cannot be done, call cannot_probe with the concrete limitation. Declare whether the actual test is a precondition or end_to_end. That declaration is not independent verification of alignment.` : `Idea under test:\n${renderDossier(dossier, undefined, { forJudge: false })}`,
    record: deps.record,
    role: "prober",
    phase: "ideate",
    // Two turns: the spec call, then the prober's closing line. The spec is captured by the tool,
    // so an invalid spec gets exactly one more turn to be fixed and a silent prober costs one call.
    turnCap: 2,
    effort: effortFor(deps.cfg, "prober", model),
    streamFn: deps.streamFn,
    terminalTools: assignment ? ["probe_spec", "cannot_probe"] : ["probe_spec"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const result = await brain.run(assignment ? "Perform the exact assigned probe in the pinned packet. Return probe_spec with its declared scope, or cannot_probe; do not substitute another test." : "Write the cheapest probe that could plainly fail for this idea's testable claim. Call probe_spec.");
  if (captured) return { spec: captured, costUsd: result.costUsd, stopped: result.stopped };
  if (cannotProbeReason && result.stopped !== "refused" && result.stopped !== "error") return { cannotProbeReason, costUsd: result.costUsd, stopped: result.stopped };
  const category = result.stopDetails?.category?.trim();
  const error = problem ? `invalid probe spec: ${problem}`
    : result.stopped === "refused" ? `refused${category ? `:${category}` : ""}`
    : result.stopped === "error" ? result.error ?? "prober provider error"
    : result.stopped === "turn_cap" || result.stopped === "usd_cap" ? `prober ${result.stopped}`
    : "prober did not call probe_spec";
  const workerFailure = result.stopped === "done" ? (assignment ? "verify" : undefined)
    : problem ? "verify"
    : result.stopped === "refused" ? "refusal"
    : result.stopped === "turn_cap" || result.stopped === "usd_cap" ? "budget"
    : classifyFailure({ message: error, status: result.errorStatus, stopDetails: result.stopDetails });
  return { costUsd: result.costUsd, error, stopped: result.stopped, workerFailure, ...(result.stopped === "refused" ? { refusalCategory: category || "unknown" } : {}) };
}

export interface ProbeBatchOptions {
  roundWallSeconds: number;
  /** Only optional evidence collection may continue past a recorded worker refusal. */
  optional?: boolean;
  assignments?: Readonly<Record<string, ProbeAssignment>>;
  limiter?: Limiter;
  onEach?: (r: ProbeResult) => void;
  now?: () => number;
}

/**
 * Write and run one probe per idea, concurrently through the shared limiter, inside the round's
 * probe wall clock; the rest are `not_run: budget`. An idea already out of budget at loop time is
 * caught synchronously in this loop, before it is ever dispatched — never inside a
 * limiter-wrapped callback, and never by nesting a `limiter.run()` call. A dispatched idea's
 * budget is re-checked, and its timeout clamp re-derived, a second time immediately before
 * `runProbe` is invoked: queueing time behind a busy limiter (concurrency is shared with islands,
 * scouts and judge pairs) plus `writeProbe`'s own model call can both erode the round's remaining
 * wall clock well past what was true when this idea was enqueued.
 */
export async function runProbeBatch(deps: PhaseDeps, ideas: { dossier: Dossier; evidence?: Evidence }[], opts: ProbeBatchOptions): Promise<ProbeResult[]> {
  const now = opts.now ?? Date.now;
  const limiter = opts.limiter ?? deps.limiter;
  const started = now();
  const remaining = () => opts.roundWallSeconds * 1000 - (now() - started);
  const out: ProbeResult[] = new Array(ideas.length);
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < ideas.length; i++) {
    const { dossier, evidence } = ideas[i]!;
    const id = dossier.id;
    if (!SAFE_ID.test(id)) {
      out[i] = { ideaId: id, status: "not_run", reason: "invalid_idea_id", durationMs: 0, costUsd: 0, workerFailure: "integrity", error: "invalid probe idea id" };
      opts.onEach?.(out[i]!); continue;
    }
    const assignment = opts.assignments && Object.hasOwn(opts.assignments, id) ? structuredClone(opts.assignments[id]!) : undefined;
    const assignmentHash = assignment ? probeAssignmentHash(dossier, evidence, assignment) : undefined;
    if (assignmentHash && SAFE_ID.test(id)) {
      try {
        const cached = JSON.parse(readFileSync(join(deps.run.probesDir, `${id}.${assignmentHash}.json`), "utf8")) as { spec: ProbeSpec; specHash: string; result: ProbeResult };
        if (cached.spec.assignmentHash === assignmentHash && hashInput(cached.spec) === cached.specHash && validateSpec(cached.spec).length === 0 && cached.result.assignmentHash === assignmentHash && cached.result.status === "pass" && cached.result.exitCode === 0 && cached.result.predicateMatched === true) {
          deps.record.append({ t: "note", text: `Reused completed probe ${id} for unchanged assignment ${assignmentHash}; no worker or process was repeated.` });
          mergeProbeEvidence(deps.run, id, { status: "pass", assignmentHash, scope: cached.result.scope, exitCode: cached.result.exitCode, stdoutTail: cached.result.stdoutTail, durationMs: cached.result.durationMs });
          out[i] = { ...cached.result, costUsd: 0 }; opts.onEach?.(out[i]!); continue;
        }
      } catch { /* Missing or invalid cached provenance cannot validate this assignment. */ }
    }
    // Below the minimum useful probe timeout, dispatching would either overrun the round's wall
    // clock or run for less time than any probe is allowed to declare — not_run either way.
    if (remaining() < MIN_TIMEOUT_SECONDS * 1000) {
      const r = finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: "budget", durationMs: 0, assignmentHash }, true);
      out[i] = r;
      opts.onEach?.(r);
      continue;
    }
    const job = limiter
      .run(async () => {
        const w = await writeProbe(deps, dossier, evidence, assignment);
        if (!w.spec) {
          if (w.cannotProbeReason) return finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: `cannot_probe:${w.cannotProbeReason}`, durationMs: 0, costUsd: w.costUsd, assignmentHash }, true);
          if (opts.optional && w.workerFailure === "refusal" && w.stopped === "refused") {
            const category = w.refusalCategory ?? "unknown";
            deps.record.append({ t: "failure", class: "refusal", category, message: `Optional probe worker refused for ${id}: ${w.error ?? "provider refusal"}. No probe was executed or retried.` });
            return finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: `worker_refused:${category}`, durationMs: 0, error: w.error, costUsd: w.costUsd, workerFailure: "refusal", optionalRefusal: true, assignmentHash }, true);
          }
          if (w.workerFailure) return { ideaId: id, status: "not_run" as const, reason: `worker_${w.stopped ?? "error"}`, durationMs: 0, error: w.error, costUsd: w.costUsd, workerFailure: w.workerFailure };
          return { ...finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: "not_probeable", durationMs: 0 }, true), error: w.error, costUsd: w.costUsd };
        }
        // Fresh snapshot, taken as late as possible: a stale one from enqueue time can no longer
        // be trusted once this idea's slot has actually opened.
        const remainingNowMs = remaining();
        if (remainingNowMs < MIN_TIMEOUT_SECONDS * 1000) {
          return { ...finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: "budget", durationMs: 0, assignmentHash, scope: w.spec.scope }, true), costUsd: w.costUsd };
        }
        const frozenSpec = structuredClone(w.spec);
        if (frozenSpec.assignmentHash) {
          const specHash = hashInput(frozenSpec);
          const path = join(deps.run.probesDir, `${id}.spec-${specHash}.json`);
          if (!existsSync(path)) writeAtomic(path, `${JSON.stringify({ spec: frozenSpec, specHash }, null, 2)}\n`);
        }
        deps.record.append({ t: "note", text: `probe.preview ${JSON.stringify({ ideaId: id, files: frozenSpec.files.map((file) => file.path), command: frozenSpec.command, networkRequired: frozenSpec.networkRequired, assignmentHash: frozenSpec.assignmentHash, scope: frozenSpec.scope })}` });
        await deps.onProbePreview?.(structuredClone(frozenSpec));
        throwIfRunCancelled();
        const timeout = { timeoutSeconds: Math.min(deps.cfg.ideation.probe.timeoutSeconds, remainingNowMs / 1000) };
        return { ...(await runProbe(deps.run, frozenSpec, timeout, deps.record)), costUsd: w.costUsd };
      })
      .then((r) => {
        out[i] = r;
        opts.onEach?.(r);
      });
    jobs.push(job);
  }
  const settled = await Promise.allSettled(jobs);
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (rejected) throw rejected.reason;
  return out;
}
