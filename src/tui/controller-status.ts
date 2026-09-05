import type { RunStatus } from "../core/run";
import type { TuiSnapshot } from "./contracts";

export const INITIAL_TUI_SNAPSHOT: TuiSnapshot = {
  phase: "frame",
  state: "idle",
  costUsd: 0,
  directory: process.cwd(),
  effort: "medium",
  transcript: [],
};

export function isTerminalRun(status: RunStatus): boolean {
  return status.state === "done"
    || status.state === "failed"
    || status.outcome?.kind === "success"
    || status.outcome?.kind === "honest_exit"
    || status.outcome?.kind === "failure";
}
