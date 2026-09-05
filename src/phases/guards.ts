import { readFileSync } from "node:fs";
import { readStatus, writeStatus } from "../core/run";
import { shapeHash } from "./contracts";
import { parseBrief, type PhaseDeps, type PhaseResult } from "./frame";

/** Re-assert the idea shape frozen at frame exit before any later phase records phase.start. */
export function assertShapeFrozen(d: PhaseDeps): PhaseResult | undefined {
  let brief: string;
  try {
    brief = readFileSync(d.run.brief, "utf8");
  } catch (error) {
    const message = `cannot read the brief at ${d.run.brief}: ${(error as Error).message}`;
    d.record.append({ t: "failure", class: "integrity", message });
    writeStatus(d.run, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } });
    return { outcome: "failed", failureClass: "integrity", message };
  }

  const parsedBrief = parseBrief(brief);
  const status = readStatus(d.run);
  const actual = shapeHash(parsedBrief);
  if (status.shapeHash !== undefined && status.shapeHash !== actual) {
    const message = `the brief's idea shape changed since frame (frozen ${status.shape ?? "unknown"}/${status.shapeHash.slice(0, 12)}, brief now ${parsedBrief.shape ?? "unknown"}/${actual.slice(0, 12)}); start a new run`;
    d.record.append({ t: "failure", class: "integrity", message });
    writeStatus(d.run, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } });
    return { outcome: "failed", failureClass: "integrity", message };
  }
  return undefined;
}
