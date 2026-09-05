import { existsSync, readFileSync } from "node:fs";
import { readAudits, type Audit } from "../build/audit-contract";
import { foldState } from "../build/state";
import { RunRecord } from "../core/record";
import { readStatus, type RunPaths, type RunStatus } from "../core/run";
import { parseFeatures, type FeaturesFile } from "../formation/features";

export interface ProjectFeatureSummary {
  id: string;
  title: string;
  state: string;
  passes: boolean;
  attempts: number;
  repairs: number;
  blocked?: true;
  blockedReason?: string;
  regressedBy?: string;
  passSource?: "executed" | "human";
  commitSha?: string;
}

export interface ProjectSummary {
  id: string;
  dir: string;
  projectDir?: string;
  status: RunStatus;
  costUsd: number;
  outcome: RunStatus["outcome"];
  features: ProjectFeatureSummary[];
}

/** Read only the run-side authoritative copies and folds; project mirrors never participate. */
export function projectSummary(run: RunPaths): ProjectSummary {
  const status = readStatus(run);
  let features: ProjectFeatureSummary[] = [];
  if (existsSync(run.features)) {
    const file = parseFeatures(readFileSync(run.features, "utf8")) as FeaturesFile;
    const state = foldState(run);
    features = file.features.map((feature) => {
      const held = state[feature.id]!;
      return {
        id: feature.id, title: feature.title, state: held.state, passes: held.passes,
        attempts: held.attempts, repairs: held.repairs,
        ...(held.blocked ? { blocked: true as const } : {}),
        ...(held.blockedReason ? { blockedReason: held.blockedReason } : {}),
        ...(held.regressedBy ? { regressedBy: held.regressedBy } : {}),
        ...(held.passSource ? { passSource: held.passSource } : {}),
        ...(held.passCommitShas.at(-1) ? { commitSha: held.passCommitShas.at(-1) } : {}),
      };
    });
  }
  return { id: run.id, dir: run.dir, ...(status.projectDir ? { projectDir: status.projectDir } : {}), status, costUsd: new RunRecord(run.record).costUsd(), outcome: status.outcome, features };
}

/** Latest durable audit per feature, preserving each feature's first-seen display order. */
export function latestAudits(run: RunPaths): Audit[] {
  const latest = new Map<string, Audit>();
  for (const audit of readAudits(run)) latest.set(audit.featureId, audit);
  return [...latest.values()];
}
