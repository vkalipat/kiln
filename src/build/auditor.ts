import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import { gitDiffTool, gitLogTool, type GitToolProcessRunner } from "../brain/tools/git";
import { readTool } from "../brain/tools/read";
import { searchTool } from "../brain/tools/search";
import { recorded, type ToolContext } from "../brain/tools";
import { fail, ok } from "../brain/tools/shape";
import type { AuditVerdict } from "../core/events";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { effortFor, NoModelError, otherProvider, parseModelRef } from "../providers/models";
import type { PhaseDeps } from "../phases/frame";
import type { Feature } from "../formation/features";
import type { ProjectPaths } from "../formation/paths";
import { parseSpec } from "../formation/spec";
import { appendAudit, AUDIT_CAPS_STORED, readAudits, type Audit, type AuditPayload } from "./audit-contract";
import { cleanupAuditSnapshot } from "./auditor-cleanup";
import type { AuditSnapshot, GitRunner } from "./git";
import { runCheck, type CheckResult, type RunCheckOptions } from "./verify";

export interface AuditorContext {
  project: ProjectPaths;
  git: GitRunner;
  attempt: number;
  builderRef: string;
  needs?: string[];
  /** Test seam; the returned directory is owned and removed by this call. */
  makeTempDir?: () => string;
  check?: (acceptance: Feature["acceptance"], options: RunCheckOptions) => Promise<CheckResult>;
  gitRun?: GitToolProcessRunner;
  now?: () => Date;
  cleanup?: (path: string) => void;
  /** Test seam; production cleanup is bounded to five seconds. */
  cleanupTimeoutMs?: number;
  /** Resume a prefix where the only prior audit/check pair was voided: recheck before any model call. */
  recoverVoided?: boolean;
}

export interface AuditorSessionResult {
  audit: Audit;
  rawVerdict: AuditVerdict;
  effectiveVerdict: AuditVerdict;
  truncated: boolean;
  malformed: boolean;
  retried: boolean;
  evidenceUsable: boolean;
  crossProvider: boolean;
  costUsd: number;
  /** The original check unless snapshot mutation forced one rebuilt-snapshot recheck. */
  check: CheckResult;
  /** The producer check/audit pair was voided and replaced from the same captured commit. */
  recoveredFromVoid: boolean;
  /** The active returned check/audit pair was itself voided by a repeat mutation. */
  finalCheckVoided: boolean;
  /** @deprecated Alias for finalCheckVoided; historical recovery is recoveredFromVoid. */
  checkVoided: boolean;
}

export type AuditorStage = "create" | "audit" | "status" | "persist" | "rebuild" | "recheck" | "fresh_audit" | "fresh_status" | "fresh_persist" | "remove" | "cleanup";

export class AuditorRunError extends Error {
  constructor(
    message: string,
    readonly result: BrainResult,
    readonly costUsd: number,
    readonly crossProvider: boolean,
    readonly stage: AuditorStage,
    readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = "AuditorRunError";
  }
}

interface ChosenAuditor {
  model: ReturnType<PhaseDeps["models"]>["model"];
  ref: string;
  crossProvider: boolean;
}

interface Evidence {
  raw: AuditPayload;
  shape: Audit["shape"];
  costUsd: number;
  truncated: boolean;
  malformed: boolean;
  retried: boolean;
  evidenceUsable: boolean;
  usdCapHit: boolean;
}

interface SpendLedger { total: number }

function resolveAuditor(deps: PhaseDeps, builderRef: string): ChosenAuditor {
  if (!deps.modelsOn || !deps.availableProviders) throw new NoModelError("auditor requires an admitted provider-restricted model resolver");
  const producer = parseModelRef(builderRef).provider;
  const errors: string[] = [];
  const other = otherProvider(producer, new Set(deps.availableProviders));
  if (other && other !== producer) {
    try {
      const seat = deps.modelsOn("auditor", other);
      if (seat.ref === builderRef) throw new NoModelError(`resolver returned producer ref ${builderRef}`);
      return { ...seat, crossProvider: true };
    } catch (error) { errors.push((error as Error).message); }
  }
  try {
    const seat = deps.modelsOn("auditor", producer, builderRef);
    if (seat.ref === builderRef) throw new NoModelError(`resolver returned producer ref ${builderRef}`);
    return { ...seat, crossProvider: false };
  } catch (error) { errors.push((error as Error).message); }
  throw new NoModelError(`no independent auditor model available for ${builderRef}: ${errors.join("; ")}`);
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.map((item) => item.trim()).filter(Boolean);
}

function storedPayload(raw: AuditPayload): { raw: AuditPayload; truncated: boolean } {
  const list = (values: string[]) => values.slice(0, AUDIT_CAPS_STORED.items).map((value) => value.slice(0, AUDIT_CAPS_STORED.itemChars));
  const stored: AuditPayload = {
    verified: list(raw.verified),
    claimedUnverified: list(raw.claimedUnverified),
    regressions: list(raw.regressions),
    nextSessionNotes: raw.nextSessionNotes.slice(0, AUDIT_CAPS_STORED.notesChars),
    checkQuality: { adequate: raw.checkQuality.adequate, reason: raw.checkQuality.reason.slice(0, AUDIT_CAPS_STORED.reasonChars) },
    verdict: raw.verdict,
  };
  return { raw: stored, truncated: JSON.stringify(stored) !== JSON.stringify(raw) };
}

function auditTool(
  check: CheckResult,
  capture: (raw: AuditPayload) => void,
  attempted: (raw: Partial<AuditPayload>) => void,
  invalid: (problem: string) => void,
): AgentTool<any> {
  const short = !check.ok;
  return {
    name: "audit",
    label: "Audit",
    intent: "omit",
    lenientArgValidation: true,
    description: short
      ? "Record regressions and next-session notes for a failed harness check."
      : "Record verified and unverified claims, regressions, check quality, and a verdict.",
    parameters: short ? {
      type: "object",
      properties: {
        regressions: { type: "array", items: { type: "string" } },
        nextSessionNotes: { type: "string" },
      },
      required: ["regressions", "nextSessionNotes"],
    } : {
      type: "object",
      properties: {
        verified: { type: "array", items: { type: "string" } },
        claimedUnverified: { type: "array", items: { type: "string" } },
        regressions: { type: "array", items: { type: "string" } },
        nextSessionNotes: { type: "string" },
        checkQuality: { type: "object", properties: { adequate: { type: "boolean" }, reason: { type: "string" } }, required: ["adequate", "reason"] },
        verdict: { type: "string", enum: ["agree", "disagree"] },
      },
      required: ["verified", "claimedUnverified", "regressions", "nextSessionNotes", "checkQuality", "verdict"],
    },
    async execute(_id, input: Record<string, unknown>) {
      const regressions = strings(input.regressions);
      if (short) {
        attempted({ regressions: regressions ?? [], nextSessionNotes: typeof input.nextSessionNotes === "string" ? input.nextSessionNotes : "" });
        if (!regressions || typeof input.nextSessionNotes !== "string") {
          const problem = "short audit requires a regressions array and nextSessionNotes string";
          invalid(problem); return fail(problem);
        }
        capture({
          verified: [], claimedUnverified: [], regressions, nextSessionNotes: input.nextSessionNotes.trim(),
          checkQuality: { adequate: false, reason: "The harness check failed; behavioral evidence is unavailable." }, verdict: "agree",
        });
        return ok("audit recorded");
      }
      const verified = strings(input.verified); const claimed = strings(input.claimedUnverified);
      const quality = input.checkQuality as Record<string, unknown> | undefined;
      const verdict = input.verdict === "agree" || input.verdict === "disagree" ? input.verdict : undefined;
      attempted({ verified: verified ?? [], claimedUnverified: claimed ?? [], regressions: regressions ?? [], nextSessionNotes: typeof input.nextSessionNotes === "string" ? input.nextSessionNotes : "", verdict });
      if (!verified || !claimed || !regressions || typeof input.nextSessionNotes !== "string" || !quality || typeof quality.adequate !== "boolean" || typeof quality.reason !== "string" || !verdict) {
        const problem = "audit requires three string arrays, nextSessionNotes, checkQuality, and verdict agree or disagree";
        invalid(problem); return fail(problem);
      }
      capture({ verified, claimedUnverified: claimed, regressions, nextSessionNotes: input.nextSessionNotes.trim(), checkQuality: { adequate: quality.adequate, reason: quality.reason.trim() }, verdict });
      return ok("audit recorded");
    },
  };
}

function auditContext(feature: Feature, check: CheckResult, milestone: string, previousNotes: string): string {
  return [
    "## Acceptance criteria (verbatim)", JSON.stringify(feature.acceptance, null, 2),
    "## Harness check evidence", `check: ${check.checkId}`, `output path: ${check.outputPath}`, `passed: ${check.ok}`, "output excerpt:", check.output || "(empty)",
    "## First milestone", milestone || "(missing)",
    "## Previous next-session notes", previousNotes || "(none)",
  ].join("\n");
}

function synthetic(attempted: Partial<AuditPayload>, problem: string, verdict: AuditVerdict): AuditPayload {
  return {
    verified: attempted.verified ?? [], claimedUnverified: attempted.claimedUnverified ?? [], regressions: attempted.regressions ?? [],
    nextSessionNotes: attempted.nextSessionNotes || `Auditor evidence unusable: ${problem}`,
    checkQuality: { adequate: false, reason: problem }, verdict,
  };
}

async function collectEvidence(
  deps: PhaseDeps,
  chosen: ChosenAuditor,
  snapshot: AuditSnapshot,
  feature: Feature,
  check: CheckResult,
  milestone: string,
  previousNotes: string,
  context: AuditorContext,
  spend: SpendLedger,
  stage: "audit" | "fresh_audit",
): Promise<Evidence> {
  let captured: AuditPayload | undefined;
  let lastAttempt: Partial<AuditPayload> = {};
  let problem = "auditor did not call audit";
  const toolContext: ToolContext = { cwd: snapshot.worktree, roots: [snapshot.worktree], run: deps.run, record: deps.record };
  const terminal = auditTool(check, (raw) => { captured = raw; }, (raw) => { lastAttempt = raw; }, (value) => { problem = value; });
  const tools = [
    recorded(toolContext, readTool(toolContext)), recorded(toolContext, searchTool(toolContext)),
    recorded(toolContext, gitLogTool(toolContext, context.gitRun)), recorded(toolContext, gitDiffTool(toolContext, context.git)),
    recorded(toolContext, terminal),
  ];
  const effort = effortFor(deps.cfg, "auditor", chosen.model);
  const brain = createBrain({
    model: chosen.model, getApiKey: () => deps.apiKeyFor(String(chosen.model.provider)), tools,
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "auditor")],
    pinned: auditContext(feature, check, milestone, previousNotes), record: deps.record, role: "auditor", phase: "build",
    turnCap: check.ok ? deps.cfg.build.auditorTurnCap : deps.cfg.build.auditorFailTurnCap,
    usdCap: deps.cfg.build.auditorUsdCap, spentUsd: () => spend.total, effort,
    streamFn: deps.streamFn, onText: deps.onText, onTool: deps.onTool, terminalTools: ["audit"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
    afterTool: (event) => event.name === "audit",
  });
  let costUsd = 0; let retried = false; let limited = false;
  for (let attempt = 0; attempt < 2 && !captured; attempt += 1) {
    retried = attempt > 0;
    const result = await brain.run(attempt === 0 ? "Inspect the detached snapshot and call audit once." : `${problem}. Call audit now with the required structured fields.`);
    costUsd += result.costUsd; spend.total += result.costUsd;
    if (captured) break;
    if (result.stopped === "refused") {
      const category = result.stopDetails?.category?.trim() || "unknown";
      problem = `auditor refused: ${category}`;
      break;
    }
    if (result.stopped === "error") throw new AuditorRunError(result.error ?? "auditor model failed", result, spend.total, chosen.crossProvider, stage, result);
    if (result.stopped === "turn_cap" || result.stopped === "usd_cap") { limited = true; problem = `auditor stopped at ${result.stopped}`; break; }
  }
  const malformed = captured === undefined && !limited;
  const verdict = lastAttempt.verdict === "disagree" ? "disagree" : "agree";
  const raw = captured ?? synthetic(lastAttempt, problem, verdict);
  const stored = storedPayload(raw);
  const truncated = limited || stored.truncated;
  return {
    raw: stored.raw, shape: check.ok ? "full" : "short", costUsd, truncated, malformed, retried,
    evidenceUsable: !truncated && !malformed,
    usdCapHit: limited || spend.total >= deps.cfg.build.auditorUsdCap,
  };
}

function persist(deps: PhaseDeps, feature: Feature, check: CheckResult, context: AuditorContext, chosen: ChosenAuditor, evidence: Evidence, checkVoided: boolean) {
  const rawVerdict = evidence.raw.verdict;
  const emptyDisagree = rawVerdict === "disagree" && evidence.raw.claimedUnverified.length === 0 && evidence.raw.regressions.length === 0;
  const evidenceUsable = evidence.evidenceUsable && !checkVoided;
  const effectiveVerdict: AuditVerdict = evidenceUsable && !emptyDisagree ? rawVerdict : "agree";
  const seq = deps.record.append({
    t: "audit", featureId: feature.id, attempt: context.attempt, checkId: check.checkId, shape: evidence.shape,
    verdict: rawVerdict, verifiedCount: evidence.raw.verified.length, claimedUnverifiedCount: evidence.raw.claimedUnverified.length,
    regressions: evidence.raw.regressions, checkQualityAdequate: evidence.raw.checkQuality.adequate,
    truncated: evidence.truncated, usdCapHit: evidence.usdCapHit, crossProvider: chosen.crossProvider, costUsd: evidence.costUsd,
  });
  const audit = appendAudit(deps.run, {
    featureId: feature.id, attempt: context.attempt, checkId: check.checkId, sourceEventSeq: seq,
    createdAt: (context.now?.() ?? new Date()).toISOString(), shape: evidence.shape, raw: evidence.raw,
    model: {
      provider: String(chosen.model.provider),
      model: chosen.model.id,
      ref: chosen.ref,
      effort: effortFor(deps.cfg, "auditor", chosen.model),
    },
  });
  deps.record.append({
    t: "audit.disposition", featureId: feature.id, attempt: context.attempt, checkId: check.checkId,
    rawVerdict, effectiveVerdict, emptyDisagree, malformed: evidence.malformed, truncated: evidence.truncated,
    retried: evidence.retried, evidenceUsable, checkVoided,
  });
  return { audit, rawVerdict, effectiveVerdict, evidenceUsable };
}

function sessionResult(
  stored: ReturnType<typeof persist>, evidence: Evidence, chosen: ChosenAuditor,
  costUsd: number, check: CheckResult, recoveredFromVoid: boolean, finalCheckVoided: boolean,
): AuditorSessionResult {
  return {
    audit: stored.audit, rawVerdict: stored.rawVerdict, effectiveVerdict: stored.effectiveVerdict,
    truncated: evidence.truncated, malformed: evidence.malformed, retried: evidence.retried,
    evidenceUsable: stored.evidenceUsable, crossProvider: chosen.crossProvider, costUsd, check,
    recoveredFromVoid, finalCheckVoided, checkVoided: finalCheckVoided,
  };
}

function asRunError(error: unknown, stage: AuditorStage, spend: SpendLedger, chosen: ChosenAuditor): AuditorRunError {
  if (error instanceof AuditorRunError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AuditorRunError(message, { text: "", turns: 0, stopped: "error", costUsd: 0, error: message }, spend.total, chosen.crossProvider, stage, error);
}

function priorAuditorSpend(deps: PhaseDeps, featureId: string, attempt: number): number {
  const events = deps.record.read();
  const pick = events.findLast((event) => event.t === "feature.pick" && event.featureId === featureId && event.attempt === attempt);
  if (!pick) return 0;
  return events.reduce((sum, event) => event.seq > pick.seq && event.t === "model.call" && event.role === "auditor" ? sum + event.costUsd : sum, 0);
}

export async function runAuditorSession(deps: PhaseDeps, feature: Feature, originalCheck: CheckResult, context: AuditorContext): Promise<AuditorSessionResult> {
  const chosen = resolveAuditor(deps, context.builderRef);
  const milestone = parseSpec(readFileSync(context.project.spec, "utf8")).sections["First milestone"]?.trim() ?? "";
  const previousNotes = readAudits(deps.run).at(-1)?.raw.nextSessionNotes ?? "";
  const tempDir = context.makeTempDir?.() ?? mkdtempSync(join(tmpdir(), "kiln-audit-"));
  const spend: SpendLedger = { total: priorAuditorSpend(deps, feature.id, context.attempt) };
  let snapshot: AuditSnapshot | undefined;
  let stage: AuditorStage = "create";
  let outcome: AuditorSessionResult | undefined;
  let primary: AuditorRunError | undefined;
  let caughtError: unknown;
  let caught = false;
  try {
    outcome = await (async () => {
      snapshot = await context.git.createAuditSnapshot(context.project.repo, tempDir);
      if (context.recoverVoided) {
        stage = "recheck";
        const check = await (context.check ?? runCheck)(feature.acceptance, {
          cwd: snapshot.worktree, checksDir: context.project.checksDir,
          timeoutMs: deps.cfg.build.checkTimeoutSeconds * 1_000, maxOutputBytes: deps.cfg.build.checkOutputBytes,
          needs: context.needs ?? [], record: deps.record, featureId: feature.id, attempt: context.attempt, phase: "acceptance",
        });
        stage = "fresh_audit";
        const evidence = await collectEvidence(deps, chosen, snapshot, feature, check, milestone, previousNotes, context, spend, "fresh_audit");
        stage = "fresh_status";
        const voided = (await context.git.statusPorcelain(snapshot.worktree)).trim() !== "";
        if (voided) deps.record.append({ t: "failure", class: "policy", message: `auditor mutated recovery snapshot for ${feature.id}; check ${check.checkId} voided` });
        stage = "fresh_persist";
        return sessionResult(persist(deps, feature, check, context, chosen, evidence, voided), evidence, chosen, spend.total, check, true, voided);
      }
      stage = "audit";
      const firstEvidence = await collectEvidence(deps, chosen, snapshot, feature, originalCheck, milestone, previousNotes, context, spend, "audit");
      stage = "status";
      const mutated = (await context.git.statusPorcelain(snapshot.worktree)).trim() !== "";
      stage = "persist";
      const first = persist(deps, feature, originalCheck, context, chosen, firstEvidence, mutated);
      if (!mutated) return sessionResult(first, firstEvidence, chosen, spend.total, originalCheck, false, false);

      deps.record.append({ t: "failure", class: "policy", message: `auditor mutated detached snapshot for ${feature.id}; original check ${originalCheck.checkId} voided` });
      stage = "rebuild";
      await context.git.rebuildAuditSnapshot(snapshot);
      stage = "recheck";
      const check = await (context.check ?? runCheck)(feature.acceptance, {
        cwd: snapshot.worktree, checksDir: context.project.checksDir,
        timeoutMs: deps.cfg.build.checkTimeoutSeconds * 1_000, maxOutputBytes: deps.cfg.build.checkOutputBytes,
        needs: context.needs ?? [], record: deps.record, featureId: feature.id, attempt: context.attempt, phase: "acceptance",
      });
      stage = "fresh_audit";
      const freshEvidence = await collectEvidence(deps, chosen, snapshot, feature, check, milestone, previousNotes, context, spend, "fresh_audit");
      stage = "fresh_status";
      const mutatedAgain = (await context.git.statusPorcelain(snapshot.worktree)).trim() !== "";
      if (mutatedAgain) deps.record.append({ t: "failure", class: "policy", message: `auditor mutated rebuilt detached snapshot for ${feature.id}; check ${check.checkId} voided` });
      stage = "fresh_persist";
      const fresh = persist(deps, feature, check, context, chosen, freshEvidence, mutatedAgain);
      return sessionResult(fresh, freshEvidence, chosen, spend.total, check, true, mutatedAgain);
    })();
  } catch (error) {
    caught = true;
    caughtError = error;
    primary = asRunError(error, stage, spend, chosen);
  }
  let cleanupFailure: AuditorRunError | undefined;
  try { if (snapshot) await cleanupAuditSnapshot(context.git, snapshot, context.cleanupTimeoutMs); }
  catch (error) { cleanupFailure = asRunError(error, "remove", spend, chosen); }
  try { (context.cleanup ?? ((path) => rmSync(path, { recursive: true, force: true })))(tempDir); }
  catch (error) { cleanupFailure ??= asRunError(error, "cleanup", spend, chosen); }
  if (caught) rethrowIfRunCancelled(caughtError);
  throwIfRunCancelled();
  if (primary) throw primary;
  if (cleanupFailure) throw cleanupFailure;
  if (!outcome) throw asRunError(new Error("auditor produced no outcome"), stage, spend, chosen);
  return outcome;
}
