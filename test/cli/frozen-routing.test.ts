import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/core/config";
import { createRun, writeStatus } from "../../src/core/run";
import { applyFrozenRouting, executionBudgetPhases, freezeRouting, frozenExecutionBudgetPhases, loadFrozenRouting, routingPath } from "../../src/workflow/routing";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() { const home = mkdtempSync(join(tmpdir(), "kiln-routing-freeze-")); homes.push(home); return createRun(home, "Find an idea", { id: "frozen" }); }

test("interrupted adaptive setup cannot silently resume as manual", () => {
  const run = fixture(); writeStatus(run, { routingRequired: true });
  expect(() => applyFrozenRouting(defaultConfig(), run)).toThrow("setup was interrupted");
  freezeRouting(run, defaultConfig(), {});
  expect(applyFrozenRouting(defaultConfig(), run).routing?.mode).toBe("adaptive");
});

test("a direct task's one-feature minimum stays frozen across resume", () => {
  const run = fixture(); const cfg = defaultConfig(); cfg.build.minFeatures = 1;
  freezeRouting(run, cfg, {});
  const changed = defaultConfig(); changed.build.minFeatures = 5;
  expect(applyFrozenRouting(changed, run).build.minFeatures).toBe(1);
  const plan = loadFrozenRouting(run)!;
  writeFileSync(routingPath(run), JSON.stringify({ ...plan, buildPlanning: { minFeatures: 0 } }));
  expect(() => loadFrozenRouting(run)).toThrow("build minimum");
});

test("frozen routing is idempotent, refuses replacement, and rejects seed drift", () => {
  const run = fixture(); const cfg = defaultConfig(); const report = { category: "general" };
  const first = freezeRouting(run, cfg, report);
  expect(freezeRouting(run, cfg, report)).toEqual(first);
  expect(() => freezeRouting(run, cfg, { category: "science" })).toThrow("already frozen");
  writeFileSync(run.seed, "Another seed");
  expect(() => loadFrozenRouting(run)).toThrow("seed mismatch");
});

test("frozen routing validates shares and efforts before application", () => {
  const run = fixture(); const cfg = defaultConfig(); const plan = freezeRouting(run, cfg, {});
  writeFileSync(routingPath(run), JSON.stringify({ ...plan, share: { ...plan.share, ideate: -1 } }));
  expect(() => applyFrozenRouting(cfg, run)).toThrow("budget shares");
  writeFileSync(routingPath(run), JSON.stringify({ ...plan, effort: "made-up" }));
  expect(() => applyFrozenRouting(cfg, run)).toThrow("effort");
});

test("budget methods use frozen shares with the current explicit total", () => {
  const run = fixture(); const cfg = defaultConfig(); cfg.budgets.share.ideate = 0.5; cfg.budgets.share.build = 0.395;
  freezeRouting(run, cfg, {});
  const newer = defaultConfig(); newer.budgets.usd = 40; newer.budgets.wallSeconds = 2400;
  const applied = applyFrozenRouting(newer, run);
  expect(applied.budgets.phaseBudgetUsd("ideate")).toBe(20);
  expect(applied.budgets.phaseBudgetWallSeconds("ideate")).toBe(1200);
  expect(newer.budgets.share.ideate).toBe(0.42);
});

test("execution budget phases come only from the frozen routing report", () => {
  const run = fixture();
  freezeRouting(run, defaultConfig(), { workflow: { phases: ["frame", "discover", "ideate", "checkpoint"] } });
  expect(frozenExecutionBudgetPhases(run)).toEqual(["frame", "discover", "ideate"]);
  const plan = loadFrozenRouting(run)!;
  writeFileSync(routingPath(run), JSON.stringify({ ...plan, report: { workflow: { phases: ["frame", "made-up"] } } }));
  expect(frozenExecutionBudgetPhases(run)).toBeUndefined();
});

test("execution phase union protects both originally requested and newly expanded phases", () => {
  const originallyFull = fixture();
  freezeRouting(originallyFull, defaultConfig(), { workflow: { phases: ["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"] } });
  expect(executionBudgetPhases(originallyFull, ["frame", "discover"])).toEqual(["frame", "discover", "ideate", "form", "build", "reflect"]);

  const originallyCheckpoint = createRun(homes[0]!, "Another seed", { id: "checkpoint" });
  freezeRouting(originallyCheckpoint, defaultConfig(), { workflow: { phases: ["frame", "discover", "ideate", "checkpoint"] } });
  expect(executionBudgetPhases(originallyCheckpoint, ["frame", "discover", "ideate", "form", "build", "reflect"]))
    .toEqual(["frame", "discover", "ideate", "form", "build", "reflect"]);
});
