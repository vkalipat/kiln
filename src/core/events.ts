import type { Effort, Phase, Role } from "./config";
import type { FailureClass, FailureStopDetails } from "./failure";

/** Why the ideate loop ended. `paused` is a state, not a stop (record §8). */
export type StopKind = "rounds" | "stagnant" | "stalled" | "budget" | "no_idea_clears_bar" | "blocked" | "deadline" | "transient";
/** One enum per idea (record §6); `not_run` always carries a `reason`. */
export type ProbeStatus = "pass" | "fail" | "timeout" | "error" | "not_run";
/** Why an idea never entered (or left) the ranked archive (record §4, §5). */
export type IdeaRejectReason = "restatement" | "lost_cell" | "collided";
/** The two things the arbiter decides, each with its own per-round cap (record §2). */
export type ArbiterKind = "novelty" | "collision";
/** Which of the two orderings of a judged pair a line records (record §7). */
export type PairOrder = "ab" | "ba";
/** A search tool's structured outcome, distinguishing zero results from a blocked or failed search (record §5). */
export type SearchStatus = "ok" | "blocked" | "failed";
/** What the human (or autonomous mode) did at the checkpoint (record §9). */
export type CheckpointDecisionKind = "pick" | "reject" | "another_round" | "autonomous_pick";

/** The two Bradley-Terry ladders, each an ordered list of idea ids, strongest first. */
export interface Ladders {
  value: string[];
  feasibility: string[];
}

export interface CritiqueItem {
  featureId?: string;
  text: string;
}

export type BuildArm = "fresh" | "single_session";
export type BuildStop = "done" | "turn_cap" | "usd_cap" | "exit" | "error" | "refused";
export type AttemptDisposition =
  | "passed"
  | "verify_failed"
  | "audit_disagreed"
  | "stalled"
  | "transient"
  | "budget"
  | "declared_failed"
  | "commit_failed"
  | "refused"
  | "paused";
export type CheckPhase = "acceptance" | "regression" | "init";
export type FeatureStateName = "pending" | "passed" | "failed" | "blocked" | "regressed";
export type AuditVerdict = "agree" | "disagree";

export type RecordEvent =
  | { t: "run.created"; seed: string }
  | { t: "phase.start"; phase: Phase }
  | { t: "phase.end"; phase: Phase; outcome: string }
  | {
      t: "model.call";
      role: Role;
      provider: string;
      model: string;
      effort?: string;
      /** Clamped effort actually sent to the provider. */
      effortSent?: Effort;
      /** Hash of the model-family prompt addenda composed for this call. */
      addendaHash?: string;
      inputHash: string;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
      costUsd: number;
      durationMs?: number;
      stopReason: string;
      excerpt: string;
      error?: string;
      /** HTTP-ish status from the provider error, so failure classification never reads message wording. */
      errorStatus?: number;
      /** Provider request id for the failed call. */
      errorId?: string;
      /** Provider attempts behind this one assistant message (retries included). */
      requests?: number;
      stopDetails?: FailureStopDetails;
      fallbackServed?: boolean;
      reasoningTokens?: number;
      ttftMs?: number;
    }
  | { t: "tool.call"; name: string; args: unknown; ok: boolean; durationMs: number; excerpt: string }
  | { t: "honest_exit"; kind: string; reasons: string[]; source?: "declared" | "mechanical" }
  | { t: "failure"; class: FailureClass; message: string; category?: string }
  | { t: "note"; text: string }
  | { t: "turn"; role: Role; phase: Phase; n: number }
  | { t: "island.assign"; round: number; island: number; model: string; lens?: string; operator?: string }
  | { t: "idea.insert"; id: string; cell: string; similarity: number; parents: string[] }
  | { t: "idea.reject"; id: string; reason: IdeaRejectReason; against?: string }
  | { t: "arbiter.verdict"; kind: ArbiterKind; id: string; against?: string; verdict: string; costUsd: number }
  | { t: "probe"; id: string; status: ProbeStatus; reason?: string; exitCode?: number; durationMs: number }
  | { t: "probe.request"; round: number; ideas: { ideaId: string; rationale: string }[] }
  | { t: "search.health"; tool: string; status: SearchStatus }
  | {
      t: "verdict";
      round: number;
      a: string;
      b: string;
      order: PairOrder;
      valueWinner: string;
      feasibilityWinner: string;
      judgeModel: string;
      costUsd: number;
    }
  | { t: "checkpoint.shown"; round: number; ideas: string[]; hashes: string[]; ladders: Ladders }
  | { t: "checkpoint.bws"; group: string[]; best: string; worst: string }
  | { t: "checkpoint.decision"; kind: CheckpointDecisionKind; id?: string; reason?: string; steering?: string }
  | { t: "pause"; reason: string; wakeAt: string }
  | { t: "critique"; verdict: "ok" | "revise"; scopeCreep: CritiqueItem[]; unverifiable: CritiqueItem[]; missing: CritiqueItem[]; crossProvider: boolean; provider: string; model: string; stopped: BuildStop; costUsd: number; usdCapHit: boolean }
  | { t: "formation.attempt"; ideaId: string; attempt: number }
  | { t: "formation.revision"; ideaId: string; attempt: number }
  | { t: "freeze"; featureCount: number; lockIdsHash: string; lockHash: string; manualCount: number; executableCount: number; needsUnion: string[]; specHash?: string }
  | { t: "relock"; before: string; after: string; confirmed: boolean }
  | { t: "spec.drift"; expected: string; actual: string }
  | { t: "feature.pick"; featureId: string; attempt: number; phaseBudgetUsd: number; featureBudgetUsd?: number }
  | {
      t: "builder.session";
      featureId: string;
      attempt: number;
      arm: BuildArm;
      builderModelRef: string;
      beforeHead: string;
      afterHead: string;
      stopped: BuildStop;
      turns: number;
      costUsd: number;
      selfVerified: boolean;
      headMoved: boolean;
      contextPressure: boolean;
      pinnedTruncated: boolean;
      exitReasons: string[];
      stallTool?: string;
      stallFingerprint?: string;
      error?: string;
      errorStatus?: number;
      errorId?: string;
    }
  | { t: "feature.state"; featureId: string; from: FeatureStateName; to: FeatureStateName; attempt?: number; reason?: string; source?: "executed" | "human"; attempts?: number; repairs?: number; regressedBy?: string; commitSha?: string; observedCommitShas?: string[]; legacyCommitShas?: string[] }
  | {
      t: "attempt";
      featureId: string;
      attempt: number;
      arm: BuildArm;
      builderStopped: BuildStop;
      builderSelfVerified: boolean;
      builderCommitted: boolean;
      contextPressure: boolean;
      declaredUnsatisfiable: boolean;
      declarationReasons: string[];
      declarationOverruled: boolean;
      builderCostUsd: number;
      auditorCostUsd: number;
      costUsd: number;
      counted: boolean;
      disposition: AttemptDisposition;
    }
  | {
      t: "check";
      checkId: string;
      featureId?: string;
      attempt?: number;
      kind: "shell" | "file" | "manual";
      phase: CheckPhase;
      ok: boolean;
      exitCode?: number;
      durationMs: number;
      overrunMs: number;
      timedOut: boolean;
      predicateMatched?: boolean;
      outputPath: string;
      outputTruncated: boolean;
      notRunReason?: string;
    }
  | {
      t: "audit";
      featureId: string;
      attempt: number;
      checkId: string;
      shape: "full" | "short";
      verdict?: AuditVerdict;
      verifiedCount: number;
      claimedUnverifiedCount: number;
      regressions: string[];
      checkQualityAdequate?: boolean;
      truncated: boolean;
      usdCapHit: boolean;
      crossProvider: boolean;
      costUsd: number;
    }
  | {
      t: "audit.disposition";
      featureId: string;
      attempt: number;
      checkId: string;
      rawVerdict: AuditVerdict;
      effectiveVerdict: AuditVerdict;
      emptyDisagree: boolean;
      malformed: boolean;
      truncated: boolean;
      retried: boolean;
      evidenceUsable: boolean;
      checkVoided: boolean;
    }
  | { t: "commit"; featureId: string; attempt?: number; sha: string; empty: boolean }
  | { t: "stall"; featureId: string; attempt: number; tool: string; fingerprint: string }
  | { t: "sweep"; featureId: string; planned: number; run: number; skipped: string[]; durationMs: number; complete: boolean; scope: "full" | "partial" }
  | { t: "digest"; hash: string; bytes: number; truncated: boolean }
  | { t: "delta"; op: "add" | "edit" | "retire"; section: string; id?: string; accepted: boolean; reason?: string; source?: "reflector" }
  | {
      t: "stop";
      stopKind: StopKind;
      round?: number;
      truncatedRound?: number;
      frontierEmpty?: boolean;
      /** Present for a stalled stop so the repeated result can be diagnosed without replay. */
      stallTool?: string;
      stallFingerprint?: string;
      /** Configured targets at the stop, so resume can prove that an operator increased one. */
      budgetTargetUsd?: number;
      wallTargetSeconds?: number;
    };

export type StoredEvent = RecordEvent & { seq: number; ts: string };
