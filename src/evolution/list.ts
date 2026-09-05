import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { costWarning, type JudgeCalibrationStatus } from "../evals/report";
import {
  candidateFileId,
  candidateStatus,
  readCandidate,
  type Candidate,
  type CandidateStatus,
  type EvaluatedVerdict,
} from "./candidate";
import { archiveDir, readArchiveReason, type ArchiveReason } from "./archive";

const VERDICTS = ["win", "lose", "not_evidence", "censored", "incomplete"] as const;
const JUDGE_STATUSES = ["absent", "stale", "provisional", "agent", "calibrated", "removed"] as const;

export interface CandidateListRow {
  id: string;
  run: string | null;
  seed: string | null;
  split: "dev" | "heldout" | null;
  kind: "playbook" | "prompt" | null;
  section: string | null;
  op: string | null;
  targetId: string | null;
  prompt: string | null;
  status: CandidateStatus;
  verdict: EvaluatedVerdict | null;
  heldoutRate: number | null;
  heldoutLower: number | null;
  heldoutUpper: number | null;
  n: number | null;
  required: number | null;
  seedWins: number | null;
  candidateUsdPerSuccess: number | null;
  championUsdPerSuccess: number | null;
  costFlag: boolean;
  costUsd: number | null;
  effortSwept: boolean | null;
  at: string | null;
  judgeCalibrationStatus: JudgeCalibrationStatus | null;
  validationError?: string;
}

export interface CandidateList {
  rows: CandidateListRow[];
  judgeCalibrationStatus: JudgeCalibrationStatus | null;
}

export interface CandidateListOptions {
  currentPlaybookHash?: string;
  costRatioCap?: number;
  /** Extra durable trailer discoveries supplied by an async command adapter. */
  promotedIds?: Iterable<string>;
  judgeCalibrationStatus?: JudgeCalibrationStatus;
}

type Source = "pending" | "promoted" | "archived";
interface LocatedCandidate { id: string; source: Source; path: string; archivedReason?: ArchiveReason; archivedAt?: string }

function json(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name).sort();
}

function dirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function locate(home: string, options: CandidateListOptions): LocatedCandidate[] {
  const root = join(home, "evolution");
  const byId = new Map<string, LocatedCandidate>();
  for (const name of files(join(root, "candidates"))) {
    const id = candidateFileId(name);
    byId.set(id, { id, source: "pending", path: join(root, "candidates", name) });
  }
  for (const name of files(join(root, "promoted"))) {
    const id = candidateFileId(name);
    byId.set(id, { id, source: "promoted", path: join(root, "promoted", name) });
  }
  // Rollback archives a formerly promoted id, so archive is the strongest terminal fact.
  for (const id of dirs(join(root, "archive"))) {
    const reason = readArchiveReason(home, id);
    byId.set(id, {
      id, source: "archived", path: join(archiveDir(home, id), "candidate.json"),
      archivedReason: reason?.reason, archivedAt: reason?.at,
    });
  }
  for (const id of options.promotedIds ?? []) {
    const current = byId.get(id);
    if (current?.source === "pending") byId.set(id, { ...current, source: "promoted" });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function verdict(report: Record<string, unknown> | undefined): EvaluatedVerdict | undefined {
  const value = report?.verdict;
  return (VERDICTS as readonly unknown[]).includes(value) ? value as EvaluatedVerdict : undefined;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function usd(report: Record<string, unknown> | undefined, arm: "candidate" | "champion"): number | null {
  if (!report) return null;
  const direct = number(report[`${arm}UsdPerSuccess`]);
  if (direct !== null) return direct;
  const paired = number(record(report.usdPerSuccess)?.[arm]);
  if (paired !== null) return paired;
  const legacy = number(record(record(report.cost)?.[arm])?.usdPerSuccess);
  if (legacy !== null) return legacy;
  const phase = report.class === "build" ? "build" : report.class === "form" ? "form" : "ideate";
  const blocks = Array.isArray(report.runs) ? report.runs.flatMap((value) => {
    const run = record(value);
    if (run?.arm !== arm) return [];
    const block = record(record(run.cost)?.[phase]);
    const usd = number(block?.usd); const successes = number(block?.successes);
    return usd === null || successes === null ? [] : [{ usd, successes }];
  }) : [];
  const successes = blocks.reduce((sum, block) => sum + block.successes, 0);
  return successes > 0 ? blocks.reduce((sum, block) => sum + block.usd, 0) / successes : null;
}

function judgeStatus(report: Record<string, unknown> | undefined): JudgeCalibrationStatus | null {
  const value = record(report?.judgeCalibration)?.status;
  return (JUDGE_STATUSES as readonly unknown[]).includes(value) ? value as JudgeCalibrationStatus : null;
}

function reportFor(home: string, found: LocatedCandidate): Record<string, unknown> | undefined {
  if (found.source === "archived") {
    const held = json(join(archiveDir(home, found.id), "eval.json"));
    if (held) return held;
  }
  return json(join(home, "evolution", "reports", found.id, "eval.json"));
}

function fallbackCandidate(raw: Record<string, unknown> | undefined): Candidate | undefined {
  if (!raw || typeof raw.playbookHash !== "string") return undefined;
  return {
    version: 1,
    kind: raw.kind === "prompt" ? "prompt" : "playbook",
    playbookHash: raw.playbookHash,
    author: raw.author === "operator" ? "operator" : "reflector",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
}

function row(home: string, found: LocatedCandidate, options: CandidateListOptions): CandidateListRow {
  const raw = json(found.path);
  const checked = readCandidate(found.path);
  const validationError = "reason" in checked ? checked.reason : undefined;
  const candidate = "reason" in checked ? fallbackCandidate(raw) : checked;
  const report = reportFor(home, found);
  const heldout = record(record(report?.passes)?.heldout);
  const wilson = record(heldout?.wilson);
  const result = verdict(report);
  const archivedReason = found.source === "archived" ? found.archivedReason ?? "invalid" : undefined;
  const state = candidate
    ? candidateStatus(candidate, {
      currentPlaybookHash: options.currentPlaybookHash,
      reportVerdict: result,
      archivedReason,
      promoted: found.source === "promoted",
    })
    : found.source === "archived" ? `archived: ${archivedReason}` as const
      : found.source === "promoted" ? "promoted" : "pending";
  const delta = candidate?.delta;
  const calibration = judgeStatus(report);
  const candidateUsdPerSuccess = usd(report, "candidate");
  const championUsdPerSuccess = usd(report, "champion");
  const storedCostFlag = boolean(record(report?.costFlag)?.flagged);
  return {
    id: found.id,
    run: candidate?.runId ?? null,
    seed: candidate?.seed?.id ?? null,
    split: candidate?.seed?.split ?? null,
    kind: candidate?.kind ?? null,
    section: delta?.section ?? null,
    op: delta?.op ?? (candidate?.kind === "prompt" ? "replace" : null),
    targetId: delta?.id ?? null,
    prompt: candidate?.prompt?.name ?? null,
    status: state,
    verdict: result ?? null,
    heldoutRate: number(heldout?.rate),
    heldoutLower: number(wilson?.lower),
    heldoutUpper: number(wilson?.upper),
    n: number(heldout?.pairs),
    required: number(heldout?.requiredWins ?? heldout?.required),
    seedWins: number(heldout?.seedWins),
    candidateUsdPerSuccess,
    championUsdPerSuccess,
    costFlag: storedCostFlag ?? costWarning(candidateUsdPerSuccess, championUsdPerSuccess, options.costRatioCap ?? 1.5).flagged,
    costUsd: number(report?.costUsd),
    effortSwept: boolean(report?.effortSwept),
    at: found.archivedAt ?? (typeof report?.updatedAt === "string" ? report.updatedAt : candidate?.createdAt || null),
    judgeCalibrationStatus: calibration,
    ...(validationError ? { validationError } : {}),
  };
}

/** One derived row per durable candidate id across pending, promoted, and terminal archives. */
export function listCandidateRows(home: string, options: CandidateListOptions = {}): CandidateListRow[] {
  return locate(home, options).map((found) => row(home, found, options));
}

export const listCandidates = listCandidateRows;

/** Rows plus the single footer stamp used by the CLI renderer. */
export function candidateList(home: string, options: CandidateListOptions = {}): CandidateList {
  const rows = listCandidateRows(home, options);
  const latestStamped = [...rows].filter((item) => item.judgeCalibrationStatus && item.at)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0]?.judgeCalibrationStatus;
  return { rows, judgeCalibrationStatus: options.judgeCalibrationStatus ?? latestStamped ?? null };
}
