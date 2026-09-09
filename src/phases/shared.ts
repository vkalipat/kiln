import { existsSync, readFileSync } from "node:fs";
import type { BrainResult } from "../brain/agent";
import { elapsedByPhase } from "../core/budget";
import { PHASES, type BudgetConfig } from "../core/config";
import type { RunRecord } from "../core/record";

/** The part of a brain this helper needs; anything that answers a prompt will do. */
export interface Promptable {
  run(prompt: string): Promise<BrainResult>;
}

/** Remaining accumulated active wall time across all phases. */
export function remainingRunWallMs(budgets: BudgetConfig, record: RunRecord, nowMs = Date.now()): number {
  const elapsed = elapsedByPhase(record.read(), nowMs);
  const usedSeconds = PHASES.reduce((sum, phase) => sum + (elapsed[phase] ?? 0), 0);
  return Math.max(0, budgets.wallSeconds * 1_000 - usedSeconds * 1_000);
}

export interface DisposableDeadline {
  signal: AbortSignal;
  /** Cancels the pending timer without aborting completed work. Idempotent. */
  dispose(): void;
}

/** An absolute timeout signal whose timer neither owns process liveness nor survives its work. */
export function createDisposableDeadline(ms: number): DisposableDeadline {
  const controller = new AbortController();
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    active = false;
    const error = new Error("run wall deadline reached");
    error.name = "TimeoutError";
    controller.abort(error);
  }, Math.max(1, Math.ceil(ms)));
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      if (!active) return;
      active = false;
      clearTimeout(timer);
    },
  };
}

export interface ValidatedFileOptions<T> {
  brain: Promptable;
  /** The file the brain is asked to write. */
  path: string;
  parse: (md: string) => T;
  /** Empty means the file is good; every string is one problem to hand back. */
  validate: (parsed: T) => string[];
  /** The first prompt. */
  prompt: string;
  /** Builds the corrective prompt from the problems found. */
  fix: (problems: string[], path: string) => string;
  /** Stop before the next attempt — an honest exit or a spent turn cap, which a re-ask cannot fix. */
  halt?: (r: BrainResult) => boolean;
  /** Called once for every completed brain.run, including the corrective re-ask. */
  onResult?: (r: BrainResult) => void;
  /** Total prompts, the first included. Default 2: write, then one re-ask. */
  attempts?: number;
}

export interface ValidatedFileResult<T> {
  /** The last brain result, for the caller's own stop and exit handling. */
  result: BrainResult;
  /** Empty when the file validated; otherwise the problems from the final attempt. */
  problems: string[];
  parsed?: T;
  /** True when `halt` ended the loop before another prompt. The completed turn's file is still judged. */
  halted: boolean;
  /** How many prompts were actually sent. */
  attempts: number;
}

/**
 * The write-then-check-then-re-ask loop that frame and discover both run (record §12.3).
 *
 * The file on disk is the output, so a missing file is validated as empty content rather than
 * thrown: "the brain never wrote it" and "the brain wrote it wrong" deserve the same one corrective
 * prompt. Ideate does not use this — it orchestrates its steps directly.
 */
export async function runValidatedFile<T>(o: ValidatedFileOptions<T>): Promise<ValidatedFileResult<T>> {
  const max = Math.max(1, o.attempts ?? 2);
  let result = await o.brain.run(o.prompt);
  for (let attempt = 1; ; attempt++) {
    o.onResult?.(result);
    const parsed = o.parse(existsSync(o.path) ? readFileSync(o.path, "utf8") : "");
    const problems = o.validate(parsed);
    // A cap or exit prevents another dispatch; it does not erase the output of the turn that just
    // completed. Return that observation to the phase so it can accept only the stop states whose
    // contract permits an already-valid artifact (turn/dollar caps, never an error/refusal).
    if (o.halt?.(result) === true) return { result, problems, parsed, halted: true, attempts: attempt };
    if (problems.length === 0 || attempt >= max) return { result, problems, parsed, halted: false, attempts: attempt };
    result = await o.brain.run(o.fix(problems, o.path));
  }
}
