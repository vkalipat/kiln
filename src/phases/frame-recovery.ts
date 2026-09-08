import { readFileSync } from "node:fs";
import { acquireRunLock } from "../core/lock";
import { RunRecord } from "../core/record";
import { readStatus, writeStatus, type RunPaths } from "../core/run";
import { shapeHash, validateBrief } from "./contracts";
import { parseBrief } from "./frame";

/** Repair only the historical false-negative final-turn frame failure. No provider or brief edits. */
export function recoverCompletedFrame(run: RunPaths): void {
  const lock = acquireRunLock(run);
  try {
    const status = readStatus(run);
    if (status.phase !== "frame" || status.state !== "failed" || status.outcome?.failureClass !== "budget"
      || !/^turn cap \d+ reached in frame$/.test(status.outcome.message ?? "")) {
      throw new Error("only a frame turn-cap failure with an existing valid brief can be recovered");
    }
    const parsed = parseBrief(readFileSync(run.brief, "utf8"));
    const problems = validateBrief(parsed);
    if (problems.length) throw new Error(`brief still fails validation: ${problems.join("; ")}`);
    const record = new RunRecord(run.record);
    record.append({ t: "note", text: `Recovered historical frame turn-cap false failure (${status.outcome.message}): existing brief passed the frame contract. No model call, artifact rewrite, or budget increase. Original failed phase event remains in the journal.` });
    writeStatus(run, { phase: "discover", state: "running", shape: parsed.shape, shapeHash: shapeHash(parsed), outcome: undefined, usdSpent: record.costUsd() });
  } finally { lock.release(); }
}
