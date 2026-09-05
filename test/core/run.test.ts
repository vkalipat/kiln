import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, newRunId, readStatus, writeStatus } from "../../src/core/run";

describe("run", () => {
  test("newRunId has the documented shape", () => {
    expect(newRunId(new Date("2026-09-02T10:30:22Z"))).toMatch(/^20260902-103022-[0-9a-f]{4}$/);
  });
  test("createRun writes seed and status", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = createRun(home, "an app for beekeepers");
    expect(readFileSync(p.seed, "utf8")).toBe("an app for beekeepers\n");
    expect(existsSync(p.discoveryDir)).toBe(true);
    const s = readStatus(p);
    expect(s.phase).toBe("frame");
    expect(s.state).toBe("running");
    writeStatus(p, { phase: "discover" });
    expect(readStatus(p).phase).toBe("discover");
    expect(readStatus(p).createdAt).toBe(s.createdAt);
  });
});

describe("run paths and status for ideate", () => {
  test("createRun makes every ideation directory and names every new path", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = createRun(home, "an app for beekeepers");
    for (const d of [p.dir, p.discoveryDir, p.ideasDir, p.toolOutputDir, p.criteriaDir, p.renderedDir, p.probesDir, p.rawIdeasDir, p.reflectDir]) {
      expect(existsSync(d)).toBe(true);
    }
    expect(p.tournament).toBe(join(p.dir, "tournament.jsonl"));
    expect(p.frontier).toBe(join(p.dir, "frontier.json"));
    expect(p.metrics).toBe(join(p.dir, "metrics.json"));
    expect(p.lock).toBe(join(p.dir, "run.lock"));
    expect(p.criteriaDir).toBe(join(p.dir, "criteria"));
    expect(p.probesDir).toBe(join(p.dir, "probes"));
    expect(p.renderedDir).toBe(join(p.ideasDir, "rendered"));
    expect(p.rawIdeasDir).toBe(join(p.ideasDir, "raw"));
    expect(p.project).toBe(join(p.dir, "project"));
    expect(p.features).toBe(join(p.dir, "features.json"));
    expect(p.acceptanceLock).toBe(join(p.dir, "acceptance.lock"));
    expect(p.featureState).toBe(join(p.dir, "state.jsonl"));
    expect(p.audits).toBe(join(p.dir, "audits.jsonl"));
    expect(p.digest).toBe(join(p.reflectDir, "digest.md"));
  });
  test("status carries shape, cursor, pause and truncation fields", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = createRun(home, "seed");
    writeStatus(p, {
      shape: "product",
      shapeHash: "deadbeef",
      wakeAt: "2026-09-03T10:00:00.000Z",
      pausedReason: "usage_limit",
      cursor: { round: 2, step: "tournament" },
      chosenIdeaId: "r1-i1-2",
      specHash: "spec123",
      relocked: true,
      ideationRounds: 4,
      truncated: true,
    });
    const s = readStatus(p);
    expect(s.shape).toBe("product");
    expect(s.shapeHash).toBe("deadbeef");
    expect(s.wakeAt).toBe("2026-09-03T10:00:00.000Z");
    expect(s.pausedReason).toBe("usage_limit");
    expect(s.cursor).toEqual({ round: 2, step: "tournament" });
    expect(s.chosenIdeaId).toBe("r1-i1-2");
    expect(s.specHash).toBe("spec123");
    expect(s.relocked).toBe(true);
    expect(s.ideationRounds).toBe(4);
    expect(s.truncated).toBe(true);
  });
  test("status accepts a build cursor without a round", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = createRun(home, "seed");
    writeStatus(p, { cursor: { featureId: "f02", attempt: 3, step: "audit" } });
    expect(readStatus(p).cursor).toEqual({ featureId: "f02", attempt: 3, step: "audit" });
  });
  test("a stopped outcome records its stop kind", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = createRun(home, "seed");
    writeStatus(p, { state: "stopped", outcome: { kind: "stopped", stopKind: "budget", truncatedRound: 2, frontierEmpty: true, budgetTargetUsd: 25, wallTargetSeconds: 14_400 } });
    const s = readStatus(p);
    expect(s.outcome?.kind).toBe("stopped");
    expect(s.outcome?.stopKind).toBe("budget");
    expect(s.outcome?.truncatedRound).toBe(2);
    expect(s.outcome?.frontierEmpty).toBe(true);
    expect(s.outcome?.budgetTargetUsd).toBe(25);
    expect(s.outcome?.wallTargetSeconds).toBe(14_400);
    expect(s.state).toBe("stopped");
  });
});
