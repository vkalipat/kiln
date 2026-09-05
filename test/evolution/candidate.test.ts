import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybookDelta } from "../../src/build/delta";
import { hashInput } from "../../src/core/record";
import {
  CandidateError,
  candidateId,
  proposeCandidate,
  proposePlaybook,
  proposePrompt,
  status,
  validateCandidate,
} from "../../src/evolution/candidate";
import { playbookHash } from "../../src/evolution/playbook";

const createdAt = "2026-09-05T12:00:00.000Z";
const playbook = "## build\n- B1 [helpful:0 harmful:0] Keep the build small.\n";
const delta: PlaybookDelta = {
  op: "edit",
  section: "build",
  id: "B1",
  text: "Keep each build session scoped to one testable behavior.",
  why: "A narrow session makes failed work replaceable.",
  evidence: [{ kind: "metric", ref: "features.passed" }],
};

function legacy(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "20260905-120000-abcd",
    digestHash: "digest-hash",
    playbookHash: playbookHash(playbook),
    reflectorModelRef: "provider/reflector",
    delta,
    createdAt,
    ...patch,
  };
}

describe("candidate validation", () => {
  test("normalizes the Task 10 reflector shape without rewriting required fields", () => {
    expect(validateCandidate(legacy())).toEqual({
      version: 1,
      kind: "playbook",
      author: "reflector",
      runId: "20260905-120000-abcd",
      digestHash: "digest-hash",
      playbookHash: playbookHash(playbook),
      reflectorModelRef: "provider/reflector",
      delta,
      createdAt,
    });
  });

  test("validates every envelope field and all reflector-required fields", () => {
    const cases: Array<[Record<string, unknown> | null, string]> = [
      [null, "candidate must be an object"],
      [legacy({ version: 2 }), "version must be 1"],
      [legacy({ kind: "operator" }), "kind must be"],
      [legacy({ author: "human" }), "author must be"],
      [legacy({ playbookHash: "" }), "playbookHash"],
      [legacy({ createdAt: "yesterday" }), "createdAt"],
      [legacy({ runId: undefined }), "requires runId"],
      [legacy({ digestHash: undefined }), "requires digestHash"],
      [legacy({ reflectorModelRef: undefined }), "requires reflectorModelRef"],
      [legacy({ delta: undefined }), "delta:"],
      [legacy({ seed: { id: "s", split: "private", sha256: "h" } }), "seed.split"],
    ];
    for (const [value, message] of cases) {
      const result = validateCandidate(value);
      expect("reason" in result && result.reason).toContain(message);
    }
  });

  test("recognizes legacy byte hashes as stale against the counter-insensitive champion", () => {
    const current = playbookHash(playbook);
    const byteHash = hashInput(playbook);
    expect(byteHash).not.toBe(current);
    expect(validateCandidate(legacy({ playbookHash: byteHash }), { currentPlaybookHash: current })).toEqual({ reason: "stale_champion" });
    const counterOnly = playbook.replace("helpful:0 harmful:0", "helpful:8 harmful:3");
    expect(validateCandidate(legacy(), { currentPlaybookHash: playbookHash(counterOnly) })).not.toHaveProperty("reason");
  });

  test("accepts nested and early flat prompt shapes but refuses evaluator and reflector prompts", () => {
    const base = { version: 1, kind: "prompt", author: "operator", playbookHash: playbookHash(playbook), createdAt };
    expect(validateCandidate({ ...base, prompt: { name: "builder", text: "Build narrowly.\n" } })).toMatchObject({ prompt: { name: "builder" } });
    expect(validateCandidate({ ...base, prompt: "brain", text: "Reason carefully.\n" })).toMatchObject({ prompt: { name: "brain", text: "Reason carefully.\n" } });
    for (const name of ["judge", "kernel", "reflector"]) {
      expect(validateCandidate({ ...base, prompt: { name, text: "Replacement.\n" } })).toEqual({ reason: `prompt_refused: ${name} cannot be an evolution candidate` });
    }
    expect(validateCandidate({ ...base, author: "reflector", prompt: { name: "brain", text: "Replacement.\n" } })).toEqual({ reason: "prompt candidates must be operator-authored" });
  });

  test("derives terminal, stale, evaluated, and pending statuses without storing one", () => {
    const candidate = validateCandidate(legacy());
    if ("reason" in candidate) throw new Error(candidate.reason);
    expect(status(candidate)).toBe("pending");
    expect(status(candidate, { reportVerdict: "win" })).toBe("evaluated: win");
    expect(status(candidate, { currentPlaybookHash: "new" })).toBe("stale");
    expect(status(candidate, { promoted: true, currentPlaybookHash: "new" })).toBe("promoted");
    expect(status(candidate, { archivedReason: "rolled_back", promoted: true })).toBe("archived: rolled_back");
  });
});

describe("operator proposals", () => {
  test("constructs a validated playbook proposal against the canonical champion hash", () => {
    const proposal = proposePlaybook({
      playbook,
      delta,
      context: { digestHeadings: [], runDir: "/tmp", metrics: { features: { passed: 1 } }, kernel: "", rolePrompt: "" },
      createdAt,
    });
    expect(proposal.candidate).toMatchObject({ version: 1, kind: "playbook", author: "operator", playbookHash: playbookHash(playbook), delta });
    expect(proposal.id).toMatch(/^playbook-[a-f0-9]{8}$/);
    expect(proposal.id).toBe(candidateId(proposal.candidate));
  });

  test("rejects an invalid playbook delta before constructing a candidate", () => {
    expect(() => proposePlaybook({
      playbook,
      delta: { ...delta, why: undefined },
      context: { digestHeadings: [], runDir: "/tmp", metrics: { features: { passed: 1 } } },
      createdAt,
    })).toThrow(CandidateError);
  });

  test("uses the required prompt id and writes once without overwriting", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-candidate-"));
    const input = { playbook, name: "builder", text: "Build only observable behavior.\n", createdAt };
    const proposal = proposePrompt(input);
    expect(proposal.id).toMatch(/^prompt-builder-[a-f0-9]{8}$/);
    const written = proposeCandidate(home, input);
    expect(written.id).toBe(proposal.id);
    expect(existsSync(written.path)).toBe(true);
    expect(JSON.parse(readFileSync(written.path, "utf8"))).toEqual(proposal.candidate);
    expect(() => proposeCandidate(home, input)).toThrow(/candidate_exists/);
  });

  test("refuses judge, kernel, and reflector proposal construction", () => {
    for (const name of ["judge", "kernel", "reflector"]) {
      expect(() => proposePrompt({ playbook, name, text: "Replacement.\n", createdAt })).toThrow(/prompt_refused/);
    }
  });
});
