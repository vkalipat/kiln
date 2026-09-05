import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { IdeaShape, Phase } from "./config";
import type { StopKind } from "./events";
import type { FailureClass } from "./failure";
import { ensureDir, runsDir, writeAtomic } from "./paths";

export interface RunPaths {
  id: string;
  dir: string;
  seed: string;
  brief: string;
  landscape: string;
  discoveryDir: string;
  ideasDir: string;
  /** `ideas/raw/r<n>-i<k>.md`: the island session's unit of idempotence. */
  rawIdeasDir: string;
  /** `ideas/rendered/<id>-r<round>.md`: one judge-facing render per idea per round. */
  renderedDir: string;
  toolOutputDir: string;
  criteriaDir: string;
  probesDir: string;
  notes: string;
  record: string;
  status: string;
  tournament: string;
  frontier: string;
  metrics: string;
  lock: string;
  project: string;
  features: string;
  acceptanceLock: string;
  featureState: string;
  audits: string;
  reflectDir: string;
  digest: string;
}

export interface RunOutcome {
  kind: "success" | "honest_exit" | "failure" | "stopped";
  exitKind?: string;
  reasons?: string[];
  failureClass?: FailureClass;
  message?: string;
  /** Set for `kind: "stopped"`. A budget stop is never a failure (record §3). */
  stopKind?: StopKind;
  /** The round whose tournament could not be completed, so it was neither fitted nor published. */
  truncatedRound?: number;
  /** True when the loop ended before any frontier was ever computed. */
  frontierEmpty?: boolean;
  /** Configured targets at a resumable stop; later resume is gated on an actual increase. */
  budgetTargetUsd?: number;
  wallTargetSeconds?: number;
}

export interface RunStatus {
  id: string;
  phase: Phase;
  state: "running" | "paused" | "stopped" | "done" | "failed";
  outcome?: RunOutcome;
  usdSpent: number;
  turns: Partial<Record<Phase, number>>;
  projectDir?: string;
  /** Frozen at frame exit; ideate, form and build refuse to start on a mismatch (record §1). */
  shape?: IdeaShape;
  shapeHash?: string;
  /** When a usage-window pause expects to be resumable, from `fetchUsage` at pause time. */
  wakeAt?: string;
  pausedReason?: string;
  /** Resume hint; `tournament.jsonl` and the raw island files stay the truth. */
  cursor?: { round?: number; featureId?: string; attempt?: number; step: string };
  /** Final checkpoint choice; later phases consume this rather than scanning an ambiguous reject. */
  chosenIdeaId?: string;
  /** Hash of the formed specification observed at freeze. */
  specHash?: string;
  /** True after an operator explicitly accepted a replacement acceptance lock. */
  relocked?: boolean;
  /** Human-requested rounds beyond the configured default; durable across `run resume`. */
  ideationRounds?: number;
  /** A round ended early on its sub-budget, so its tournament was not published. */
  truncated?: boolean;
  /** Run-level prior-art health, so checkpoint consumers never infer it from concurrent events. */
  searchHealth?: number;
  searchHealthFloor?: number;
  noveltyEnforced?: boolean;
  /** Immutable evaluator seed identity when this HarnessRun came from the eval corpus. */
  seed?: { id: string; split: "dev" | "heldout"; sha256: string };
  createdAt: string;
  updatedAt: string;
}

export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${d}-${randomBytes(2).toString("hex")}`;
}

export function runPaths(home: string, id: string): RunPaths {
  const dir = join(runsDir(home), id);
  return {
    id,
    dir,
    seed: join(dir, "seed.md"),
    brief: join(dir, "brief.md"),
    landscape: join(dir, "landscape.md"),
    discoveryDir: join(dir, "discovery"),
    ideasDir: join(dir, "ideas"),
    rawIdeasDir: join(dir, "ideas", "raw"),
    renderedDir: join(dir, "ideas", "rendered"),
    toolOutputDir: join(dir, "tool-output"),
    criteriaDir: join(dir, "criteria"),
    probesDir: join(dir, "probes"),
    notes: join(dir, "notes.md"),
    record: join(dir, "record.jsonl"),
    status: join(dir, "status.json"),
    tournament: join(dir, "tournament.jsonl"),
    frontier: join(dir, "frontier.json"),
    metrics: join(dir, "metrics.json"),
    lock: join(dir, "run.lock"),
    project: join(dir, "project"),
    features: join(dir, "features.json"),
    acceptanceLock: join(dir, "acceptance.lock"),
    featureState: join(dir, "state.jsonl"),
    audits: join(dir, "audits.jsonl"),
    reflectDir: join(dir, "reflect"),
    digest: join(dir, "reflect", "digest.md"),
  };
}

export function createRun(home: string, seedText: string, opts: { id?: string; projectDir?: string } = {}): RunPaths {
  const p = runPaths(home, opts.id ?? newRunId());
  for (const d of [p.dir, p.discoveryDir, p.ideasDir, p.rawIdeasDir, p.renderedDir, p.toolOutputDir, p.criteriaDir, p.probesDir, p.reflectDir]) ensureDir(d);
  writeAtomic(p.seed, seedText.endsWith("\n") ? seedText : `${seedText}\n`);
  const now = new Date().toISOString();
  const status: RunStatus = {
    id: p.id,
    phase: "frame",
    state: "running",
    usdSpent: 0,
    turns: {},
    projectDir: opts.projectDir,
    createdAt: now,
    updatedAt: now,
  };
  writeAtomic(p.status, `${JSON.stringify(status, null, 2)}\n`);
  return p;
}

export function readStatus(p: RunPaths): RunStatus {
  return JSON.parse(readFileSync(p.status, "utf8")) as RunStatus;
}

export function writeStatus(p: RunPaths, patch: Partial<RunStatus>): RunStatus {
  const cur = existsSync(p.status) ? readStatus(p) : ({} as RunStatus);
  const next: RunStatus = {
    ...cur,
    ...patch,
    turns: { ...(cur.turns ?? {}), ...(patch.turns ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(p.status, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function runExists(home: string, id: string): boolean {
  return existsSync(runPaths(home, id).status);
}
