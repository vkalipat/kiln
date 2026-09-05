import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/core/config";
import type { RunStatus } from "../../src/core/run";
import { routeResume } from "../../src/cli/commands/run-routing";

function status(patch: Partial<RunStatus>): RunStatus {
  return {
    id: "r", phase: "ideate", state: "running", usdSpent: 0, turns: {},
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("routeResume", () => {
  test.each(["frame", "discover", "ideate", "form", "build", "reflect"] as const)("re-enters a running %s phase", (phase) => {
    expect(routeResume(status({ phase }), false, defaultConfig(), 0)).toEqual({ kind: "phase", phase });
  });

  test("waits for a future usage window and re-enters an elapsed pause", () => {
    expect(routeResume(status({ state: "paused", wakeAt: "2026-01-02T00:00:00.000Z" }), false, defaultConfig(), Date.parse("2026-01-01T00:00:00.000Z"))).toEqual({ kind: "wait", wakeAt: "2026-01-02T00:00:00.000Z" });
    expect(routeResume(status({ phase: "build", state: "paused", wakeAt: "2025-01-01T00:00:00.000Z" }), false, defaultConfig(), Date.parse("2026-01-01T00:00:00.000Z"))).toEqual({ kind: "phase", phase: "build", wake: true });
    expect(routeResume(status({ phase: "form", state: "paused", pausedReason: "user_cancelled" }), false, defaultConfig(), 0)).toEqual({ kind: "phase", phase: "form", wake: true });
  });

  test.each([
    ["rounds", false, "checkpoint"], ["stagnant", false, "checkpoint"], ["stalled", false, "ideate"], ["budget", true, "checkpoint"],
  ] as const)("routes ideation %s to %s", (stopKind, hasFrontier, phase) => {
    expect(routeResume(status({ state: "stopped", outcome: { kind: "stopped", stopKind } }), hasFrontier, defaultConfig(), 0)).toEqual({ kind: "phase", phase });
  });

  test("requires an increased ideation budget when no frontier exists", () => {
    const cfg = defaultConfig();
    const stopped = status({ state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: cfg.budgets.usd } });
    expect(routeResume(stopped, false, cfg, 0).kind).toBe("stop");
    cfg.budgets.usd += 1;
    expect(routeResume(stopped, false, cfg, 0)).toEqual({ kind: "phase", phase: "ideate" });
  });

  test.each(["transient", "blocked"] as const)("re-enters build for %s", (stopKind) => {
    expect(routeResume(status({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind } }), false, defaultConfig(), 0)).toEqual({ kind: "phase", phase: "build" });
  });

  test("requires the matching build target to increase for deadline and budget", () => {
    const cfg = defaultConfig();
    const budget = status({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: cfg.budgets.usd } });
    const deadline = status({ phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "deadline", wallTargetSeconds: cfg.budgets.wallSeconds } });
    expect(routeResume(budget, false, cfg, 0).kind).toBe("stop");
    expect(routeResume(deadline, false, cfg, 0).kind).toBe("stop");
    cfg.budgets.usd += 1; cfg.budgets.wallSeconds += 1;
    expect(routeResume(budget, false, cfg, 0)).toEqual({ kind: "phase", phase: "build" });
    expect(routeResume(deadline, false, cfg, 0)).toEqual({ kind: "phase", phase: "build" });
  });

  test("refuses completed and failed runs with actionable messages", () => {
    expect(routeResume(status({ state: "done", outcome: { kind: "success" } }), false, defaultConfig(), 0)).toMatchObject({ kind: "refuse", message: "run is complete" });
    expect(routeResume(status({ phase: "build", state: "done", outcome: { kind: "honest_exit", exitKind: "cannot_be_satisfied" } }), false, defaultConfig(), 0)).toMatchObject({ kind: "refuse", message: expect.stringContaining("project relock") });
    expect(routeResume(status({ phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "integrity", message: "bad lock" } }), false, defaultConfig(), 0)).toMatchObject({ kind: "refuse", message: expect.stringContaining("project relock") });
    expect(routeResume(status({ state: "failed", outcome: { kind: "failure", failureClass: "verify", message: "bad output" } }), false, defaultConfig(), 0)).toEqual({ kind: "refuse", message: "bad output" });
  });
});
