import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Metrics } from "../../src/build/metrics";
import { foldCost } from "../../src/core/cost";
import { writeAtomic } from "../../src/core/paths";
import { RunRecord } from "../../src/core/record";
import { createRun, writeStatus, type RunStatus } from "../../src/core/run";
import { collectMetrics, METRIC_KEYS, METRIC_ROOTS } from "../../src/evals/metrics";

const home = () => mkdtempSync(join(tmpdir(), "kiln-metrics-"));
function fixture(root: string, id: string, status: Partial<RunStatus>, metrics: unknown) {
  const run = createRun(root, "seed", { id });
  writeStatus(run, { createdAt: "2026-09-05T12:00:00.000Z", ...status });
  writeAtomic(run.metrics, JSON.stringify(metrics));
  return run;
}
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path); else files[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  visit(root); return files;
}

test("metric roots are a compile-time subset and all paths remain inside the allowlist", () => {
  const roots: readonly (keyof (Metrics & { cost: unknown }))[] = METRIC_ROOTS;
  expect(METRIC_KEYS.every((key) => roots.includes(key.split(".")[0] as (typeof roots)[number]))).toBe(true);
});

test("aggregates all four shapes, keeps honest exits visible, and distinguishes done from all", () => {
  const root = home();
  fixture(root, "success", { shape: "product", state: "done", outcome: { kind: "success" } }, { schemaVersion: 99, costUsd: 4, featuresPassed: { executed: 2 }, noveltyEnforced: true });
  fixture(root, "stopped", { shape: "product", state: "stopped", outcome: { kind: "stopped", stopKind: "budget" } }, { costUsd: 8, featuresPassed: { executed: 1 }, censored: false });
  fixture(root, "honest", { shape: "product", state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied" } }, { costUsd: 12, featuresPassed: { executed: 0 } });
  fixture(root, "failed", { state: "failed", outcome: { kind: "failure", failureClass: "integrity" } }, { costUsd: null });
  fixture(root, "paused", { shape: "research", state: "paused" }, { costUsd: null });
  const before = tree(root); const report = collectMetrics(root);
  expect(report.runs).toMatchObject({ total: 5, done: 1, stopped: { budget: 1 }, failed: { integrity: 1 }, paused: 1, honestExits: { cannot_be_satisfied: 1 } });
  expect(Object.keys(report.buckets)).toEqual(["research", "product", "creative", "unknown"]);
  expect(report.buckets.product.metrics.costUsd).toEqual({ done: { n: 1, mean: 4, median: 4 }, all: { n: 3, mean: 8, median: 8 } });
  expect(report.buckets.product.metrics["featuresPassed.executed"].all.sum).toBe(3);
  expect(report.buckets.creative.metrics.costUsd.all).toEqual({ n: 0, mean: null, median: null });
  expect(tree(root)).toEqual(before);
});

test("consumes canonical cost and falls back to ID-keyed survivors, not backfilled frontier size", () => {
  const root = home(); const run = fixture(root, "fallback", { state: "done" }, { frontier: { raw: 1, shown: 5 }, featuresPassed: { executed: 2 } });
  const record = new RunRecord(run.record);
  record.append({ t: "phase.start", phase: "ideate" });
  record.append({ t: "model.call", role: "generator", provider: "mock", model: "m", stopReason: "stop", excerpt: "", costUsd: 8, usage: { input: 100, output: 20, cacheRead: 100, cacheWrite: 0 }, inputHash: "x" });
  record.append({ t: "idea.insert", id: "one", cell: "x", similarity: 0, parents: [] });
  record.append({ t: "idea.insert", id: "two", cell: "y", similarity: 0, parents: [] });
  record.append({ t: "idea.reject", id: "never-inserted", reason: "restatement" });
  record.append({ t: "idea.reject", id: "two", reason: "collided" });
  const canonical = foldCost([], "build", 2); canonical.usdPerSuccess = 9;
  fixture(root, "canonical", { state: "done" }, { cost: { build: canonical } });
  const result = collectMetrics(root);
  const fallback = result.rows.find((row) => row.runId === run.id)!;
  expect(fallback.values["cost.ideate.usdPerSuccess"]).toBe(8);
  expect(fallback.values["frontier.shown"]).toBe(5);
  expect(fallback.costSource.ideate).toBe("fallback");
  expect(fallback.cacheHealth.ideate.cacheHealthy).toBeNull();
  expect(fallback.values["cost.frame.usdPerSuccess"]).toBeNull();
  expect(result.rows.find((row) => row.runId === "canonical")?.values["cost.build.usdPerSuccess"]).toBe(9);
  expect(JSON.stringify(result)).not.toContain("Infinity");
});

test("since supports timestamps and run IDs, rejecting ambiguous or unknown input", () => {
  const root = home();
  fixture(root, "early", { createdAt: "2026-09-04T00:00:00.000Z" }, { costUsd: 1 });
  fixture(root, "later", { createdAt: "2026-09-05T00:00:00.000Z" }, { costUsd: 2 });
  expect(collectMetrics(root, { since: "later" }).rows.map((row) => row.runId)).toEqual(["later"]);
  expect(collectMetrics(root, { since: "2026-09-05T00:00:00Z" }).runs.total).toBe(1);
  expect(() => collectMetrics(root, { since: "unknown-run" })).toThrow("--since");
});

test("staged metrics carry partner-specific censorship without changing per-run censored", () => {
  const root = home();
  for (const arm of ["A0", "B0", "A1", "A2"]) fixture(join(root, "evolution", "work", "m1-test", arm), `seed-${arm}`, {
    state: arm === "A1" ? "stopped" : "done", seed: { id: "heldout-product-01", split: "heldout", sha256: "a".repeat(64) },
    outcome: arm === "A1" ? { kind: "stopped", stopKind: "budget" } : { kind: "success" },
  }, { censored: false });
  expect(collectMetrics(root).rows).toEqual([]);
  const result = collectMetrics(root, { evals: true });
  const baseline = result.rows.find((row) => row.arm === "A0")!;
  expect(baseline.pairCensored).toBe(true);
  expect(baseline.values.censored).toBe(false);
  expect(baseline.pairCensoring?.find((pair) => pair.arm === "B0")?.pairCensored).toBe(false);
  expect(result.rows.find((row) => row.arm === "A2")?.pairCensored).toBe(false);
});

test("fallback-served calls are excluded from cross-provider counts", () => {
  const root = home(); const run = fixture(root, "fallback", {}, { crossProviderCritic: 99 }); const record = new RunRecord(run.record);
  for (const fallbackServed of [true, false]) {
    record.append({ t: "model.call", role: "critic", provider: "mock", model: "m", stopReason: "stop", excerpt: "", costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, inputHash: "x", fallbackServed });
    record.append({ t: "critique", verdict: "ok", crossProvider: true, scopeCreep: [], unverifiable: [], missing: [], provider: "mock", model: "m", stopped: "done", costUsd: 0, usdCapHit: false });
  }
  expect(collectMetrics(root).rows[0]!.values.crossProviderCritic).toBe(1);
});
