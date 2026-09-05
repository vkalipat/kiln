import { describe, expect, test } from "bun:test";
import { runProcess } from "../../src/core/process";
import { RunControl, withRunControl } from "../../src/core/run-control";

describe("runProcess", () => {
  test("captures stdout, stderr, exit code", async () => {
    const r = await runProcess({ cmd: "sh", args: ["-c", "echo out; echo err 1>&2; exit 3"], timeoutMs: 5000 });
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.cancelled).toBe(false);
  });
  test("kills a sleeping process at the deadline", async () => {
    const t0 = Date.now();
    const r = await runProcess({ cmd: "sh", args: ["-c", "sleep 5"], timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.cancelled).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.overrunMs).toBeGreaterThanOrEqual(0);
  });
  test("kills a process that traps SIGTERM", async () => {
    const t0 = Date.now();
    const r = await runProcess({ cmd: "sh", args: ["-c", "trap '' TERM; sleep 5"], timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  test("does not spawn a command when its signal is already aborted", async () => {
    const r = await runProcess({
      cmd: "kiln-command-that-must-never-be-spawned",
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    });
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
    expect(r.stderr).toBe("");
  });
  test("aborting an in-flight child kills its process group promptly", async () => {
    const controller = new AbortController();
    const t0 = Date.now();
    const pending = runProcess({
      cmd: "sh",
      args: ["-c", "trap '' TERM; while :; do sleep 1; done"],
      timeoutMs: 10_000,
      drainMs: 500,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
  test("uses the ambient run cancellation signal when no explicit signal is passed", async () => {
    const control = new RunControl();
    const pending = withRunControl(control, () => runProcess({
      cmd: "sh",
      args: ["-c", "sleep 5"],
      timeoutMs: 10_000,
    }));
    setTimeout(() => control.cancel("test cancellation"), 100);
    const r = await pending;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
  });
  test("one ambient cancellation stops every concurrent process", async () => {
    const control = new RunControl();
    const pending = withRunControl(control, () => Promise.all([
      runProcess({ cmd: "sh", args: ["-c", "sleep 5"], timeoutMs: 10_000 }),
      runProcess({ cmd: "sh", args: ["-c", "sleep 5"], timeoutMs: 10_000 }),
    ]));
    setTimeout(() => control.cancel(), 100);
    const results = await pending;
    expect(results.every((result) => result.cancelled === true && result.timedOut === false)).toBe(true);
  });
  test("an explicit signal takes precedence over ambient run cancellation", async () => {
    const control = new RunControl();
    control.cancel("ambient cancellation");
    const r = await withRunControl(control, () => runProcess({
      cmd: "sh",
      args: ["-c", "printf explicit"],
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }));
    expect(r.cancelled).toBe(false);
    expect(r.stdout).toBe("explicit");
  });
  test("returns when a grandchild holds the output pipe", async () => {
    const t0 = Date.now();
    const r = await runProcess({ cmd: "sh", args: ["-c", "(sleep 5 &); echo started"], timeoutMs: 5000, drainMs: 500 });
    expect(r.stdout.trim()).toBe("started");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  test("truncates huge output but keeps head and tail", async () => {
    const r = await runProcess({ cmd: "sh", args: ["-c", "yes abcdefghij | head -c 300000"], timeoutMs: 5000, maxOutputBytes: 20000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(20000 + 100);
  });
  test("env merges over process.env by default", async () => {
    process.env.KILN_TEST_PLANTED = "planted-value";
    try {
      const r = await runProcess({ cmd: "sh", args: ["-c", "echo [$KILN_TEST_PLANTED][$KILN_TEST_EXTRA]"], env: { KILN_TEST_EXTRA: "extra" }, timeoutMs: 5000 });
      expect(r.stdout.trim()).toBe("[planted-value][extra]");
    } finally {
      delete process.env.KILN_TEST_PLANTED;
    }
  });
  test("envReplace uses the given env as the whole environment", async () => {
    process.env.KILN_TEST_PLANTED = "planted-value";
    try {
      const r = await runProcess({ cmd: "sh", args: ["-c", "echo [$KILN_TEST_PLANTED][$KILN_TEST_EXTRA]"], env: { KILN_TEST_EXTRA: "extra" }, envReplace: true, timeoutMs: 5000 });
      expect(r.stdout.trim()).toBe("[][extra]");
    } finally {
      delete process.env.KILN_TEST_PLANTED;
    }
  });
  test("does not report timedOut when the child exits before the deadline despite a lingering grandchild", async () => {
    const t0 = Date.now();
    const r = await runProcess({ cmd: "sh", args: ["-c", "(sleep 3 &); echo started"], timeoutMs: 300, drainMs: 1000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("started");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
