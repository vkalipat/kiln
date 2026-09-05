import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseRequestPath, requestRunPause, watchRunPause } from "../../src/core/pause-request";
import { RunCancelledError, RunControl } from "../../src/core/run-control";
import { createRun } from "../../src/core/run";
import { acquireRunLock } from "../../src/core/lock";

const setup = () => {
  const run = createRun(mkdtempSync(join(tmpdir(), "kiln-pause-")), "seed");
  acquireRunLock(run);
  return run;
};

describe("pause requests", () => {
  test("writes a fixed sanitized request in the protected tool-output tree", () => {
    const run = setup();
    requestRunPause(run, () => new Date("2026-09-05T12:00:00.000Z"));
    expect(JSON.parse(readFileSync(pauseRequestPath(run), "utf8"))).toEqual({
      version: 2,
      requestedAt: "2026-09-05T12:00:00.000Z",
      generation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("consumes a pre-existing request once and cancels immediately", () => {
    const run = setup();
    requestRunPause(run);
    const control = new RunControl();
    const dispose = watchRunPause(run, control);
    expect(control.signal.aborted).toBe(true);
    expect(control.signal.reason).toBeInstanceOf(RunCancelledError);
    expect((control.signal.reason as Error).message).toBe("operator pause requested");
    expect(existsSync(pauseRequestPath(run))).toBe(false);
    dispose();
  });

  test("a request for an exited owner cannot cancel its successor", () => {
    const run = setup();
    requestRunPause(run);
    const oldPath = pauseRequestPath(run);
    const successor = acquireRunLock(run, { force: true });
    const control = new RunControl();
    const dispose = watchRunPause(run, control);
    expect(control.signal.aborted).toBe(false);
    expect(pauseRequestPath(run)).not.toBe(oldPath);
    dispose(); successor.release();
  });

  test("does not create an unscoped request without an active owner", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-pause-")), "seed");
    expect(requestRunPause(run)).toBe(false);
    expect(existsSync(pauseRequestPath(run))).toBe(false);
  });

  test("polls for a later request, consumes it, and self-disposes", async () => {
    const run = setup();
    const control = new RunControl();
    watchRunPause(run, control, { pollMs: 5 });
    requestRunPause(run);
    for (let i = 0; i < 100 && !control.signal.aborted; i += 1) await Bun.sleep(2);
    expect(control.signal.aborted).toBe(true);
    expect(existsSync(pauseRequestPath(run))).toBe(false);
    requestRunPause(run);
    await Bun.sleep(15);
    expect(existsSync(pauseRequestPath(run))).toBe(true);
  });

  test("external cancellation disposes the watcher without consuming later requests", async () => {
    const run = setup();
    const control = new RunControl();
    const dispose = watchRunPause(run, control, { pollMs: 5 });
    control.cancel("direct TUI cancel");
    requestRunPause(run);
    await Bun.sleep(15);
    expect(existsSync(pauseRequestPath(run))).toBe(true);
    dispose();
  });

  test("atomically gives one request to only one watcher", () => {
    const run = setup();
    requestRunPause(run);
    const first = new RunControl();
    const second = new RunControl();
    const disposeFirst = watchRunPause(run, first);
    const disposeSecond = watchRunPause(run, second);
    expect([first.signal.aborted, second.signal.aborted].filter(Boolean)).toHaveLength(1);
    expect(existsSync(pauseRequestPath(run))).toBe(false);
    disposeFirst();
    disposeSecond();
  });

  test("consumes malformed or noncanonical markers without cancelling or hot-polling them", async () => {
    const run = setup();
    writeFileSync(pauseRequestPath(run), '{"version":1,"requestedAt":"2026-02-30"}\n');
    const control = new RunControl();
    const dispose = watchRunPause(run, control, { pollMs: 5 });
    await Bun.sleep(10);
    expect(control.signal.aborted).toBe(false);
    expect(existsSync(pauseRequestPath(run))).toBe(false);
    dispose();
  });
});
