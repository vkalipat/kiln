import type { KilnConfig, Phase } from "../../core/config";
import type { RunStatus } from "../../core/run";

export type ResumePhase = Phase | "checkpoint";
export type ResumeRoute =
  | { kind: "phase"; phase: ResumePhase; wake?: true }
  | { kind: "wait"; wakeAt?: string }
  | { kind: "stop"; message: string }
  | { kind: "refuse"; message: string };

function increased(current: number, target: number | undefined): boolean {
  return target !== undefined && current > target;
}

/** Pure implementation of record §12's phase-specific resume table. */
export function routeResume(status: RunStatus, hasFrontier: boolean, cfg: KilnConfig, nowMs = Date.now()): ResumeRoute {
  if (status.state === "running") return { kind: "phase", phase: status.phase };

  if (status.state === "paused") {
    if (status.pausedReason === "user_cancelled") return { kind: "phase", phase: status.phase, wake: true };
    const wake = status.wakeAt ? Date.parse(status.wakeAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(wake) || wake > nowMs) return { kind: "wait", ...(status.wakeAt ? { wakeAt: status.wakeAt } : {}) };
    return { kind: "phase", phase: status.phase, wake: true };
  }

  if (status.state === "done") {
    if (status.outcome?.kind === "honest_exit") return { kind: "refuse", message: "run ended with an honest exit; use `kiln project relock <run> --confirm` to reopen build" };
    return { kind: "refuse", message: "run is complete" };
  }

  if (status.state === "failed") {
    if (status.outcome?.failureClass === "integrity") return { kind: "refuse", message: "run failed an integrity check; use `kiln project relock <run> --confirm` after reviewing the project" };
    return { kind: "refuse", message: status.outcome?.message ?? "run failed" };
  }

  const stop = status.outcome?.stopKind;
  if (status.phase === "ideate") {
    if (stop === "rounds" || stop === "stagnant") return { kind: "phase", phase: "checkpoint" };
    if (stop === "stalled") return { kind: "phase", phase: "ideate" };
    if (stop === "budget") {
      if (hasFrontier) return { kind: "phase", phase: "checkpoint" };
      if (increased(cfg.budgets.usd, status.outcome?.budgetTargetUsd)) return { kind: "phase", phase: "ideate" };
      return { kind: "stop", message: `ideation budget stop remains at $${cfg.budgets.usd.toFixed(2)}; increase budgets.usd to resume` };
    }
  }

  if (status.phase === "build") {
    if (stop === "transient" || stop === "blocked") return { kind: "phase", phase: "build" };
    if (stop === "budget") {
      if (increased(cfg.budgets.usd, status.outcome?.budgetTargetUsd)) return { kind: "phase", phase: "build" };
      return { kind: "stop", message: `build budget stop remains at $${cfg.budgets.usd.toFixed(2)}; increase budgets.usd to resume` };
    }
    if (stop === "deadline") {
      if (increased(cfg.budgets.wallSeconds, status.outcome?.wallTargetSeconds)) return { kind: "phase", phase: "build" };
      return { kind: "stop", message: `build deadline remains at ${cfg.budgets.wallSeconds}s; increase budgets.wallSeconds to resume` };
    }
  }

  return { kind: "stop", message: `run is stopped in ${status.phase}${stop ? ` (${stop})` : ""}` };
}
