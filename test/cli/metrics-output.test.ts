import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { printMetricsReport } from "../../src/cli/metrics-output";
import { collectMetrics } from "../../src/evals/metrics";
import { createRun, writeStatus } from "../../src/core/run";
import { writeAtomic } from "../../src/core/paths";

test("text metrics retains every shape, done/all statistics, exit counts and calibration provenance", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-text-metrics-"));
  const run = createRun(home, "seed"); writeStatus(run, { state: "done", shape: "product", outcome: { kind: "success" } });
  writeAtomic(run.metrics, JSON.stringify({ costUsd: 4, featuresPassed: { executed: 2 } }));
  const output: string[] = [];
  printMetricsReport({ write: (text) => output.push(text) }, collectMetrics(home));
  const text = output.join("");
  for (const shape of ["research", "product", "creative", "unknown"]) expect(text).toContain(`${shape} (`);
  for (const label of ["done mean", "all mean", "done median", "all median", "featuresPassed.executed", "honest exits: none", "pairCensored", "judgeCalibration.status: absent"]) expect(text).toContain(label);
});
