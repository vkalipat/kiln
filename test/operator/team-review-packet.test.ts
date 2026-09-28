import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorTeamStore, teamCriterionId, type TeamCriterionEvidence } from "../../src/operator/team";
import { registerOperatorTeamTools } from "../../src/operator/team-tools";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-review-packet-")); dirs.push(cwd);
  const options = { runDir: cwd, cwd, runId: "packet-run", originalSourceHash: sha("original") };
  const store = createOperatorTeamStore(options); await store.initialize();
  mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src/a.txt"), "artifact");
  const artifact = { path: "src/a.txt", sha256: sha("artifact") };
  const acceptance = ["Persist setting", "Read setting after restart", "Read setting after restart"];
  await store.plan([{ id: "a", objective: "Settings", scopes: ["src/a.txt"], dependencies: [], acceptance }], 0);
  return { store, cwd, options, artifact, acceptance };
}
test("every criterion has a stable ID and legacy unmapped evidence remains unknown across resume", async () => {
  const { store, options, artifact, acceptance } = await setup();
  const initial = store.reviewPacket("a");
  expect(initial.criteria).toHaveLength(3); expect(new Set(initial.criteria.map(c => c.id)).size).toBe(3);
  expect(initial.evidenceIdentity).toBe("unavailable");
  expect(initial.criteria.every(c => c.mappingState === "unmapped" && c.proof === "not_established")).toBe(true);
  await store.claim("a", "worker", 1);
  await store.handoff("a", "worker", { summary: "Done", artifacts: [artifact], checks: ["tests passed, worker says"] }, 2);
  const resumed = createOperatorTeamStore(options); await resumed.initialize();
  const packet = resumed.reviewPacket("a");
  expect(packet.criteria.map(c => c.id)).toEqual(initial.criteria.map(c => c.id));
  expect(packet.criteria[0]!.id).toBe(teamCriterionId("a", 0, acceptance[0]!));
  expect(packet.criteria.every(c => c.mappingState === "unmapped")).toBe(true);
  expect(packet).toMatchObject({ requirementCompleteness: "not_established", taskQualityValidated: false, parentReviewRequired: true, evidenceIdentity: "fresh" });
  expect(resumed.query().revision).toBe(3);
});
test("declared mappings preserve exact artifacts and checks without establishing actual proof", async () => {
  const { store, artifact } = await setup(); const ids = store.reviewPacket("a").criteria.map(c => c.id);
  await store.claim("a", "worker", 1);
  await store.handoff("a", "worker", { summary: "Done", artifacts: [artifact], checks: ["test persistence"], coverage: [
    { criterionId: ids[0]!, artifacts: [artifact], checkIndices: [0] },
    { criterionId: ids[1]!, artifacts: [], checkIndices: [0] },
  ] }, 2);
  const packet = store.reviewPacket("a");
  expect(packet.criteria.map(c => c.mappingState)).toEqual(["worker_declared", "worker_declared", "unmapped"]);
  expect(packet.criteria[0]!.artifacts).toEqual([{ ...artifact, identity: "fresh" }]);
  expect(packet.criteria[0]!.checks).toEqual([{ index: 0, text: "test persistence", status: "unverified_worker_claim" }]);
  expect(packet.criteria.every(c => c.proof === "not_established")).toBe(true);
  expect(store.query().features[0]!.status).toBe("awaiting_review");
});
test("unknown criteria, mismatched artifact hashes and invalid check mappings fail atomically", async () => {
  const { store, artifact } = await setup(), criterionId = store.reviewPacket("a").criteria[0]!.id;
  await store.claim("a", "worker", 1);
  const invalid: TeamCriterionEvidence[][] = [
    [{ criterionId: "unknown", artifacts: [artifact], checkIndices: [] }],
    [{ criterionId, artifacts: [{ ...artifact, sha256: sha("wrong") }], checkIndices: [] }],
    [{ criterionId, artifacts: [{ ...artifact, path: "src/other.txt" }], checkIndices: [] }],
    [{ criterionId, artifacts: [], checkIndices: [1] }],
    [{ criterionId, artifacts: [], checkIndices: [0, 0] }],
    [{ criterionId, artifacts: [], checkIndices: [] }],
    [{ criterionId, artifacts: [artifact], checkIndices: [] }, { criterionId, artifacts: [artifact], checkIndices: [] }],
  ];
  for (const coverage of invalid) {
    await expect(store.handoff("a", "worker", { summary: "Done", artifacts: [artifact], checks: ["claim"], coverage }, 2)).rejects.toThrow();
    expect(store.query().revision).toBe(2);
  }
});
test("artifact drift or missing files invalidate packet identity without hiding any criterion", async () => {
  const { store, artifact, cwd } = await setup(), criterionId = store.reviewPacket("a").criteria[0]!.id;
  await store.claim("a", "worker", 1); await store.handoff("a", "worker", { summary: "Done", artifacts: [artifact], checks: ["claim"], coverage: [{ criterionId, artifacts: [artifact], checkIndices: [0] }] }, 2);
  writeFileSync(join(cwd, artifact.path), "changed");
  const drift = store.reviewPacket("a");
  expect(drift.evidenceIdentity).toBe("invalid"); expect(drift.criteria).toHaveLength(3); expect(drift.criteria[0]!.artifacts[0]!.identity).toBe("invalid");
  expect(drift.evidenceErrors.join(" ")).toContain("drift"); expect(store.query().revision).toBe(3);
  rmSync(join(cwd, artifact.path)); expect(store.reviewPacket("a").evidenceIdentity).toBe("invalid");
});
test("reopen preserves history while clearing mappings and keeps criterion IDs stable", async () => {
  const { store, artifact } = await setup(), initial = store.reviewPacket("a");
  const criterionId = initial.criteria[0]!.id;
  await store.claim("a", "worker", 1); await store.handoff("a", "worker", { summary: "Done", artifacts: [artifact], checks: ["claim"], coverage: [{ criterionId, artifacts: [artifact], checkIndices: [] }] }, 2);
  await store.reopen("a", "parent", "Need actual restart evidence", 3);
  const packet = store.reviewPacket("a");
  expect(packet.criteria.map(c => c.id)).toEqual(initial.criteria.map(c => c.id));
  expect(packet.criteria.every(c => c.mappingState === "unmapped")).toBe(true); expect(packet.evidenceIdentity).toBe("unavailable");
  expect(store.query().features[0]!.history![0]!.previous.handoff!.coverage![0]!.criterionId).toBe(criterionId);
});
test("packet rechecks dependency evidence even when this feature's own artifacts are fresh", async () => {
  const { store, artifact, cwd } = await setup();
  await store.claim("a", "worker", 1); await store.handoff("a", "worker", { summary: "Done", artifacts: [artifact], checks: ["claim"] }, 2);
  await store.accept("a", "parent", ["first", "second", "third"], [artifact], 3);
  await store.plan([{ id: "b", objective: "Consumer", scopes: ["src/b.txt"], dependencies: ["a"], acceptance: ["Works with settings"] }], 4);
  writeFileSync(join(cwd, "src/b.txt"), "b"); const bArtifact = { path: "src/b.txt", sha256: sha("b") };
  await store.claim("b", "worker-b", 5); await store.handoff("b", "worker-b", { summary: "Done", artifacts: [bArtifact], checks: ["claim"] }, 6);
  writeFileSync(join(cwd, artifact.path), "drift");
  expect(store.reviewPacket("b").evidenceIdentity).toBe("invalid");
  expect(store.reviewPacket("b").evidenceErrors.join(" ")).toContain("drift");
});
test("native review_packet is read-only for workers and never grants parent acceptance", async () => {
  const { store, artifact } = await setup(); let tool: any, changes = 0;
  const { z } = await import("zod");
  registerOperatorTeamTools({ zod: z, registerTool: (t: unknown) => { tool = t; } } as any, { store, parentSessionId: () => "parent", assertOriginal() {}, onChange: () => changes++ });
  const ctx = { sessionManager: { getSessionId: () => "worker" } };
  const result = await tool.execute("q", { action: "review_packet", id: "a" }, undefined, undefined, ctx);
  expect(JSON.parse(result.content[0].text).criteria).toHaveLength(3); expect(changes).toBe(0); expect(store.query().revision).toBe(1);
  await expect(tool.execute("x", { action: "accept", id: "a", expectedRevision: 1, artifacts: [artifact], criteria: ["passed"] }, undefined, undefined, ctx)).rejects.toThrow("parent operator");
});
