import type { JudgeCalibrationStatus } from "../evals/report";
import type { ArchiveReason } from "./archive";
import type { Candidate, EvaluatedVerdict } from "./candidate";
import { applyDelta, parsePlaybook, serializePlaybook } from "./playbook";

export type PromoteReason = "integrity" | "dirty_tree" | "locked" | "incomplete_eval" | "invalid" |
  "stale_champion" | "missing_report" | "leak" | "playbook_overflow" | "unswept_effort" |
  "uncalibrated_judge" | "lost_heldout" | "not_evidence" | "censored" | "git_contract" | "transaction_conflict";

export interface PromoteRefusal { rung: number; reason: PromoteReason; detail: string; archiveReason?: ArchiveReason }
export interface PromotionGateInput {
  manifestOk: boolean; dirty: boolean; locked: boolean; incompleteEval: boolean;
  candidateError?: string; reportExists: boolean; leak: boolean; activeBullets: number;
  effortSwept: boolean; judgeBased: boolean; judgeCalibrationStatus?: JudgeCalibrationStatus;
  verdict?: EvaluatedVerdict; heldoutRate?: number; confirm?: boolean; confirmEligible?: boolean;
}
export type PromotionGate = { ok: true; confirmed: boolean } | { ok: false; refusal: PromoteRefusal };

/** The binding ten-rung ladder. Cost is deliberately absent: it is a warning, never a refusal. */
export function promotionGate(input: PromotionGateInput): PromotionGate {
  const no = (rung: number, reason: PromoteReason, detail: string, archiveReason?: ArchiveReason): PromotionGate =>
    ({ ok: false, refusal: { rung, reason, detail, ...(archiveReason ? { archiveReason } : {}) } });
  if (!input.manifestOk) return no(1, "integrity", "eval manifest verification failed");
  if (input.dirty) return no(2, "dirty_tree", "protected champion inputs are dirty");
  if (input.locked) return no(3, "locked", "another evolution mutation holds evolve.lock");
  if (input.incompleteEval) return no(3, "incomplete_eval", "an evaluation is incomplete");
  if (input.candidateError) {
    const stale = input.candidateError === "stale_champion";
    return no(4, stale ? "stale_champion" : "invalid", input.candidateError, stale ? "stale_champion" : "invalid");
  }
  if (!input.reportExists || input.verdict === undefined) return no(5, "missing_report", "candidate has no finished eval report", "invalid");
  if (input.leak) return no(6, "leak", "held-out leak check failed", "leak");
  if (input.activeBullets > 120) return no(7, "playbook_overflow", `${input.activeBullets} active bullets`, "playbook_overflow");
  if (!input.effortSwept) return no(8, "unswept_effort", "required effort seats were not swept", "unswept_effort");
  if (input.judgeBased && input.judgeCalibrationStatus !== "calibrated") {
    return no(9, "uncalibrated_judge", `judge calibration is ${input.judgeCalibrationStatus ?? "absent"}`, "not_evidence");
  }
  if (input.verdict === "win") return { ok: true, confirmed: false };
  if (input.verdict === "not_evidence" && input.confirm && input.confirmEligible !== false && (input.heldoutRate ?? 0) > 0.5) {
    return { ok: true, confirmed: true };
  }
  if (input.verdict === "lose") return no(10, "lost_heldout", "held-out verdict is lose", "lost_heldout");
  if (input.verdict === "not_evidence") return no(10, "not_evidence", "held-out result is not evidence", "not_evidence");
  return no(10, "censored", `held-out verdict is ${input.verdict}`, "censored");
}

function bump(md: string, id: string, counter: "helpful" | "harmful"): string {
  const parsed = parsePlaybook(md); const matches = parsed.sections.flatMap((section) => section.bullets.filter((bullet) => bullet.id === id));
  if (matches.length !== 1) throw new Error(`expected one playbook bullet ${id}, found ${matches.length}`);
  const bullet = matches[0]!; const lines = [...parsed.lines]; const line = lines[bullet.line]!; const value = bullet[counter];
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error(`${counter} counter cannot be incremented`);
  const content = line.content.replace(`${counter}:${value}`, `${counter}:${value + 1}`);
  lines[bullet.line] = { content, eol: line.eol, raw: `${content}${line.eol}` };
  return serializePlaybook({ lines, sections: [] });
}

export function promotedPlaybook(md: string, candidate: Candidate, by: string, at: string | Date): { text: string; id: string } {
  if (candidate.kind !== "playbook" || !candidate.delta) throw new Error("playbook candidate required");
  const beforeIds = new Set(parsePlaybook(md).sections.flatMap((section) => section.bullets.map((bullet) => bullet.id)));
  let text = applyDelta(md, candidate.delta, { by, at });
  if (candidate.delta.op === "add") {
    const added = parsePlaybook(text).sections.flatMap((section) => section.bullets).find((bullet) => !beforeIds.has(bullet.id));
    if (!added) throw new Error("add delta created no bullet");
    text = bump(text, added.id, "helpful"); return { text, id: added.id };
  }
  text = bump(text, candidate.delta.id!, candidate.delta.op === "retire" ? "harmful" : "helpful");
  return { text, id: candidate.delta.id! };
}

export function archivedPlaybook(md: string, candidate: Candidate, reason: ArchiveReason): string {
  if ((reason !== "lost_dev" && reason !== "lost_heldout") || candidate.kind !== "playbook"
    || !candidate.delta?.id || candidate.delta.op === "add") return md;
  return bump(md, candidate.delta.id, "helpful");
}
