import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutonomyUseCase } from "../../scripts/usecases/autonomous-tooling";

const roots: string[] = [];

function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `kiln-usecase-${name}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider-free autonomous tooling demonstrations", () => {
  test("builds a working local utility and resumes a crash without another builder turn", async () => {
    const result = await runAutonomyUseCase("utility-crash-recovery", { root: workspace("recovery") });

    expect(result.providerMode).toBe("mocked-models-only");
    expect(result.firstExitCode).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.status).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(result.artifactOutput).toBe("creme-brulee-for-kiln");
    expect(result.builderSessions).toBe(1);
    expect(result.builderModelCallsAfterResume).toBe(0);
    expect(result.acceptanceChecks).toEqual([true]);
    expect(result.crossProviderAudits).toBe(1);
    expect(result.featureCommits).toHaveLength(1);
    expect(result.events).toEqual(expect.arrayContaining(["tool.call:write", "check:acceptance:pass", "attempt:passed", "phase.end:build:ok"]));
    expect(readFileSync(join(result.projectDir, "repo", "slugify.mjs"), "utf8")).toContain("normalize(\"NFKD\")");
    expect(spawnSync("git", ["log", "-1", "--format=%B"], { cwd: join(result.projectDir, "repo"), encoding: "utf8" }).stdout)
      .toContain("Kiln-Feature: f01");
  }, 30_000);

  test("uses failed executable evidence to repair a different utility on the next attempt", async () => {
    const result = await runAutonomyUseCase("check-failure-repair", { root: workspace("repair") });

    expect(result.providerMode).toBe("mocked-models-only");
    expect(result.exitCode).toBe(0);
    expect(result.status).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(result.artifactOutput).toBe('{"count":2,"total":7.5}');
    expect(result.builderSessions).toBe(2);
    expect(result.acceptanceChecks).toEqual([false, true]);
    expect(result.crossProviderAudits).toBe(2);
    expect(result.attemptDispositions).toEqual(["verify_failed", "passed"]);
    expect(result.featureCommits).toHaveLength(1);
    expect(result.events).toEqual(expect.arrayContaining(["check:acceptance:fail", "attempt:verify_failed", "check:acceptance:pass", "attempt:passed"]));
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: join(result.projectDir, "repo"), encoding: "utf8" }).stdout).toBe("");
  }, 30_000);
});
