import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROMPT_FILES, type PromptName } from "../brain/prompts";
import {
  parseDelta,
  validateDelta,
  type DeltaContext,
  type PlaybookDelta,
} from "../build/delta";
import { candidatePath, writeAtomic } from "../core/paths";
import { hashInput } from "../core/record";
import { playbookHash } from "./playbook";

export const CANDIDATE_KINDS = ["playbook", "prompt"] as const;
export const CANDIDATE_AUTHORS = ["reflector", "operator"] as const;
export const REFUSED_PROMPT_CANDIDATES = ["judge", "kernel", "reflector"] as const;

export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
export type CandidateAuthor = (typeof CANDIDATE_AUTHORS)[number];

export interface CandidateSeed {
  id: string;
  split: "dev" | "heldout";
  sha256: string;
}

export interface PromptCandidate {
  name: PromptName;
  text: string;
}

/** The normalized version-1 envelope. Added fields are defaulted for Task 10 reflector files. */
export interface Candidate {
  version: 1;
  kind: CandidateKind;
  playbookHash: string;
  author: CandidateAuthor;
  createdAt: string;
  runId?: string;
  digestHash?: string;
  reflectorModelRef?: string;
  seed?: CandidateSeed;
  delta?: PlaybookDelta;
  prompt?: PromptCandidate;
}

export interface CandidateValidationOptions {
  /** The counter-insensitive hash of the live champion. A mismatch is stale, not invalid. */
  currentPlaybookHash?: string;
}

export type CandidateValidation = Candidate | { reason: string };
export type EvaluatedVerdict = "win" | "lose" | "not_evidence" | "censored" | "incomplete";
export type CandidateStatus =
  | "pending"
  | `evaluated: ${EvaluatedVerdict}`
  | "promoted"
  | `archived: ${string}`
  | "stale";

export interface CandidateStatusContext {
  currentPlaybookHash?: string;
  reportVerdict?: EvaluatedVerdict;
  archivedReason?: string;
  promoted?: boolean;
}

export class CandidateError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "CandidateError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown, field: string): string | { reason: string } | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value) ? value : { reason: `${field} must be a non-empty string when present` };
}

function validCreatedAt(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validateSeed(value: unknown): CandidateSeed | { reason: string } | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  if (!raw) return { reason: "seed must be an object when present" };
  if (!nonEmpty(raw.id)) return { reason: "seed.id must be a non-empty string" };
  if (raw.split !== "dev" && raw.split !== "heldout") return { reason: "seed.split must be dev or heldout" };
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    return { reason: "seed.sha256 must be a lowercase 64-character SHA-256" };
  }
  return { id: raw.id, split: raw.split, sha256: raw.sha256 };
}

function validatePrompt(raw: Record<string, unknown>): PromptCandidate | { reason: string } {
  // The nested form is canonical. Accept the record's early top-level spelling while normalizing it.
  const nested = object(raw.prompt);
  const name = nested?.name ?? (typeof raw.prompt === "string" ? raw.prompt : undefined);
  const text = nested?.text ?? raw.text;
  if (!nonEmpty(name) || !(PROMPT_FILES as readonly string[]).includes(name)) {
    return { reason: `prompt.name must be one of ${PROMPT_FILES.join(", ")}` };
  }
  if ((REFUSED_PROMPT_CANDIDATES as readonly string[]).includes(name)) {
    return { reason: `prompt_refused: ${name} cannot be an evolution candidate` };
  }
  if (!nonEmpty(text)) return { reason: "prompt.text must be a non-empty string" };
  return { name: name as PromptName, text };
}

/** Validate and normalize either parsed JSON or a legacy Task 10 candidate object. */
export function validateCandidate(file: unknown, options: CandidateValidationOptions = {}): CandidateValidation {
  const raw = object(file);
  if (!raw) return { reason: "candidate must be an object" };
  if (raw.version !== undefined && raw.version !== 1) return { reason: "version must be 1 when present" };
  const kind = raw.kind ?? "playbook";
  if (!(CANDIDATE_KINDS as readonly unknown[]).includes(kind)) return { reason: "kind must be playbook or prompt" };
  const author = raw.author ?? "reflector";
  if (!(CANDIDATE_AUTHORS as readonly unknown[]).includes(author)) return { reason: "author must be reflector or operator" };
  if (!nonEmpty(raw.playbookHash)) return { reason: "playbookHash must be a non-empty string" };
  if (!validCreatedAt(raw.createdAt)) return { reason: "createdAt must be an ISO timestamp" };

  const runId = optionalString(raw.runId, "runId");
  if (runId !== undefined && typeof runId !== "string") return runId;
  const digestHash = optionalString(raw.digestHash, "digestHash");
  if (digestHash !== undefined && typeof digestHash !== "string") return digestHash;
  const reflectorModelRef = optionalString(raw.reflectorModelRef, "reflectorModelRef");
  if (reflectorModelRef !== undefined && typeof reflectorModelRef !== "string") return reflectorModelRef;
  const seed = validateSeed(raw.seed);
  if (seed && "reason" in seed) return seed;

  let delta: PlaybookDelta | undefined;
  let prompt: PromptCandidate | undefined;
  if (kind === "playbook") {
    const parsed = parseDelta(raw.delta);
    if ("reason" in parsed) return { reason: `delta: ${parsed.reason}` };
    delta = parsed.delta;
  } else {
    if (author !== "operator") return { reason: "prompt candidates must be operator-authored" };
    const parsed = validatePrompt(raw);
    if ("reason" in parsed) return parsed;
    prompt = parsed;
  }

  if (author === "reflector") {
    if (!runId || typeof runId !== "string") return { reason: "reflector candidate requires runId" };
    if (!digestHash || typeof digestHash !== "string") return { reason: "reflector candidate requires digestHash" };
    if (!reflectorModelRef || typeof reflectorModelRef !== "string") return { reason: "reflector candidate requires reflectorModelRef" };
    if (!delta) return { reason: "reflector candidate requires delta" };
  }
  if (options.currentPlaybookHash !== undefined && raw.playbookHash !== options.currentPlaybookHash) {
    return { reason: "stale_champion" };
  }

  return {
    version: 1,
    kind: kind as CandidateKind,
    playbookHash: raw.playbookHash,
    author: author as CandidateAuthor,
    createdAt: raw.createdAt,
    ...(typeof runId === "string" ? { runId } : {}),
    ...(typeof digestHash === "string" ? { digestHash } : {}),
    ...(typeof reflectorModelRef === "string" ? { reflectorModelRef } : {}),
    ...(seed ? { seed } : {}),
    ...(delta ? { delta } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/** Derive state from durable facts. Terminal destinations take precedence over live-tree staleness. */
export function status(candidate: Pick<Candidate, "playbookHash">, context: CandidateStatusContext = {}): CandidateStatus {
  if (context.archivedReason) return `archived: ${context.archivedReason}`;
  if (context.promoted) return "promoted";
  if (context.currentPlaybookHash !== undefined && candidate.playbookHash !== context.currentPlaybookHash) return "stale";
  return context.reportVerdict ? `evaluated: ${context.reportVerdict}` : "pending";
}

export const candidateStatus = status;

export function candidateId(candidate: Candidate): string {
  if (candidate.author === "reflector" && candidate.runId) return candidate.runId;
  if (candidate.kind === "prompt" && candidate.prompt) {
    return `prompt-${candidate.prompt.name}-${hashInput(candidate.prompt.text).slice(0, 8)}`;
  }
  return `playbook-${hashInput({ playbookHash: candidate.playbookHash, delta: candidate.delta }).slice(0, 8)}`;
}

export interface PlaybookProposalInput {
  playbook: string;
  delta: unknown;
  context: Omit<DeltaContext, "playbook">;
  createdAt?: string;
}

export interface PromptProposalInput {
  playbook: string;
  name: string;
  text: string;
  createdAt?: string;
}

export interface CandidateProposal { id: string; candidate: Candidate }

function proposalTime(createdAt: string | undefined): string {
  const value = createdAt ?? new Date().toISOString();
  if (!validCreatedAt(value)) throw new CandidateError("invalid", "createdAt must be an ISO timestamp");
  return value;
}

/** Construct an operator-authored, structurally validated playbook candidate. */
export function proposePlaybook(input: PlaybookProposalInput): CandidateProposal {
  const parsed = parseDelta(input.delta);
  if ("reason" in parsed) throw new CandidateError("invalid", parsed.reason);
  const validation = validateDelta(parsed.delta, { ...input.context, playbook: input.playbook });
  if (!validation.ok) throw new CandidateError(validation.reason);
  const candidate: Candidate = {
    version: 1,
    kind: "playbook",
    playbookHash: playbookHash(input.playbook),
    author: "operator",
    createdAt: proposalTime(input.createdAt),
    delta: parsed.delta,
  };
  return { id: candidateId(candidate), candidate };
}

/** Construct an operator-authored whole-file prompt replacement. */
export function proposePrompt(input: PromptProposalInput): CandidateProposal {
  const candidate: Candidate = {
    version: 1,
    kind: "prompt",
    playbookHash: playbookHash(input.playbook),
    author: "operator",
    createdAt: proposalTime(input.createdAt),
    prompt: { name: input.name as PromptName, text: input.text },
  };
  const validated = validateCandidate(candidate);
  if ("reason" in validated) throw new CandidateError(validated.reason);
  return { id: candidateId(validated), candidate: validated };
}

/** Publish a constructed proposal without overwriting an existing candidate. Lock ownership is the caller's. */
export function writeProposal(home: string, proposal: CandidateProposal): string {
  assertCandidateId(proposal.id);
  const path = candidatePath(home, proposal.id);
  if (existsSync(path)) throw new CandidateError("candidate_exists", proposal.id);
  writeAtomic(path, `${JSON.stringify(proposal.candidate, null, 2)}\n`);
  return path;
}

export function readCandidate(path: string, options: CandidateValidationOptions = {}): CandidateValidation {
  try {
    return validateCandidate(JSON.parse(readFileSync(path, "utf8")), options);
  } catch (error) {
    return { reason: `candidate_json: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function candidateFileId(path: string): string {
  const name = basename(path);
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}

export function assertCandidateId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "." || id === "..") {
    throw new CandidateError("invalid_candidate_id", id);
  }
}

/** Convenience for command adapters that already hold the evolution lock. */
export function proposeCandidate(home: string, input: PlaybookProposalInput | PromptProposalInput): CandidateProposal & { path: string } {
  const proposal = "delta" in input ? proposePlaybook(input) : proposePrompt(input);
  return { ...proposal, path: writeProposal(home, proposal) };
}

export function currentCandidatePath(home: string, id: string): string {
  assertCandidateId(id);
  return join(home, "evolution", "candidates", `${id}.json`);
}
