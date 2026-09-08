import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStressScenario } from "../../scripts/stress-kiln";

const roots: string[] = [];
function root(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `kiln-stress-test-${name}-`));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("provider-free end-to-end stress matrix", () => {
  test.each([
    ["literature-ideation", "scholar_search", "open_ended_ideation", "landscape", "explore"],
    ["business-ideation", "web_search", "open_ended_ideation", "landscape", "explore"],
    ["broad-ambiguous-seed", "web_search", "open_ended_ideation", "landscape", "deliver"],
  ] as const)("%s reaches a usable autonomous checkpoint through real evidence tools", async (scenario, evidenceTool, intent, researchPolicy, goal) => {
    const result = await runStressScenario(scenario, { root: root(scenario) });

    expect(result.providerMode).toBe("mocked-models-only");
    expect(result.exitCodes).toEqual([0]);
    expect(result.status).toMatchObject({ phase: "form", state: "running" });
    expect(result.workflow).toMatchObject({ intent, researchPolicy, goal });
    expect(result.tools).toContain(evidenceTool);
    expect(result.searchHealth).toContain("ok");
    expect(result.phaseEnds).toEqual(expect.arrayContaining(["frame:ok", "discover:ok"]));
    expect(result.detail.frontierIdeas).toBeGreaterThan(0);
    expect(result.detail.discoveryFiles).toBe(2);
  }, 30_000);

  test("repairs a malformed frame artifact through the real validation-and-correction loop", async () => {
    const result = await runStressScenario("invalid-output-correction", { root: root("invalid") });

    expect(result.exitCodes).toEqual([0]);
    expect(result.status).toMatchObject({ phase: "discover", state: "running", shape: "product" });
    expect(result.detail.correctionWrites).toBe(2);
    expect(result.tools.filter((tool) => tool === "write")).toHaveLength(2);
    expect(result.phaseEnds).toContain("frame:ok");
  }, 15_000);

  test("empty output fails closed and never leaves a run falsely marked running", async () => {
    const result = await runStressScenario("empty-model-output", { root: root("empty") });

    expect(result.ok).toBe(true);
    expect(result.exitCodes).toEqual([1]);
    expect(result.status).toMatchObject({ state: "failed", outcome: { kind: "failure", failureClass: "verify" } });
    expect(result.detail.briefExists).toBe(false);
    expect(result.modelCalls).toBe(2);
    expect(result.phaseEnds).toContain("frame:failed");
  }, 15_000);

  test.each(["dns-resume", "rate-limit-resume"] as const)("%s stops durably and resumes without repeating frame", async (scenario) => {
    const result = await runStressScenario(scenario, { root: root(scenario) });

    expect(result.exitCodes).toEqual([0, 0]);
    expect(result.detail).toMatchObject({ stoppedState: "stopped", stoppedKind: "transient", frameWrites: 1 });
    expect(result.status).toMatchObject({ phase: "ideate", state: "running" });
    expect(result.phaseEnds.filter((phase) => phase === "frame:ok")).toHaveLength(1);
    expect(result.phaseEnds.filter((phase) => phase === "discover:stopped")).toHaveLength(1);
    expect(result.phaseEnds.filter((phase) => phase === "discover:ok")).toHaveLength(1);
  }, 20_000);

  test("provider refusal remains a refusal and cannot masquerade as an empty result", async () => {
    const result = await runStressScenario("provider-refusal", { root: root("refusal") });

    expect(result.ok).toBe(true);
    expect(result.exitCodes).toEqual([1]);
    expect(result.status).toMatchObject({ state: "failed", outcome: { kind: "failure", failureClass: "refusal" } });
    expect(result.phaseEnds).toContain("frame:failed");
  }, 15_000);

  test("an operator pause becomes a durable user pause and resumes at the saved phase", async () => {
    const result = await runStressScenario("pause-resume", { root: root("pause") });

    expect(result.exitCodes).toEqual([0, 0]);
    expect(result.detail).toMatchObject({ pausedState: "paused", pausedReason: "user_cancelled" });
    expect(result.status).toMatchObject({ phase: "discover", state: "running", shape: "product" });
    expect(result.phaseEnds.filter((phase) => phase === "frame:ok")).toHaveLength(1);
  }, 20_000);

  test("a delivery seed autonomously traverses the default route to a verified executable artifact", async () => {
    const result = await runStressScenario("plug-and-play-delivery", { root: root("plug-and-play") });

    expect(result.exitCodes).toEqual([0]);
    expect(result.workflow).toMatchObject({ goal: "deliver", defaultThrough: "reflect", checkpointDefault: "autonomous" });
    expect(result.status).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(result.phaseEnds).toEqual(["frame:ok", "form:ok", "build:ok", "reflect:ok"]);
    expect(result.tools).toContain("write");
    expect(result.tools).not.toContain("web_search");
    expect(result.detail).toMatchObject({ artifactOutput: "creme-brulee-for-kiln", artifactExitCode: 0, cleanRepo: true });
  }, 30_000);

  test.each([
    ["utility-delivery", "creme-brulee-for-kiln", [true]],
    ["utility-repair", '{"count":2,"total":7.5}', [false, true]],
  ] as const)("%s produces a clean repository and executable acceptance evidence", async (scenario, output, acceptance) => {
    const result = await runStressScenario(scenario, { root: root(scenario) });

    expect(result.exitCodes.at(-1)).toBe(0);
    expect(result.status).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(result.detail).toMatchObject({ artifactOutput: output, acceptanceChecks: [...acceptance], cleanRepo: true });
    expect(result.detail.crossProviderAudits).toBeGreaterThan(0);
    expect(result.phaseEnds).toContain("build:ok");
    expect(readFileSync(join(result.home, "runs", result.runId, "record.jsonl"), "utf8")).toContain('"t":"check"');
  }, 30_000);
});
