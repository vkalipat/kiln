import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorTeamStore, type TeamFeaturePlan } from "../../src/operator/team";
import { registerOperatorTeamTools } from "../../src/operator/team-tools";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "kiln-team-")); dirs.push(cwd);
  const store = createOperatorTeamStore({ runDir: cwd, cwd, runId: "test-run", originalSourceHash: sha("seed") }); await store.initialize();
  mkdirSync(join(cwd, "src/a"), { recursive: true });
  writeFileSync(join(cwd, "src/a/result.txt"), "result");
  return { cwd, store, artifact: { path: "src/a/result.txt", sha256: sha("result") } };
}
const plan = (id: string, scope = `src/${id}`, dependencies: string[] = []): TeamFeaturePlan => ({ id, objective: `Ship ${id}`, scopes: [scope], dependencies, acceptance: ["Behavior is verified"] });
test("independent features claim disjoint scopes and require parent review before dependency readiness", async () => {
  const { store, artifact } = await setup();
  await store.plan([plan("a"), plan("b"), plan("c", "src/c", ["a"])], 0);
  await store.claim("a", "worker-a", 1); await store.claim("b", "worker-b", 2);
  await expect(store.claim("c", "worker-c", 3)).rejects.toThrow("dependencies");
  await store.handoff("a", "worker-a", { summary: "Implemented", checks: ["test passed (worker report)"], artifacts: [artifact] }, 3);
  expect(store.query().features[0]!.handoff!.status).toBe("unverified_claim");
  await expect(store.claim("c", "worker-c", 4)).rejects.toThrow("dependencies");
  await expect(store.accept("a", "worker-a", ["checked"], [artifact], 4)).rejects.toThrow("separate parent");
  await store.accept("a", "parent", ["Independently tested behavior"], [artifact], 4);
  await store.claim("c", "worker-c", 5);
  expect(store.query().features[0]!.review!.status).toBe("parent_reviewed");
});
test("overlapping active ownership, stale concurrent revisions, cycles and unsafe paths are rejected", async () => {
  const { store } = await setup();
  await expect(store.plan([plan("a", "../escape")], 0)).rejects.toThrow("relative");
  await expect(store.plan([plan("a", "src/a", ["b"]), plan("b", "src/b", ["a"])], 0)).rejects.toThrow("cycle");
  await store.plan([plan("a", "src"), plan("b", "src/b"), plan("c", "test/c"), plan("d", "test/d")], 0);
  await store.claim("a", "a", 1);
  await expect(store.claim("b", "b", 2)).rejects.toThrow("scope conflicts");
  const results = await Promise.allSettled([store.claim("c", "c", 2), store.claim("d", "d", 2)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(store.query().revision).toBe(3);
});
test("owner impersonation and artifact drift cannot advance a handoff", async () => {
  const { store, artifact, cwd } = await setup();
  await store.plan([plan("a")], 0); await store.claim("a", "worker", 1);
  const evidence = { summary: "Done", checks: ["test output"], artifacts: [artifact] };
  await expect(store.handoff("a", "impostor", evidence, 2)).rejects.toThrow("owner");
  await store.handoff("a", "worker", evidence, 2);
  writeFileSync(join(cwd, artifact.path), "changed");
  await expect(store.accept("a", "parent", ["review"], [artifact], 3)).rejects.toThrow("drift");
  expect(store.query().revision).toBe(3);
});
test("artifact symlinks and ledger original requirement mismatch are rejected", async () => {
  const { store, artifact, cwd } = await setup();
  symlinkSync(join(cwd, "src/a/result.txt"), join(cwd, "alias.txt"));
  await store.plan([plan("a")], 0); await store.claim("a", "worker", 1);
  await expect(store.handoff("a", "worker", { summary: "Done", checks: ["test"], artifacts: [{ ...artifact, path: "alias.txt" }] }, 2)).rejects.toThrow("path");
  const other = createOperatorTeamStore({ cwd, runDir: cwd, runId: "test-run", originalSourceHash: sha("different") });
  expect(() => other.query()).toThrow("original requirements");
});
test("native tool derives actor identity from session; caller role cannot authorize acceptance", async () => {
  const { store } = await setup();
  let tool: any;
  const { z } = await import("zod");
  registerOperatorTeamTools({ zod: z, registerTool: (t: unknown) => { tool = t; } } as any, { store, parentSessionId: () => "parent", assertOriginal() {} });
  let unavailableTool: any;
  registerOperatorTeamTools({ zod: z, registerTool: (t: unknown) => { unavailableTool = t; } } as any, { store, parentSessionId: () => undefined, assertOriginal() {} });
  const ctx = (session: string) => ({ sessionManager: { getSessionId: () => session } });
  await expect(unavailableTool.execute("x", { action: "plan", plans: [plan("a")], expectedRevision: 0 }, undefined, undefined, ctx("parent"))).rejects.toThrow("parent operator");
  await expect(tool.execute("x", { action: "plan", plans: [plan("a")], expectedRevision: 0, role: "parent" }, undefined, undefined, ctx("worker"))).rejects.toThrow("parent operator");
  await tool.execute("x", { action: "plan", plans: [plan("a")], expectedRevision: 0 }, undefined, undefined, ctx("parent"));
  await tool.execute("x", { action: "claim", id: "a", expectedRevision: 1, owner: "parent" }, undefined, undefined, ctx("worker"));
  expect(store.query().features[0]!.owner).toBe("worker");
  await expect(tool.execute("x", { action: "accept", id: "a", expectedRevision: 2, role: "parent" }, undefined, undefined, ctx("worker"))).rejects.toThrow("parent operator");
});

test("parent recovery preserves handoff and checks dependency evidence on new claims", async () => {
  const { store, artifact, cwd } = await setup();
  await store.plan([plan("a"), plan("b", "src/b", ["a"])], 0);
  await store.claim("a", "worker", 1);
  await store.handoff("a", "worker", { summary: "Done", checks: ["worker report"], artifacts: [artifact] }, 2);
  await store.accept("a", "parent", ["reviewed"], [artifact], 3);
  writeFileSync(join(cwd, artifact.path), "changed");
  await expect(store.claim("b", "worker-b", 4)).rejects.toThrow("drift");
  await store.reopen("a", "parent", "Artifact drift requires rework", 4);
  expect(store.query().features[0]!.history![0]!.previous.status).toBe("accepted");
  await store.claim("a", "new-worker", 5);
  expect(store.query().features[0]!.owner).toBe("new-worker");
});

test("scope aliases, unrelated handoff evidence and worker reopen are refused", async () => {
  const { store, artifact, cwd } = await setup();
  symlinkSync(join(cwd, "src"), join(cwd, "alias"));
  await expect(store.plan([plan("alias", "alias/a")], 0)).rejects.toThrow("symlinks");
  await store.plan([plan("a"), plan("b", "SRC/A")], 0); await store.claim("a", "worker", 1);
  await expect(store.claim("b", "other", 2)).rejects.toThrow("scope conflicts");
  writeFileSync(join(cwd, "unrelated.txt"), "result");
  await expect(store.handoff("a", "worker", { summary: "Done", checks: ["check"], artifacts: [{ ...artifact, path: "unrelated.txt" }] }, 2)).rejects.toThrow("owned scope");
  let tool: any; const { z } = await import("zod");
  registerOperatorTeamTools({ zod: z, registerTool: (t: unknown) => { tool = t; } } as any, { store, parentSessionId: () => "parent", assertOriginal() {} });
  await expect(tool.execute("x", { action: "reopen", id: "a", summary: "retry", expectedRevision: 2 }, undefined, undefined, { sessionManager: { getSessionId: () => "worker" } })).rejects.toThrow("parent operator");
});
test("transitive dependency drift prevents downstream claim and acceptance", async () => {
  const { store, artifact, cwd } = await setup();
  mkdirSync(join(cwd, "src/b")); writeFileSync(join(cwd, "src/b/result.txt"), "b");
  const bArtifact = { path: "src/b/result.txt", sha256: sha("b") };
  await store.plan([plan("a"), plan("b", "src/b", ["a"]), plan("c", "src/c", ["b"])], 0);
  await store.claim("a", "a", 1); await store.handoff("a", "a", { summary: "a", checks: ["a"], artifacts: [artifact] }, 2);
  await store.accept("a", "parent", ["a"], [artifact], 3);
  await store.claim("b", "b", 4); await store.handoff("b", "b", { summary: "b", checks: ["b"], artifacts: [bArtifact] }, 5);
  writeFileSync(join(cwd, artifact.path), "drift");
  await expect(store.accept("b", "parent", ["b"], [bArtifact], 6)).rejects.toThrow("drift");
  writeFileSync(join(cwd, artifact.path), "result"); await store.accept("b", "parent", ["b"], [bArtifact], 6);
  writeFileSync(join(cwd, artifact.path), "drift");
  await expect(store.claim("c", "c", 7)).rejects.toThrow("drift");
  expect(store.query().revision).toBe(7);
});

test("glob spellings cannot bypass literal scope ownership", async () => {
  const { store } = await setup();
  for (const scope of ["src/**", "src/*.ts", "src/?.ts", "src/[ab].ts", "src/{a,b}.ts"]) {
    await expect(store.plan([plan("a", scope)], 0)).rejects.toThrow("not globs");
  }
  expect(store.query().revision).toBe(0);
  expect(store.query().features).toHaveLength(0);
});
