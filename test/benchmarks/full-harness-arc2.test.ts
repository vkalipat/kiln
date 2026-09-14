import { describe, expect, test } from "bun:test";
import { aggregateArc2Scores, arc2Directive, projectArc2Task, scoreArc2Answer, selectArc2Tasks } from "../../scripts/benchmarks/full-harness/arc2";
import { planWorkflow } from "../../src/workflow/plan";

// Synthetic fixtures only: no benchmark task/label downloads or task selection.
const task = () => ({ train: [{ input: [[1]], output: [[2]], secret: { answer: "HIDDEN" } }],
  test: [{ input: [[3]], output: [[4, 4]], secret: "HIDDEN" }, { input: [[5]], output: [[6], [6]] }],
  metadata: { nested: { test: { output: "HIDDEN" } } } });
const correct = () => ({ predictions: [
  { attempt_1: [[0]], attempt_2: [[4, 4]] }, { attempt_1: [[6], [6]], attempt_2: [[0]] },
] });

describe("ARC2 isolated task adapter", () => {
  test("allowlist projection drops recursive labels/metadata and deep-copies grids", () => {
    const original = task(); const projected = projectArc2Task(original);
    expect(projected).toEqual({ train: [{ input: [[1]], output: [[2]] }], test: [{ input: [[3]] }, { input: [[5]] }] });
    expect(JSON.stringify(projected)).not.toContain("HIDDEN");
    expect(JSON.stringify(projected.test)).not.toContain("output");
    original.train[0]!.input[0]![0] = 9;
    expect(projected.train[0]!.input).toEqual([[1]]);
    expect(arc2Directive(task())).not.toContain("HIDDEN");
  });
  test("artifact directive takes appropriate direct native route without forcing ideation", () => {
    const directive = arc2Directive(task());
    expect(directive).toContain("answer.json");
    expect(planWorkflow(directive, { adaptive: true }).strategy).toEqual({ mode: "direct", research: "none" });
  });
  test("pass@2 allows different successful attempt numbers but requires every input", () => {
    expect(scoreArc2Answer(task(), JSON.stringify(correct()))).toMatchObject({ valid: true, solved: true, score: 1, testSolved: [true, true] });
    const partial = correct(); partial.predictions[1]!.attempt_1 = [[0]];
    expect(scoreArc2Answer(task(), partial)).toMatchObject({ valid: true, solved: false, score: 0, testSolved: [true, false] });
  });
  test("exact dimensions and cells matter", () => {
    const wrong = correct(); wrong.predictions[0]!.attempt_2 = [[4], [4]];
    expect(scoreArc2Answer(task(), wrong).score).toBe(0);
    wrong.predictions[0]!.attempt_2 = [[4, 3]];
    expect(scoreArc2Answer(task(), wrong).score).toBe(0);
  });
  test("missing, extra, malformed and more than two attempts fail closed", () => {
    for (const answer of [undefined, "not json", {}, { predictions: [] },
      { ...correct(), explanation: "extra" }, { predictions: [...correct().predictions, correct().predictions[0]] },
      { predictions: [{ ...correct().predictions[0], attempt_3: [[4, 4]] }, correct().predictions[1]] },
      { predictions: [{ attempt_1: [[4, 4]] }, correct().predictions[1]] },
      { predictions: [{ attempt_1: [[0]], attempt_2: [[4], []] }, correct().predictions[1]] },
      { predictions: [{ attempt_1: [[10]], attempt_2: [[4, 4]] }, correct().predictions[1]] },
      { predictions: [{ attempt_1: [[0.5]], attempt_2: [[4, 4]] }, correct().predictions[1]] },
    ]) expect(scoreArc2Answer(task(), answer)).toMatchObject({ valid: false, score: 0, solved: false });
  });
  test("invalid controller labels throw rather than producing a misleading task failure", () => {
    expect(() => scoreArc2Answer({ train: task().train, test: [{ input: [[3]] }] }, correct())).toThrow();
    expect(() => projectArc2Task({ train: [], test: [] })).toThrow();
  });
  test("aggregate accuracy retains 0.25 and rejects missing/invalid scores", () => {
    const win = scoreArc2Answer(task(), correct()); const loss = scoreArc2Answer(task(), {});
    expect(aggregateArc2Scores([win, loss, loss, loss])).toEqual({ tasks: 4, solved: 1, accuracy: 0.25 });
    expect(() => aggregateArc2Scores([])).toThrow();
    for (const score of [undefined, NaN, 0.25, 2]) expect(() => aggregateArc2Scores([{ ...win, score } as never])).toThrow();
  });
  test("ID-only selection is stable, disjoint and bound to its source pool", () => {
    const ids = ["00000001", "00000002", "00000003", "00000004"];
    const a = selectArc2Tasks(ids, ["00000002"], 2, "synthetic-selection");
    expect(a).toEqual(selectArc2Tasks([...ids].reverse(), ["00000002"], 2, "synthetic-selection"));
    expect(a.selectedIds).not.toContain("00000002");
    expect(a.selectedIds).toEqual(["00000003", "00000001"]);
    expect(new Set(a.selectedIds).size).toBe(2);
    expect(a.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(selectArc2Tasks([...ids, "00000005"], ["00000002"], 2, "synthetic-selection").manifestSha256).not.toBe(a.manifestSha256);
    expect(() => selectArc2Tasks(ids, ids, 1, "seed")).toThrow();
    expect(() => selectArc2Tasks([ids[0]!, ids[0]!], [], 1, "seed")).toThrow();
  });
});
