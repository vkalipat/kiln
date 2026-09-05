import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSummary } from "../../src/cli/project-summary";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { createRun, writeStatus } from "../../src/core/run";
import type { FeaturesFile } from "../../src/formation/features";

const FEATURES: FeaturesFile = { version: 1, init: { needs: [] }, features: [{ id: "f01", title: "One", description: "d", acceptance: { type: "file", path: "one" } }] };

describe("projectSummary", () => {
  test("uses run-side features and state even when every project mirror is poisoned", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-summary-")); initHome(home);
    const run = createRun(home, "seed", { id: "r" });
    writeFileSync(run.features, JSON.stringify(FEATURES));
    writeFileSync(run.featureState, `${JSON.stringify({ t: "feature.state", featureId: "f01", from: "pending", to: "passed", source: "executed", attempts: 1, repairs: 0, commitSha: "abc" })}\n`);
    writeFileSync(run.project, "not a project mirror\n");
    writeStatus(run, { phase: "build", projectDir: "/authoritative/project", outcome: { kind: "stopped", stopKind: "blocked" } });
    const record = new RunRecord(run.record); record.append({ t: "note", text: "cost is authoritative" });
    expect(projectSummary(run)).toMatchObject({
      id: "r", dir: run.dir, projectDir: "/authoritative/project", outcome: { kind: "stopped", stopKind: "blocked" },
      features: [{ id: "f01", title: "One", state: "passed", passes: true, attempts: 1, repairs: 0, passSource: "executed", commitSha: "abc" }],
    });
  });

  test("returns an empty feature list before form", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-summary-")); initHome(home);
    expect(projectSummary(createRun(home, "seed", { id: "r" })).features).toEqual([]);
  });
});
