import { writeStatus } from "../core/run";
import type { PhaseDeps, PhaseResult } from "../phases/frame";
import { writeMetrics } from "./metrics";

function bestEffortMetrics(deps: PhaseDeps): void { try { writeMetrics(deps.run); } catch { /* status and failure record remain authoritative */ } }

export function buildFail(deps: PhaseDeps, failureClass: "integrity" | "verify", message: string): PhaseResult {
  deps.record.append({ t: "failure", class: failureClass, message });
  deps.record.append({ t: "phase.end", phase: "build", outcome: "failed" });
  writeStatus(deps.run, { phase: "build", state: "failed", outcome: { kind: "failure", failureClass, message } });
  bestEffortMetrics(deps);
  return { outcome: "failed", failureClass, message };
}

export function buildStop(deps: PhaseDeps, stopKind: "blocked" | "deadline" | "transient" | "budget"): PhaseResult {
  const targets = stopKind === "budget" || stopKind === "deadline" ? { budgetTargetUsd: deps.cfg.budgets.usd, wallTargetSeconds: deps.cfg.budgets.wallSeconds } : {};
  deps.record.append({ t: "stop", stopKind, ...targets });
  deps.record.append({ t: "phase.end", phase: "build", outcome: "stopped" });
  writeStatus(deps.run, { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind, ...targets } });
  bestEffortMetrics(deps);
  return { outcome: "stopped", stopKind, ...targets };
}

export function buildSuccess(deps: PhaseDeps): PhaseResult {
  deps.record.append({ t: "phase.end", phase: "build", outcome: "ok" });
  writeStatus(deps.run, { phase: "reflect", state: "running", outcome: undefined, cursor: { step: "complete" } });
  bestEffortMetrics(deps);
  return { outcome: "ok" };
}

export function buildHonest(deps: PhaseDeps, reasons: string[]): PhaseResult {
  deps.record.append({ t: "honest_exit", kind: "cannot_be_satisfied", reasons, source: "declared" });
  deps.record.append({ t: "phase.end", phase: "build", outcome: "honest_exit" });
  writeStatus(deps.run, { phase: "build", state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied", reasons } });
  bestEffortMetrics(deps);
  return { outcome: "honest_exit", kind: "cannot_be_satisfied", reasons };
}

export function buildPause(deps: PhaseDeps, reason: string, wakeAt: string): PhaseResult {
  deps.record.append({ t: "pause", reason, wakeAt });
  deps.record.append({ t: "phase.end", phase: "build", outcome: "paused" });
  writeStatus(deps.run, { phase: "build", state: "paused", outcome: undefined, pausedReason: reason, wakeAt });
  bestEffortMetrics(deps);
  return { outcome: "ok" };
}
