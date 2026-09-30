import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorRuntime } from "../../src/operator/runtime";
import type { OmpSessionHandle } from "../../src/operator/session";
import { AuthStore } from "../../src/providers/auth";
import { initHome } from "../../src/core/home";
import { readStatus } from "../../src/core/run";
import { readRunLock } from "../../src/core/lock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(disposeFails = false) {
  const home = mkdtempSync(join(tmpdir(), "kiln-runtime-recovery-")); initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("anthropic", "synthetic-test-key");
  const entered = deferred(), finish = deferred(), abortCalled = deferred();
  let disposals = 0;
  const runtime = await createOperatorRuntime({ home, cwd: home, seed: "Preserve recovery ownership", auth,
    budgetUsd: null, wallSeconds: null, jev: { enabled: false },
    createSession: async () => ({ sessionId: "recovery-fixture", sessionFile: join(home, "session.jsonl"),
      session: { prompt: async () => { entered.resolve(); await finish.promise; },
        abort: async () => { abortCalled.resolve(); throw new Error("native abort failed"); } },
      awaitSettled: async () => {}, dispose: async () => { disposals++; if (disposeFails) throw new Error("native disposal failed"); },
    }) as unknown as OmpSessionHandle });
  return { runtime, entered, finish, abortCalled, disposals: () => disposals };
}

test("failed native abort cannot release the run lock before the active turn settles", async () => {
  const f = await fixture();
  const work = f.runtime.prompt("Continue the original task"); await f.entered.promise;
  let disposed = false;
  const closing = f.runtime.dispose().then(() => { disposed = true; return undefined; }, error => { disposed = true; return error; });
  await f.abortCalled.promise; await Promise.resolve(); await Promise.resolve();
  expect(disposed).toBe(false);
  expect(readRunLock(f.runtime.run)).toBeDefined();
  expect(f.disposals()).toBe(0);
  f.finish.resolve();
  expect((await work).stopped).toBe("paused");
  expect((await closing)?.message).toBe("native abort failed");
  expect(f.disposals()).toBe(1);
  expect(readRunLock(f.runtime.run)).toBeUndefined();
  expect(readStatus(f.runtime.run).state).toBe("paused");
});

test("native cleanup failure persists truthful terminal failure rather than stale running state", async () => {
  const f = await fixture(true);
  const work = f.runtime.prompt("Continue the original task"); await f.entered.promise;
  const cancellation = f.runtime.cancel().catch(error => error);
  await f.abortCalled.promise; f.finish.resolve();
  expect((await work).stopped).toBe("failed");
  expect((await cancellation).message).toBe("native abort failed");
  expect(readStatus(f.runtime.run)).toMatchObject({ state: "failed", outcome: { kind: "failure", message: "Operator cleanup failed: native disposal failed" } });
  expect(readRunLock(f.runtime.run)).toBeDefined();
  expect(f.disposals()).toBe(1);
  await f.runtime.dispose();
  expect(readRunLock(f.runtime.run)).toBeUndefined();
});
