import { existsSync, readFileSync } from "node:fs";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { builderTools, type ExitKind, type ToolContext } from "../brain/tools";
import { StallDetector } from "../core/failure";
import type { PhaseDeps } from "../phases/frame";
import type { Feature } from "../formation/features";
import type { ProjectPaths } from "../formation/paths";
import { effortFor } from "../providers/models";
import { pinAudit, readAudits, renderAudit, type Audit } from "./audit-contract";
import type { GitRunner } from "./git";
import { parseProgress, pinProgress, type ProgressEntry } from "./progress";

export const BUILDER_PINNED_CHARS = 8_000;
export const BUILDER_AUDIT_CHARS = 3_000;
export const BUILDER_PROGRESS_CHARS = 2_500;
export const BUILDER_CONTRACT_CHARS = 2_500;

if (BUILDER_AUDIT_CHARS + BUILDER_PROGRESS_CHARS + BUILDER_CONTRACT_CHARS !== BUILDER_PINNED_CHARS) {
  throw new Error("builder pinned allocations must sum to 8000 characters");
}

export interface BuildContractContext {
  attempt: number;
  remainingUsd: number;
  remainingTurns: number;
  audit?: Audit;
  progress?: readonly ProgressEntry[];
}

export interface BuilderRunContext {
  project: ProjectPaths;
  git: GitRunner;
  attempt: number;
  audit?: Audit;
  progress?: readonly ProgressEntry[];
  turnCap?: number;
  usdCap?: number;
}

export interface BuilderSessionResult {
  stopped: BrainResult["stopped"];
  stopDetails?: BrainResult["stopDetails"];
  turns: number;
  costUsd: number;
  exitReasons?: string[];
  stalled?: { tool: string; fingerprint: string };
  selfVerified: boolean;
  headMoved: boolean;
  contextPressure: boolean;
  pinnedTruncated: boolean;
  builderModelRef: string;
  beforeHead: string;
  afterHead: string;
  error?: string;
  errorStatus?: number;
  errorId?: string;
}

export interface BuilderDriverOptions {
  project: ProjectPaths;
  git: GitRunner;
  turnCap: number;
  usdCap: number;
  /** Spend from outside this persistent driver but inside the same capped unit. */
  priorSpentUsd?: () => number;
  priorTurns?: () => number;
}

export interface BuilderFeatureContext {
  attempt: number;
  audit?: Audit;
  progress?: readonly ProgressEntry[];
}

export interface BuilderDriver {
  runFeature(feature: Feature, context: BuilderFeatureContext): Promise<BuilderSessionResult>;
  readonly spentUsd: number;
  readonly turns: number;
}

interface ContractResult { text: string; pinnedTruncated: boolean }

function cap(text: string, limit: number): { text: string; truncated: boolean } {
  if (limit <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= limit) return { text, truncated: false };
  const suffix = text.endsWith("\n") && limit >= 2 ? "…\n" : "…";
  return { text: `${text.slice(0, limit - suffix.length)}${suffix}`, truncated: true };
}

function field(text: string, limit: number): { text: string; truncated: boolean } {
  return cap(text.replace(/\s+/g, " ").trim(), limit);
}

function acceptance(feature: Feature): string {
  const check = feature.acceptance;
  if (check.type === "shell") return `shell command: ${check.command}${check.expect ? `\nexpected ${check.expect.type}: ${check.expect.value}` : ""}`;
  if (check.type === "file") return `file check: ${check.path}${check.contains !== undefined ? ` contains ${JSON.stringify(check.contains)}` : ""}`;
  return `manual check: ${check.instructions}`;
}

function selectedProgress(entries: readonly ProgressEntry[], featureId: string): ProgressEntry[] {
  const selected = new Set([
    ...entries.filter((entry) => entry.featureId === featureId).slice(-2).map((entry) => entry.key),
    ...entries.slice(-3).map((entry) => entry.key),
  ]);
  return entries.filter((entry) => selected.has(entry.key));
}

function progressChunk(entries: readonly ProgressEntry[], featureId: string): { text: string; truncated: boolean } {
  const selected = selectedProgress(entries, featureId).map((entry) => ({ key: entry.key, text: pinProgress(entry), shortened: pinProgress(entry) !== entry.text }));
  let truncated = selected.some((entry) => entry.shortened);
  let body = selected;
  const render = () => `## Progress\n${body.length === 0 ? "(none)" : body.map((entry) => entry.text).join("\n\n")}\n`;
  while (render().length > BUILDER_PROGRESS_CHARS && body.length > 0) {
    body = body.slice(1);
    truncated = true;
  }
  const fitted = cap(render(), BUILDER_PROGRESS_CHARS);
  return { text: fitted.text, truncated: truncated || fitted.truncated };
}

function auditChunk(audit: Audit | undefined): { text: string; truncated: boolean } {
  if (!audit) return { text: "## Latest audit\n(none)\n", truncated: false };
  const pinned = pinAudit(audit);
  const projected = `## Latest audit\n${renderAudit(pinned)}`;
  const fitted = cap(projected, BUILDER_AUDIT_CHARS);
  return { text: fitted.text, truncated: fitted.truncated || JSON.stringify(pinned.raw) !== JSON.stringify(audit.raw) };
}

function contractChunk(project: ProjectPaths, feature: Feature, context: BuildContractContext): { text: string; truncated: boolean } {
  const id = field(feature.id, 32);
  const title = field(feature.title, 160);
  const repo = field(project.repo, 240);
  const scratch = field(`${project.repo}/.kiln-scratch/`, 260);
  const description = field(feature.description, 600);
  const oracle = acceptance(feature);
  const mandatory = [
    "## Build contract", `Feature: ${id.text} — ${title.text}`, `Attempt: ${context.attempt}`,
    "the harness runs this check after your session and the harness's run is the only one that counts",
    "", "## Acceptance", oracle,
    `Repository: ${repo.text}`,
    `Scratch: ${scratch.text}`,
    "The frozen plan is not yours to write.",
    "If this feature genuinely cannot be satisfied, call exit with cannot_be_satisfied and concrete reasons. The harness still runs the check.",
    `Remaining budget: $${Math.max(0, context.remainingUsd).toFixed(4)}.`,
    "",
  ].join("\n");
  if (mandatory.length > BUILDER_CONTRACT_CHARS) {
    throw new Error(`builder acceptance contract exceeds ${BUILDER_CONTRACT_CHARS} characters; reform with a smaller executable oracle`);
  }
  const label = "## Description\n";
  const allowance = BUILDER_CONTRACT_CHARS - mandatory.length;
  let text = mandatory;
  let descriptionTruncated = description.truncated;
  if (description.text !== "" && allowance > label.length) {
    const fitted = cap(`${description.text}\n`, allowance - label.length);
    text += `${label}${fitted.text}`;
    descriptionTruncated ||= fitted.truncated;
  } else if (description.text !== "") {
    descriptionTruncated = true;
  }
  return { text, truncated: id.truncated || title.truncated || repo.truncated || scratch.truncated || descriptionTruncated };
}

export function buildContractDetailed(project: ProjectPaths, feature: Feature, context: BuildContractContext): ContractResult {
  const contract = contractChunk(project, feature, context);
  const audit = auditChunk(context.audit);
  const progress = progressChunk(context.progress ?? [], feature.id);
  const text = `${contract.text}${audit.text}${progress.text}`;
  if (text.length > BUILDER_PINNED_CHARS) throw new Error(`builder pinned block exceeded ${BUILDER_PINNED_CHARS} characters`);
  return { text, pinnedTruncated: contract.truncated || audit.truncated || progress.truncated };
}

export function buildContract(project: ProjectPaths, feature: Feature, context: BuildContractContext): string {
  return buildContractDetailed(project, feature, context).text;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function defaultProgress(project: ProjectPaths): ProgressEntry[] {
  return existsSync(project.progress) ? parseProgress(readFileSync(project.progress, "utf8")) : [];
}

function defaultAudit(deps: PhaseDeps, featureId: string): Audit | undefined {
  return readAudits(deps.run).findLast((audit) => audit.featureId === featureId);
}

/** One persistent builder handle. Arm A creates one per attempt; arm B retains it across features. */
export function createBuilderDriver(deps: PhaseDeps, options: BuilderDriverOptions): BuilderDriver {
  const seat = deps.models("builder");
  let completedSpend = 0;
  let completedTurns = 0;
  let currentFeature: Feature | undefined;
  let currentAttempt = 0;
  let exitReasons: string[] | undefined;
  let stalled: { tool: string; fingerprint: string } | undefined;
  let selfVerified = false;
  let detector = new StallDetector();
  let active = false;
  const toolContext: ToolContext = {
    cwd: options.project.repo,
    roots: [options.project.repo],
    run: deps.run,
    record: deps.record,
    allowedExitKinds: ["cannot_be_satisfied"],
    onExit: (kind: ExitKind, reasons: string[]) => { if (kind === "cannot_be_satisfied") exitReasons = [...reasons]; },
  };
  const brain = createBrain({
    model: seat.model,
    getApiKey: () => deps.apiKeyFor(String(seat.model.provider)),
    tools: builderTools(toolContext),
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "builder"), `## Playbook (build)\n${playbookSection(loadPlaybook(deps.home), "build")}`],
    pinned: "Builder session is waiting for a feature contract.",
    record: deps.record,
    role: "builder",
    phase: "build",
    turnCap: options.turnCap,
    usdCap: options.usdCap,
    spentUsd: () => (options.priorSpentUsd?.() ?? 0) + completedSpend,
    priorTurns: options.priorTurns,
    effort: effortFor(deps.cfg, "builder", seat.model),
    streamFn: deps.streamFn,
    onText: deps.onText,
    onTool: deps.onTool,
    shaping: { cfg: deps.cfg, runId: deps.run.id },
    afterTool: (event) => {
      if (event.name === "bash" && currentFeature?.acceptance.type === "shell") {
        const actual = normalizeCommand(String((event.args as { command?: unknown } | undefined)?.command ?? ""));
        const expected = normalizeCommand(currentFeature.acceptance.command);
        if (expected !== "" && actual.includes(expected)) selfVerified = true;
      }
      if (!stalled && detector.observe(event.name, event.excerpt ?? "")) {
        stalled = { tool: detector.tool ?? event.name, fingerprint: detector.fingerprint ?? "" };
        deps.record.append({ t: "stall", featureId: currentFeature?.id ?? "unknown", attempt: currentAttempt, ...stalled });
        return true;
      }
      return false;
    },
  });

  return {
    get spentUsd() { return completedSpend; },
    get turns() { return completedTurns; },
    async runFeature(feature, context) {
      if (active) throw new Error("builder driver is already running");
      active = true;
      try {
        currentFeature = feature;
        currentAttempt = context.attempt;
        exitReasons = undefined;
        stalled = undefined;
        selfVerified = false;
        detector = new StallDetector();
        const remainingUsd = options.usdCap - (options.priorSpentUsd?.() ?? 0) - completedSpend;
        const remainingTurns = options.turnCap - completedTurns;
        const contract = buildContractDetailed(options.project, feature, {
          attempt: context.attempt,
          remainingUsd,
          remainingTurns,
          audit: context.audit ?? defaultAudit(deps, feature.id),
          progress: context.progress ?? defaultProgress(options.project),
        });
        brain.pushContract(contract.text);
        const before = await options.git.revParseHead(options.project.repo);
        const result = await brain.run(`Implement exactly ${feature.id}: ${feature.title}. Use the supplied feature contract and finish the repository work now.`);
        completedSpend += result.costUsd;
        completedTurns += result.turns;
        const after = await options.git.revParseHead(options.project.repo);
        return {
          stopped: result.stopped, stopDetails: result.stopDetails, turns: result.turns, costUsd: result.costUsd,
          exitReasons, stalled, selfVerified, headMoved: before !== after,
          contextPressure: result.contextPressure === true, pinnedTruncated: contract.pinnedTruncated,
          builderModelRef: seat.ref, beforeHead: before, afterHead: after,
          error: result.error, errorStatus: result.errorStatus, errorId: result.errorId,
        };
      } finally {
        active = false;
      }
    },
  };
}

/** Arm A convenience: a fresh underlying agent for exactly one feature attempt. */
export async function runBuilderSession(deps: PhaseDeps, feature: Feature, context: BuilderRunContext): Promise<BuilderSessionResult> {
  const driver = createBuilderDriver(deps, {
    project: context.project,
    git: context.git,
    turnCap: context.turnCap ?? deps.cfg.build.sessionTurnCap,
    usdCap: context.usdCap ?? deps.cfg.build.builderUsdCap,
  });
  return driver.runFeature(feature, context);
}
