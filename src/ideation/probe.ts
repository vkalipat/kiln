import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import type { Limiter } from "../core/limiter";
import { predicateMatches, type Predicate } from "../core/predicate";
import { writeAtomic } from "../core/paths";
import { runProcess } from "../core/process";
import type { RunRecord } from "../core/record";
import type { RunPaths } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
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
}

export function probeDir(run: RunPaths, ideaId: string): string {
  return join(run.probesDir, ideaId);
}

/** Static checks on a spec before anything touches the disk. Returns the problems, empty when clean. */
export function validateSpec(spec: ProbeSpec): string[] {
  const problems: string[] = [];
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
 * or by an executable on PATH.
 */
export function checkNeeds(needs: string[], opts: { env?: Record<string, string | undefined>; which?: (name: string) => string | null } = {}): string[] {
  const env = opts.env ?? redactEnv();
  const which = opts.which ?? ((name: string) => Bun.which(name));
  return needs.filter((n) => !(typeof env[n] === "string" && env[n] !== "") && which(n) === null);
}

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(text.length - TAIL_CHARS);
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
    mergeProbeEvidence(run, r.ideaId, { status: r.status, reason: r.reason, exitCode: r.exitCode, stdoutTail: r.stdoutTail, durationMs: r.durationMs });
  }
  record.append({ t: "probe", id: r.ideaId, status: r.status, reason: r.reason, exitCode: r.exitCode, durationMs: r.durationMs });
  return r;
}

/** Materialize and run one spec; every outcome is recorded in the sidecar, the journal, and `probes/<id>.json`. */
export async function runProbe(run: RunPaths, spec: ProbeSpec, cfg: { timeoutSeconds: number }, record: RunRecord): Promise<ProbeResult> {
  const started = Date.now();
  const id = spec.ideaId;
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    return finish(run, record, { ideaId: String(id), status: "error", reason: "invalid_idea_id", durationMs: 0 }, false);
  }
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    return finish(run, record, { ideaId: id, status: "error", reason: `spec_invalid: ${problems.join("; ")}`, durationMs: 0 }, true);
  }
  const missing = checkNeeds(spec.needs);
  if (missing.length > 0) {
    return finish(run, record, { ideaId: id, status: "not_run", reason: `missing_dependency:${missing[0]}`, durationMs: 0 }, true);
  }
  const dir = probeDir(run, id);
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of spec.files) {
      const target = resolve(dir, f.path);
      const rel = relative(dir, target);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`file path ${f.path} would escape the probe directory`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
    }
  } catch (e) {
    return finish(run, record, { ideaId: id, status: "error", reason: `materialize failed: ${(e as Error).message}`, durationMs: Date.now() - started }, true);
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
  writeAtomic(join(run.probesDir, `${id}.json`), `${JSON.stringify({ spec, result: r }, null, 2)}\n`);
  return finish(run, record, r, true);
}

/** Ask the prober role for a spec; the dossier is all it sees (never the archive standing). */
export async function writeProbe(deps: PhaseDeps, dossier: Dossier, _evidence?: Evidence): Promise<{ spec?: ProbeSpec; costUsd: number; error?: string }> {
  const { model } = deps.models("prober");
  let captured: ProbeSpec | undefined;
  let problem: string | undefined;
  const tool: AgentTool<any> = {
    name: "probe_spec",
    label: "Probe spec",
    intent: "omit",
    description: "Declare the one cheap probe for this idea: files, command, needs, networkRequired, timeoutSeconds, successPredicate.",
    parameters: PROBE_SPEC_SCHEMA,
    examples: [{ caption: "A shell probe", call: { files: [{ path: "check.sh", content: "echo ok" }], command: "sh check.sh", needs: ["sh"], networkRequired: false, timeoutSeconds: 20, successPredicate: { type: "substring", value: "ok" } } }],
    async execute(_id, p: Omit<ProbeSpec, "ideaId">) {
      const spec: ProbeSpec = { ideaId: dossier.id, files: p.files ?? [], command: p.command, needs: p.needs ?? [], networkRequired: p.networkRequired === true, timeoutSeconds: Number(p.timeoutSeconds), successPredicate: p.successPredicate };
      const problems = validateSpec(spec);
      if (problems.length > 0) {
        problem = problems.join("; ");
        return { content: [{ type: "text" as const, text: `error: invalid probe spec: ${problem}` }], isError: true };
      }
      captured = spec;
      return { content: [{ type: "text" as const, text: "probe spec recorded" }] };
    },
  };
  const brain = createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "prober")],
    pinned: `Idea under test:\n${renderDossier(dossier, undefined, { forJudge: false })}`,
    record: deps.record,
    role: "prober",
    phase: "ideate",
    // Two turns: the spec call, then the prober's closing line. The spec is captured by the tool,
    // so an invalid spec gets exactly one more turn to be fixed and a silent prober costs one call.
    turnCap: 2,
    effort: effortFor(deps.cfg, "prober", model),
    streamFn: deps.streamFn,
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const { costUsd } = await brain.run("Write the cheapest probe that could plainly fail for this idea's testable claim. Call probe_spec.");
  if (captured) return { spec: captured, costUsd };
  return { costUsd, error: problem ? `invalid probe spec: ${problem}` : "prober did not call probe_spec" };
}

export interface ProbeBatchOptions {
  roundWallSeconds: number;
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
    // Below the minimum useful probe timeout, dispatching would either overrun the round's wall
    // clock or run for less time than any probe is allowed to declare — not_run either way.
    if (remaining() < MIN_TIMEOUT_SECONDS * 1000) {
      const r = finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: "budget", durationMs: 0 }, true);
      out[i] = r;
      opts.onEach?.(r);
      continue;
    }
    const job = limiter
      .run(async () => {
        const w = await writeProbe(deps, dossier, evidence);
        if (!w.spec) return { ...finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: "not_probeable", durationMs: 0 }, true), error: w.error, costUsd: w.costUsd };
        // Fresh snapshot, taken as late as possible: a stale one from enqueue time can no longer
        // be trusted once this idea's slot has actually opened.
        const remainingNowMs = remaining();
        if (remainingNowMs < MIN_TIMEOUT_SECONDS * 1000) {
          return { ...finish(deps.run, deps.record, { ideaId: id, status: "not_run", reason: "budget", durationMs: 0 }, true), costUsd: w.costUsd };
        }
        deps.record.append({ t: "note", text: `probe.preview ${JSON.stringify({ ideaId: id, files: w.spec.files.map((file) => file.path), command: w.spec.command, networkRequired: w.spec.networkRequired })}` });
        await deps.onProbePreview?.(w.spec);
        throwIfRunCancelled();
        const timeout = { timeoutSeconds: Math.min(deps.cfg.ideation.probe.timeoutSeconds, remainingNowMs / 1000) };
        return { ...(await runProbe(deps.run, w.spec, timeout, deps.record)), costUsd: w.costUsd };
      })
      .then((r) => {
        out[i] = r;
        opts.onEach?.(r);
      });
    jobs.push(job);
  }
  await Promise.all(jobs);
  return out;
}
