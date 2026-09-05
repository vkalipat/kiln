import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { judgeArms } from "../../src/evals/judging";

function arm(home: string, id: string, ids: string[]) {
  const run = createRun(home, "seed", { id }); mkdirSync(run.renderedDir, { recursive: true });
  writeFileSync(run.frontier, `${JSON.stringify({ round: 1, mode: "loop", shown: ids, ideas: ids.map((ideaId) => ({ id: ideaId })) })}\n`);
  ids.forEach((ideaId) => writeFileSync(join(run.renderedDir, `${ideaId}-r1.md`), `${id} ${ideaId}\n`));
  return { name: id, run };
}

describe("cross-arm judging", () => {
  test("rank matches k pairs, writes both orders, and skips them on resume", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-judging-"));
    const evalDir = join(home, "reports", "eval-1"); mkdirSync(evalDir, { recursive: true });
    const a = arm(home, "champion", ["a1", "a2", "a3"]); const b = arm(home, "candidate", ["b1", "b2"]);
    const reportRun = createRun(home, "report", { id: "report" }); const record = new RunRecord(reportRun.record);
    let judged = 0; let criteria = 0;
    const deps = {
      home, run: reportRun, record, cfg: defaultConfig(), models: () => { throw new Error("unused"); },
      apiKeyFor: async () => undefined, effort: "medium",
    };
    const options = {
      pairsPerSeed: 4,
      writeCriteria: async () => { criteria += 1; return { ok: true as const, id: "criteria-1", text: "criteria", round: 1, shape: "product" as const, reused: false, costUsd: 0 }; },
      judgePair: async (_deps: unknown, _criteria: unknown, _ar: string, _br: string, order: "ab" | "ba") => {
        judged += 1; return { valueWinner: order === "ab" ? "a" as const : "b" as const, feasibilityWinner: "a" as const, reason: "fixture", judgeModel: "fixture/judge", costUsd: 0.01, retried: false };
      },
      now: () => new Date("2026-09-05T00:00:00.000Z"),
    };
    const first = await judgeArms(evalDir, { id: "dev-1", text: "seed", shape: "product" }, a, b, deps, options);
    expect(first.lines).toHaveLength(4);
    expect(judged).toBe(4);
    expect(first.lines.map((line) => line.order)).toEqual(["ab", "ba", "ab", "ba"]);
    expect(first.lines.every((line) => line.seedId === "dev-1" && line.fallbackUnknown === true)).toBe(true);
    expect(first.collapsed.value).toHaveLength(2);
    expect(readFileSync(join(evalDir, "judged.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);

    const resumed = await judgeArms(evalDir, { id: "dev-1", text: "seed", shape: "product" }, a, b, deps, options);
    expect(resumed.lines).toHaveLength(4);
    expect(judged).toBe(4);
    expect(criteria).toBe(2); // writer is called, but durable pair keys suppress all paid comparisons
  });
});
