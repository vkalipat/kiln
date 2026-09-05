import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_REASONS,
  ArchiveError,
  archiveCandidate,
  isArchiveReason,
  readArchiveReason,
} from "../../src/evolution/archive";

function fixture(id = "candidate-1", withReport = true): string {
  const home = mkdtempSync(join(tmpdir(), "kiln-archive-"));
  mkdirSync(join(home, "evolution", "candidates"), { recursive: true });
  writeFileSync(join(home, "evolution", "candidates", `${id}.json`), `${JSON.stringify({ id, value: "candidate" })}\n`);
  if (withReport) {
    mkdirSync(join(home, "evolution", "reports", id), { recursive: true });
    writeFileSync(join(home, "evolution", "reports", id, "eval.json"), `${JSON.stringify({ evalId: id, verdict: "lose" })}\n`);
  }
  return home;
}

describe("candidate archive", () => {
  test("round-trips the complete closed reason set", () => {
    expect(ARCHIVE_REASONS).toHaveLength(16);
    for (const reason of ARCHIVE_REASONS) {
      const id = `candidate-${reason}`;
      const home = fixture(id, false);
      const archived = archiveCandidate(home, id, { reason, detail: `terminal ${reason}`, at: "2026-09-05T12:00:00.000Z" });
      expect(readArchiveReason(home, id)).toEqual({ reason, detail: `terminal ${reason}`, at: "2026-09-05T12:00:00.000Z" });
      expect(JSON.parse(readFileSync(archived.reasonPath, "utf8"))).toEqual(archived.reason);
      expect(readdirSync(join(home, "evolution", "candidates"))).toEqual([]);
      expect(isArchiveReason(reason)).toBe(true);
    }
    expect(isArchiveReason("cost_floor")).toBe(false);
  });

  test("publishes candidate, optional eval, and reason before removing the pending file", () => {
    const id = "run-7"; const home = fixture(id);
    const source = join(home, "evolution", "candidates", `${id}.json`);
    const candidateBytes = readFileSync(source, "utf8");
    const reportBytes = readFileSync(join(home, "evolution", "reports", id, "eval.json"), "utf8");
    const result = archiveCandidate(home, id, {
      reason: "lost_heldout",
      detail: "held-out lower bound did not clear the gate",
      at: new Date("2026-09-05T12:30:00.000Z"),
    });
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(result.candidatePath, "utf8")).toBe(candidateBytes);
    expect(readFileSync(result.evalPath!, "utf8")).toBe(reportBytes);
    expect(result.reason).toEqual({ reason: "lost_heldout", detail: "held-out lower bound did not clear the gate", at: "2026-09-05T12:30:00.000Z" });
  });

  test("omits eval.json when no report exists", () => {
    const home = fixture("manual", false);
    const result = archiveCandidate(home, "manual", { reason: "operator", detail: "withdrawn by supervisor" });
    expect(result.evalPath).toBeUndefined();
    expect(existsSync(join(result.dir, "eval.json"))).toBe(false);
  });

  test("is terminal and rejects bad reasons, details, ids, and absent candidates", () => {
    const home = fixture("candidate-1", false);
    archiveCandidate(home, "candidate-1", { reason: "operator", detail: "withdrawn" });
    expect(() => archiveCandidate(home, "candidate-1", { reason: "operator", detail: "again" })).toThrow(ArchiveError);
    expect(() => archiveCandidate(home, "missing", { reason: "operator", detail: "absent" })).toThrow(/candidate_not_found/);
    expect(() => archiveCandidate(home, "../escape", { reason: "operator", detail: "bad" })).toThrow(/invalid_candidate_id/);

    const second = fixture("candidate-2", false);
    expect(() => archiveCandidate(second, "candidate-2", { reason: "cost_floor" as never, detail: "removed reason" })).toThrow(/invalid_archive_reason/);
    expect(() => archiveCandidate(second, "candidate-2", { reason: "operator", detail: "two\nlines" })).toThrow(/archive detail/);
  });

  test("does not treat malformed reason records as terminal metadata", () => {
    for (const value of [
      { reason: "cost_floor", detail: "removed", at: "2026-09-05T12:00:00.000Z" },
      { reason: "operator", detail: "", at: "2026-09-05T12:00:00.000Z" },
      { reason: "operator", detail: "valid", at: "yesterday" },
    ]) {
      const home = fixture("malformed", false);
      const dir = join(home, "evolution", "archive", "malformed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "reason.json"), JSON.stringify(value));
      expect(readArchiveReason(home, "malformed")).toBeUndefined();
    }
  });
});
