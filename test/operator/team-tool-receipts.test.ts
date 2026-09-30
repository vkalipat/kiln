import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createOperatorTeamStore } from "../../src/operator/team";
import { registerOperatorTeamTools } from "../../src/operator/team-tools";

test("compact mutation receipts preserve revision workflow, evidence and explicit full reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-team-receipts-"));
  try {
    const store = createOperatorTeamStore({ runDir: dir, cwd: dir, runId: "test", originalSourceHash: "a".repeat(64) });
    await store.initialize();
    let tool: any;
    registerOperatorTeamTools({ zod: z, registerTool(value: any) { tool = value; } } as never,
      { store, parentSessionId: () => "parent", assertOriginal() {} });
    const invoke = async (actor: string, args: unknown) => JSON.parse((await tool.execute("test", args, undefined, undefined,
      { sessionManager: { getSessionId: () => actor } })).content[0].text);
    const plans = Array.from({ length: 32 }, (_, i) => ({ id: `feature${i}`, objective: `Implement feature ${i}: ${"specific objective ".repeat(20)}`,
      scopes: [`feature${i}.txt`], dependencies: [], acceptance: [`Verify behavior ${i}`] }));
    let receipt = await invoke("parent", { action: "plan", expectedRevision: 0, plans });
    expect(receipt.features).toHaveLength(32);
    expect(receipt.limitedView).toBe(true);
    receipt = await invoke("worker", { action: "claim", id: "feature0", expectedRevision: receipt.revision });
    expect(receipt.features).toHaveLength(1);
    expect(receipt.features[0]).toMatchObject({ id: "feature0", status: "active", owner: "worker", scopes: ["feature0.txt"] });
    expect(receipt.features[0].criterionIds).toHaveLength(1);
    expect(receipt.ledger.sha256).toBe(createHash("sha256").update(readFileSync(store.path)).digest("hex"));
    const full = await invoke("parent", { action: "query" });
    expect(full).toEqual(store.query());
    expect(full.features).toHaveLength(32);
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const receiptBytes = Buffer.byteLength(JSON.stringify(receipt));
    expect(receiptBytes).toBeLessThan(fullBytes / 4);
    console.log(JSON.stringify({ fixture: "32-feature-claim", fullBytes, receiptBytes,
      fullApproxTokens: Math.ceil(fullBytes / 4), receiptApproxTokens: Math.ceil(receiptBytes / 4), estimate: "UTF8 bytes/4, not billed tokens" }));
    await expect(invoke("worker", { action: "claim", id: "feature1", expectedRevision: 1 })).rejects.toThrow("revision conflict");
    writeFileSync(join(dir, "feature0.txt"), "verified bytes");
    const artifact = { path: "feature0.txt", sha256: createHash("sha256").update("verified bytes").digest("hex") };
    const coverage = [{ criterionId: receipt.features[0].criterionIds[0], artifacts: [artifact], checkIndices: [0] }];
    receipt = await invoke("worker", { action: "handoff", id: "feature0", expectedRevision: receipt.revision,
      summary: "Ready", checks: ["worker check"], artifacts: [artifact], coverage });
    expect(receipt.features[0].handoff).toEqual({ summary: "Ready", checks: ["worker check"], artifacts: [artifact], coverage, status: "unverified_claim" });
    const packet = await invoke("parent", { action: "review_packet", id: "feature0" });
    expect(packet).toEqual(store.reviewPacket("feature0"));
    expect(packet.taskQualityValidated).toBe(false);
    expect(packet.criteria[0].checks[0].status).toBe("unverified_worker_claim");
    await expect(invoke("worker", { action: "accept", id: "feature0", expectedRevision: receipt.revision,
      criteria: ["checked"], artifacts: [artifact] })).rejects.toThrow("parent operator");
    receipt = await invoke("parent", { action: "accept", id: "feature0", expectedRevision: receipt.revision,
      criteria: ["checked"], artifacts: [artifact] });
    expect(receipt.features[0].review).toMatchObject({ status: "parent_reviewed", artifacts: [artifact] });
    receipt = await invoke("parent", { action: "reopen", id: "feature0", expectedRevision: receipt.revision, summary: "Recheck" });
    expect(receipt.features[0].history).toBeUndefined();
    expect(receipt.features[0].handoff).toBeUndefined();
    expect((await invoke("parent", { action: "query" })).features[0].history).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
