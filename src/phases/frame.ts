import { readFileSync } from "node:fs";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import { createBrain, type BrainOptions, type BrainResult } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { brainTools, type ExitKind, type ToolContext } from "../brain/tools";
import type { KilnConfig, Phase, Role } from "../core/config";
import type { StopKind } from "../core/events";
import { classifyFailure, type FailureClass } from "../core/failure";
import type { Limiter } from "../core/limiter";
import type { RunRecord } from "../core/record";
import { type RunPaths, writeStatus } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
import type { ProbeSpec } from "../ideation/probe";
import { effortFor } from "../providers/models";
import { BRIEF_SECTIONS, bullets, frameContract, parseAxes, sections, shapeHash, validateBrief, type Axis, type BriefFacts } from "./contracts";
import { runValidatedFile } from "./shared";

export interface PhaseDeps {
  home: string;
  run: RunPaths;
  record: RunRecord;
  cfg: KilnConfig;
  /** One resolved model per seat; the CLI builds it from `resolveRole` over the available providers. */
  models: (role: Role) => { model: Model; ref: string };
  /** Providers admitted by the current authenticated configuration. */
  availableProviders?: ReadonlySet<string>;
  /** Resolve a role on one admitted provider, optionally excluding the producer's exact ref. */
  modelsOn?: (role: Role, provider: string, excludeRef?: string) => { model: Model; ref: string };
  apiKeyFor: (provider: string) => Promise<string | undefined>;
  streamFn?: StreamFn;
  effort: string;
  fetchImpl?: typeof fetch;
  onText?: (d: string) => void;
  onTool?: BrainOptions["onTool"];
  /** Shared across islands, scouts, probes and judge pairs (record §3). */
  limiter: Limiter;
  /** Subscription-usage snapshot used for the 95% boundary poll and reactive 429 pause. */
  fetchUsage?: (provider: string) => Promise<{ used: number; limit?: number; resetAt?: string } | undefined>;
  /** Administrative override for a live run lock. The CLI only sets this for an explicit --force. */
  forceLock?: boolean;
  /** True when an outer controller already owns `run.lock` for this whole invocation. */
  lockHeld?: boolean;
  /** Interactive display hook, called after a probe spec freezes and before its process starts. */
  onProbePreview?: (spec: ProbeSpec) => void | Promise<void>;
  /** Test/embedding override; production network searches use the tool's small default jitter. */
  searchJitterMs?: number;
}

export type PhaseResult =
  | { outcome: "ok" }
  | { outcome: "honest_exit"; kind: ExitKind; reasons: string[] }
  | { outcome: "failed"; failureClass: FailureClass; message: string }
  | { outcome: "stopped"; stopKind: StopKind; truncatedRound?: number; frontierEmpty?: boolean; budgetTargetUsd?: number; wallTargetSeconds?: number };

/**
 * How a phase must react to the way its brain stopped, when it stopped for a reason that isn't
 * "it finished". A turn cap is a spent budget, not a failed check: re-prompting a capped agent
 * only burns another call against a cap it has already hit, so the phase ends there. Any other
 * error is classified from the provider's own status where there is one, and only from the message
 * as a fallback — a refusal, a deadline, and a rate limit call for different responses, and only
 * one of them is worth retrying (record §3).
 */
export function stopFailure(phase: Phase, turnCap: number, r: BrainResult): PhaseResult | undefined {
  if (r.stopped === "turn_cap") return { outcome: "failed", failureClass: "budget", message: `turn cap ${turnCap} reached in ${phase}` };
  if (r.stopped === "usd_cap") return { outcome: "failed", failureClass: "budget", message: `dollar cap reached in ${phase}` };
  if (r.stopped === "refused") {
    const category = r.stopDetails?.category?.trim() || "unknown";
    return { outcome: "failed", failureClass: "refusal", message: `model refused in ${phase}: ${category}` };
  }
  if (r.stopped === "error") {
    const message = r.error ?? "model error";
    return { outcome: "failed", failureClass: classifyFailure({ message, status: r.errorStatus, stopDetails: r.stopDetails }), message };
  }
  return undefined;
}

export interface ParsedBrief extends BriefFacts {
  sections: Record<string, string>;
  axes: Axis[];
}

export function parseBrief(md: string): ParsedBrief {
  const s = sections(md);
  const missing = BRIEF_SECTIONS.filter((n) => !(n in s));
  const shapeRaw = (s["Shape"] ?? "").trim().toLowerCase().split(/\s/)[0];
  const shape = (["research", "product", "creative"] as const).find((x) => x === shapeRaw);
  return { sections: s, missing, shape, shapeRaw, questions: bullets(s["Discovery questions"] ?? ""), axes: parseAxes(s["Axes"] ?? "") };
}

export async function runFrame(d: PhaseDeps): Promise<PhaseResult> {
  throwIfRunCancelled();
  const turnCap = d.cfg.budgets.turns.frame;
  d.record.append({ t: "phase.start", phase: "frame" });
  let exit: { kind: ExitKind; reasons: string[] } | undefined;
  const ctx: ToolContext = { cwd: d.run.dir, roots: [d.run.dir], run: d.run, record: d.record, fetchImpl: d.fetchImpl, onExit: (kind, reasons) => { exit = { kind, reasons }; } };
  // Read through a function rather than the bare `exit` variable: TS's flow analysis for a `let`
  // mutated only inside a closure does not reliably re-widen it across an intervening `await`
  // once it has been narrowed to `undefined`, which would make later `if (exit)` checks unsound.
  const takeExit = (): { kind: ExitKind; reasons: string[] } | undefined => exit;
  const { model } = d.models("brain");
  const brain = createBrain({
    model,
    getApiKey: () => d.apiKeyFor(String(model.provider)),
    tools: brainTools(ctx, "frame"),
    systemPrompt: [loadPrompt(d.home, "kernel"), loadPrompt(d.home, "brain"), `## Playbook (frame)\n${playbookSection(loadPlaybook(d.home), "frame")}`],
    pinned: frameContract(d.run, turnCap),
    record: d.record,
    role: "brain",
    phase: "frame",
    turnCap,
    effort: effortFor(d.cfg, "brain", model),
    streamFn: d.streamFn,
    onText: d.onText,
    onTool: d.onTool,
    shaping: { cfg: d.cfg, runId: d.run.id },
  });
  const finish = (res: PhaseResult, parsed?: ParsedBrief): PhaseResult => {
    d.record.append({ t: "phase.end", phase: "frame", outcome: res.outcome });
    // The shape is frozen here and nowhere else: later phases refuse to start on a mismatch.
    if (res.outcome === "ok") writeStatus(d.run, { phase: "discover", shape: parsed?.shape, shapeHash: parsed ? shapeHash(parsed) : undefined });
    else if (res.outcome === "honest_exit") writeStatus(d.run, { state: "done", outcome: { kind: "honest_exit", exitKind: res.kind, reasons: res.reasons } });
    else if (res.outcome === "failed") writeStatus(d.run, { state: "failed", outcome: { kind: "failure", failureClass: res.failureClass, message: res.message } });
    else writeStatus(d.run, { state: "stopped", outcome: { kind: "stopped", stopKind: res.stopKind, truncatedRound: res.truncatedRound, frontierEmpty: res.frontierEmpty } });
    return res;
  };

  const seed = readFileSync(d.run.seed, "utf8");
  const v = await runValidatedFile({
    brain,
    path: d.run.brief,
    parse: parseBrief,
    validate: validateBrief,
    prompt: `Seed:\n${seed}\nWrite ${d.run.brief} now.`,
    fix: (problems, path) => `${path} is not usable yet:\n${problems.map((p) => `- ${p}`).join("\n")}\nRewrite the whole file with every required section, fixed.`,
    halt: (r) => takeExit() !== undefined || stopFailure("frame", turnCap, r) !== undefined,
  });

  const exited = takeExit();
  if (exited) return finish({ outcome: "honest_exit", ...exited });
  const stop = stopFailure("frame", turnCap, v.result);
  if (stop) return finish(stop);
  if (v.problems.length > 0) return finish({ outcome: "failed", failureClass: "verify", message: `brief is not usable: ${v.problems.join("; ")}` });
  return finish({ outcome: "ok" }, v.parsed);
}
