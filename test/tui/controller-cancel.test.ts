import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, type RunLock } from "../../src/core/lock";
import { currentRunControl } from "../../src/core/run-control";
import { readStatus, runPaths, writeStatus } from "../../src/core/run";
import { RunController, type TuiCli } from "../../src/tui/controller";

function home(): string { return mkdtempSync(join(tmpdir(), "kiln-tui-cancel-")); }

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}

function runId(argv: readonly string[]): string {
  const id = argv[2];
  if (!id) throw new Error("missing run id");
  return id;
}

describe("RunController cancellation", () => {
  test("cancels streaming and a pending ask, waits for unwind, and saves a resumable cursor", async () => {
    const root = home();
    let unwound = false;
    const cli: TuiCli = async (_argv, io) => {
      const source = currentRunControl()!.registerSource({ role: "brain", phase: "frame", steer: () => {} });
      source.text("partial answer");
      source.toolStart("work", "bash", { command: "long task" });
      try { await io.ask!("Clarify the target: "); }
      finally { await Bun.sleep(5); unwound = true; source.dispose(); }
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "cancel me" });
    await until(() => controller.getSnapshot().transcript.some((entry) => entry.kind === "brain" && entry.text.includes("Clarify")));

    await controller.cancel();
    await running;

    const snapshot = controller.getSnapshot();
    expect(unwound).toBe(true);
    expect(readStatus(runPaths(root, snapshot.runId!))).toMatchObject({
      state: "paused", pausedReason: "user_cancelled", cursor: { step: "user_cancelled" },
    });
    expect(snapshot.transcript).toContainEqual(expect.objectContaining({ kind: "brain", text: "partial answer", interrupted: true }));
    expect(snapshot.transcript).toContainEqual(expect.objectContaining({ kind: "tool", status: "cancelled", verb: "bash" }));
  });

  test("does not rewrite a user pause already persisted by the CLI under its lock", async () => {
    const root = home();
    const ready = deferred();
    let persistedAt = "";
    const cli: TuiCli = async (argv) => {
      const control = currentRunControl()!;
      ready.resolve();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      const run = runPaths(root, runId(argv));
      writeStatus(run, { state: "paused", pausedReason: "user_cancelled", cursor: { step: "cli-boundary" } });
      persistedAt = readStatus(run).updatedAt;
      await Bun.sleep(10);
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "CLI owns pause" });
    await ready.promise;

    await controller.cancel();
    await running;

    const status = readStatus(runPaths(root, controller.getSnapshot().runId!));
    expect(status).toMatchObject({ state: "paused", pausedReason: "user_cancelled", cursor: { step: "cli-boundary" } });
    expect(status.updatedAt).toBe(persistedAt);
  });

  test("does not overwrite a newer invocation holding the run lock", async () => {
    const root = home();
    const ready = deferred();
    let newerLock: RunLock | undefined;
    const cli: TuiCli = async (argv) => {
      const control = currentRunControl()!;
      ready.resolve();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      const run = runPaths(root, runId(argv));
      newerLock = acquireRunLock(run);
      writeStatus(run, { phase: "discover", state: "running", pausedReason: undefined, cursor: { step: "new-generation" } });
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "generation race" });
    await ready.promise;

    try {
      await controller.cancel();
      await running;
      expect(readStatus(runPaths(root, controller.getSnapshot().runId!))).toMatchObject({
        phase: "discover", state: "running", cursor: { step: "new-generation" },
      });
    } finally { newerLock?.release(); }
  });

  test("generation snapshot preserves a newer invocation which already released its lock", async () => {
    const root = home();
    const ready = deferred();
    const cli: TuiCli = async (argv) => {
      const control = currentRunControl()!;
      ready.resolve();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      const run = runPaths(root, runId(argv));
      const lock = acquireRunLock(run);
      try { writeStatus(run, { phase: "build", state: "running", cursor: { step: "newer-complete" } }); }
      finally { lock.release(); }
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "released generation" });
    await ready.promise;

    await controller.cancel();
    await running;

    expect(readStatus(runPaths(root, controller.getSnapshot().runId!))).toMatchObject({
      phase: "build", state: "running", cursor: { step: "newer-complete" },
    });
  });

  test("repeated cancel does not rebase the first generation snapshot", async () => {
    const root = home();
    const ready = deferred();
    const changed = deferred();
    const release = deferred();
    const cli: TuiCli = async (argv) => {
      const control = currentRunControl()!;
      ready.resolve();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      const run = runPaths(root, runId(argv));
      const lock = acquireRunLock(run);
      try { writeStatus(run, { phase: "discover", state: "running", cursor: { step: "after-first-cancel" } }); }
      finally { lock.release(); }
      changed.resolve();
      await release.promise;
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "double cancel" });
    await ready.promise;
    const firstCancel = controller.cancel();
    await changed.promise;
    const secondCancel = controller.cancel();
    release.resolve();

    await Promise.all([firstCancel, secondCancel, running]);
    expect(readStatus(runPaths(root, controller.getSnapshot().runId!))).toMatchObject({
      phase: "discover", state: "running", cursor: { step: "after-first-cancel" },
    });
  });

  test("a palette cancellation before onRun cannot pause the previously attached run", async () => {
    const root = home();
    const ready = deferred();
    let calls = 0;
    const cli: TuiCli = async () => {
      calls += 1;
      if (calls === 1) return 0;
      const control = currentRunControl()!;
      ready.resolve();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    await controller.start({ seed: "attached A" });
    const attached = runPaths(root, controller.getSnapshot().runId!);
    const before = readStatus(attached);
    const palette = controller.execute("build: start", ["different-B"]);
    await ready.promise;

    await controller.cancel();
    await palette;

    expect(readStatus(attached)).toEqual(before);
  });

  test("preserves terminal success written during cancellation unwind", async () => {
    const root = home();
    const ready = deferred();
    const cli: TuiCli = async (argv) => {
      const control = currentRunControl()!;
      ready.resolve();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      writeStatus(runPaths(root, runId(argv)), { phase: "reflect", state: "done", outcome: { kind: "success" } });
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "success during unwind" });
    await ready.promise;

    await controller.cancel();
    await running;

    expect(readStatus(runPaths(root, controller.getSnapshot().runId!))).toMatchObject({
      phase: "reflect", state: "done", outcome: { kind: "success" },
    });
  });

  test("does not overwrite success already durable when cancel arrives", async () => {
    const root = home();
    const durable = deferred();
    const cli: TuiCli = async (argv) => {
      writeStatus(runPaths(root, runId(argv)), { phase: "reflect", state: "done", outcome: { kind: "success" } });
      durable.resolve();
      await Bun.sleep(10);
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "finish race" });
    await durable.promise;
    await controller.cancel();
    await running;
    expect(readStatus(runPaths(root, controller.getSnapshot().runId!))).toMatchObject({ state: "done", outcome: { kind: "success" } });
  });
});
