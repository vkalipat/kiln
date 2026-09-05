import { describe, expect, test } from "bun:test";
import { cleanupAuditSnapshot } from "../../src/build/auditor-cleanup";
import type { AuditSnapshot, GitRunner } from "../../src/build/git";
import { runProcess } from "../../src/core/process";
import { currentRunControl, RunControl, withRunControl } from "../../src/core/run-control";

const snapshot: AuditSnapshot = {
  producerDir: "/producer",
  tempDir: "/temporary",
  indexFile: "/temporary/index",
  payloadDir: "/temporary/payload",
  commit: "a".repeat(40),
  worktree: "/temporary/worktree",
  entries: [],
};

describe("auditor cleanup", () => {
  test("runs process-backed cleanup outside an aborted run control", async () => {
    const outer = new RunControl();
    outer.cancel("primary cancellation");
    let removed = false;
    const git = {
      async removeAuditSnapshot() {
        expect(currentRunControl()).not.toBe(outer);
        expect(currentRunControl()?.signal.aborted).toBe(false);
        const result = await runProcess({ cmd: "sh", args: ["-c", "printf cleanup"], timeoutMs: 1_000 });
        expect(result.cancelled).toBe(false);
        expect(result.stdout).toBe("cleanup");
        removed = true;
      },
    } as unknown as GitRunner;
    await withRunControl(outer, () => cleanupAuditSnapshot(git, snapshot, 1_000));
    expect(removed).toBe(true);
    expect(outer.signal.aborted).toBe(true);
  });

  test("bounds a cleanup implementation that never settles", async () => {
    const git = { removeAuditSnapshot: () => new Promise<void>(() => {}) } as unknown as GitRunner;
    const started = Date.now();
    await expect(cleanupAuditSnapshot(git, snapshot, 10)).rejects.toThrow("cleanup timed out");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
