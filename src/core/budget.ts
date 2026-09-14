import { PHASES, type BudgetConfig, type KilnConfig, type Phase } from "./config";
import type { StoredEvent } from "./events";

export type PhaseAmounts = Partial<Record<Phase, number>>;

/** The protected reflect reserve cannot exceed reflect's configured share on a smaller run. */
export function effectiveReflectReserveUsd(budgets: BudgetConfig): number {
  return Math.min(budgets.reflectReserveUsd, budgets.phaseBudgetUsd("reflect"));
}

function through(phase: Phase): readonly Phase[] {
  return PHASES.slice(0, PHASES.indexOf(phase) + 1);
}

function total(amounts: PhaseAmounts, phases: readonly Phase[]): number {
  return phases.reduce((sum, phase) => sum + (amounts[phase] ?? 0), 0);
}

/**
 * Dollar headroom at a phase boundary. Frame through build use a cumulative forward ledger;
 * reflect is the deliberate exception and always receives its protected minimum.
 */
export function phaseAvailableUsd(budgets: BudgetConfig, phase: Phase, spentByPhase: PhaseAmounts): number {
  if (phase === "reflect") {
    return Math.max(effectiveReflectReserveUsd(budgets), budgets.usd - total(spentByPhase, PHASES.filter((p) => p !== "reflect")));
  }
  const phases = through(phase);
  const allocated = phases.reduce((sum, item) => sum + budgets.phaseBudgetUsd(item), 0);
  return Math.max(0, allocated - total(spentByPhase, phases));
}

/** Wall-clock analogue of phaseAvailableUsd, including reflect's protected base share. */
export function phaseAvailableWallSeconds(budgets: BudgetConfig, phase: Phase, elapsedByPhase: PhaseAmounts): number {
  if (phase === "reflect") {
    return Math.max(budgets.phaseBudgetWallSeconds("reflect"), budgets.wallSeconds - total(elapsedByPhase, PHASES.filter((p) => p !== "reflect")));
  }
  const phases = through(phase);
  const allocated = phases.reduce((sum, item) => sum + budgets.phaseBudgetWallSeconds(item), 0);
  return Math.max(0, allocated - total(elapsedByPhase, phases));
}

/**
 * Cumulative wall headroom for a frozen execution that deliberately omits later phases. Shares of
 * those unrequested future phases remain inside the same total and may support cached completion
 * or later active work; requested future phases are never reclaimed. Callers decide which work is
 * eligible to use this envelope—the ordinary phase ledger above still governs initial research.
 */
export function phaseAvailableExecutionWallSeconds(
  budgets: BudgetConfig,
  phase: Phase,
  elapsedByPhase: PhaseAmounts,
  activePhases: readonly Phase[],
): number {
  const throughCurrent = through(phase);
  const active = new Set(activePhases);
  const after = PHASES.slice(PHASES.indexOf(phase) + 1);
  const unrequestedFuture = after.filter((candidate) => !active.has(candidate));
  const credited = [...throughCurrent, ...unrequestedFuture];
  const allocated = credited.reduce((sum, item) => sum + budgets.phaseBudgetWallSeconds(item), 0);
  const withinExecution = Math.max(0, allocated - total(elapsedByPhase, credited));
  const withinRun = Math.max(0, budgets.wallSeconds - total(elapsedByPhase, PHASES));
  return Math.min(withinExecution, withinRun);
}

/** Refuse-to-start planning floor; turn-boundary overshoot means this is not a hard cost bound. */
export function attemptCeiling(cfg: Pick<KilnConfig, "build">): number {
  return cfg.build.builderUsdCap + cfg.build.auditorUsdCap;
}

/** Dollars per phase from the journal: each model call is charged to the phase of the last `phase.start`, frame by default. */
export function spentByPhase(events: readonly StoredEvent[]): PhaseAmounts {
  const out: PhaseAmounts = {};
  let phase: Phase = "frame";
  for (const event of events) {
    if (event.t === "phase.start") phase = event.phase;
    if (event.t === "model.call") out[phase] = (out[phase] ?? 0) + event.costUsd;
  }
  return out;
}

/** Wall seconds per phase: first `phase.start` to `phase.end`, an open phase counted to `nowMs`, a re-opened phase accumulated. */
export function elapsedByPhase(events: readonly StoredEvent[], nowMs: number): PhaseAmounts {
  const out: PhaseAmounts = {};
  const starts = new Map<Phase, number>();
  for (const event of events) {
    if (event.t === "phase.start" && !starts.has(event.phase)) starts.set(event.phase, Date.parse(event.ts));
    if (event.t === "phase.end") {
      const start = starts.get(event.phase);
      const end = Date.parse(event.ts);
      if (start !== undefined && Number.isFinite(start) && Number.isFinite(end)) out[event.phase] = (out[event.phase] ?? 0) + Math.max(0, end - start) / 1_000;
      starts.delete(event.phase);
    }
  }
  for (const [phase, start] of starts) if (Number.isFinite(start)) out[phase] = (out[phase] ?? 0) + Math.max(0, nowMs - start) / 1_000;
  return out;
}
