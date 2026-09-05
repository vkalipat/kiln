import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Candidate } from "../../src/evolution/candidate";
import { candidateList, listCandidateRows } from "../../src/evolution/list";

const currentHash = "champion-hash";
const createdAt = "2026-09-05T10:00:00.000Z";

function candidate(patch: Partial<Candidate> = {}): Candidate {
  return {
    version: 1,
    kind: "playbook",
    playbookHash: currentHash,
    author: "operator",
    createdAt,
    delta: { op: "edit", section: "build", id: "B1", text: "Keep builds small.", why: "Failures stay local.", evidence: [] },
    ...patch,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCandidate(home: string, state: "candidates" | "promoted", id: string, value = candidate()): void {
  writeJson(join(home, "evolution", state, `${id}.json`), value);
}

function writeReport(home: string, id: string, verdict: string, ratio: number, updatedHour: number): void {
  writeJson(join(home, "evolution", "reports", id, "eval.json"), {
    verdict,
    updatedAt: `2026-09-05T${String(updatedHour).padStart(2, "0")}:00:00.000Z`,
    passes: { heldout: { rate: 0.625, pairs: 48, requiredWins: 29, wilson: { lower: 0.51, upper: 0.72 } } },
    usdPerSuccess: { candidate: ratio * 10, champion: 10 },
    costUsd: 21.5,
    effortSwept: true,
    judgeCalibration: { status: verdict === "not_evidence" ? "calibrated" : "agent" },
  });
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name); const key = relative(root, child);
      if (statSync(child).isDirectory()) visit(child);
      else out[key] = readFileSync(child, "utf8");
    }
  };
  visit(root);
  return out;
}

describe("derived candidate list", () => {
  test("covers every state, verdict, column, footer, and cost boundary without mutating", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-list-"));
    writeCandidate(home, "candidates", "pending", candidate({ runId: "run-p", seed: { id: "dev-1", split: "dev", sha256: "a".repeat(64) } }));
    writeCandidate(home, "candidates", "stale", candidate({ playbookHash: "old-hash" }));
    for (const [index, verdict] of ["win", "lose", "not_evidence", "censored", "incomplete"].entries()) {
      const id = `evaluated-${verdict}`;
      writeCandidate(home, "candidates", id);
      writeReport(home, id, verdict, index === 0 ? 1.4 : index === 1 ? 1.5 : index === 2 ? 1.6 : 1, 11 + index);
    }
    writeCandidate(home, "promoted", "promoted", candidate({
      kind: "prompt", delta: undefined, prompt: { name: "builder", text: "Build narrowly.\n" },
    }));
    writeCandidate(home, "candidates", "trailer-promoted");

    const duplicate = "rolled-back";
    writeCandidate(home, "candidates", duplicate);
    writeCandidate(home, "promoted", duplicate);
    writeJson(join(home, "evolution", "archive", duplicate, "candidate.json"), candidate());
    writeJson(join(home, "evolution", "archive", duplicate, "reason.json"), {
      reason: "rolled_back", detail: "reverted", at: "2026-09-05T18:00:00.000Z",
    });

    const before = snapshot(home);
    const result = candidateList(home, { currentPlaybookHash: currentHash, promotedIds: ["trailer-promoted"] });
    expect(snapshot(home)).toEqual(before);
    expect(result.rows).toHaveLength(10);
    expect(result.rows.find((row) => row.id === "pending")).toMatchObject({ status: "pending", run: "run-p", seed: "dev-1", split: "dev", section: "build", op: "edit", targetId: "B1" });
    expect(result.rows.find((row) => row.id === "stale")?.status).toBe("stale");
    for (const verdict of ["win", "lose", "not_evidence", "censored", "incomplete"] as const) {
      expect(result.rows.find((row) => row.id === `evaluated-${verdict}`)?.status).toBe(`evaluated: ${verdict}`);
    }
    expect(result.rows.find((row) => row.id === "promoted")).toMatchObject({ status: "promoted", kind: "prompt", op: "replace", prompt: "builder" });
    expect(result.rows.find((row) => row.id === "trailer-promoted")?.status).toBe("promoted");
    expect(result.rows.filter((row) => row.id === duplicate)).toHaveLength(1);
    expect(result.rows.find((row) => row.id === duplicate)).toMatchObject({ status: "archived: rolled_back", at: "2026-09-05T18:00:00.000Z" });

    const win = result.rows.find((row) => row.id === "evaluated-win")!;
    expect(win).toMatchObject({ verdict: "win", heldoutRate: 0.625, heldoutLower: 0.51, heldoutUpper: 0.72, n: 48, required: 29, seedWins: null, candidateUsdPerSuccess: 14, championUsdPerSuccess: 10, costFlag: false, costUsd: 21.5, effortSwept: true });
    expect(result.rows.find((row) => row.id === "evaluated-lose")?.costFlag).toBe(false); // exactly 1.5x
    expect(result.rows.find((row) => row.id === "evaluated-not_evidence")?.costFlag).toBe(true); // 1.6x
    expect(result.judgeCalibrationStatus).toBe("agent"); // latest stamped report
  });

  test("honors an explicit cost cap and footer while preserving stored cost warnings", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-list-cap-"));
    writeCandidate(home, "candidates", "candidate");
    writeReport(home, "candidate", "win", 1.4, 12);
    expect(listCandidateRows(home, { costRatioCap: 1.3 })[0]?.costFlag).toBe(true);
    expect(candidateList(home, { judgeCalibrationStatus: "removed" }).judgeCalibrationStatus).toBe("removed");
  });

  test("derives arm cost efficiency from actual evolution run rows", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-list-runs-"));
    writeCandidate(home, "candidates", "candidate");
    writeJson(join(home, "evolution", "reports", "candidate", "eval.json"), {
      verdict: "win", class: "build", updatedAt: createdAt, effortSwept: true,
      judgeCalibration: { status: "calibrated" },
      passes: { heldout: { rate: 0.75, pairs: 32, requiredWins: 22, seedWins: 7, wilson: { lower: 0.52, upper: 0.88 } } },
      runs: [
        { arm: "candidate", cost: { build: { usd: 12, successes: 6 } } },
        { arm: "champion", cost: { build: { usd: 8, successes: 8 } } },
      ],
    });
    expect(listCandidateRows(home)[0]).toMatchObject({ candidateUsdPerSuccess: 2, championUsdPerSuccess: 1, costFlag: true, seedWins: 7 });
  });
});
