import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCheck, runCheck, type RunCheckOptions } from "../../src/build/verify";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import type { Acceptance } from "../../src/formation/features";

function temp(prefix = "kiln-check-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setup(patch: Partial<RunCheckOptions> = {}) {
  const home = temp(); const run = createRun(home, "seed", { id: "check-run" });
  const cwd = temp(); const checksDir = join(temp(), "checks"); const record = new RunRecord(run.record);
  const options: RunCheckOptions = {
    cwd,
    checksDir,
    timeoutMs: 5_000,
    maxOutputBytes: 8_388_608,
    needs: [],
    record,
    featureId: "f01",
    attempt: 1,
    phase: "acceptance",
    checkId: "check-1",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" },
    ...patch,
  };
  return { home, run, cwd, checksDir, record, options };
}

async function check(acceptance: Acceptance, patch: Partial<RunCheckOptions> = {}) {
  const state = setup(patch);
  return { ...state, result: await runCheck(acceptance, state.options) };
}

describe("runCheck shell", () => {
  test("runs in cwd with an allowlisted environment and matches combined output", async () => {
    const s = await check(
      { type: "shell", command: "printf '%s|%s|%s|%s' \"$PWD\" \"$KILN_ALLOWED\" \"$KILN_HIDDEN\" \"$TERM\"; printf ' stderr-token' >&2", expect: { type: "substring", value: "stderr-token" }, needs: ["KILN_ALLOWED"] },
      { env: { PATH: process.env.PATH, KILN_ALLOWED: "yes", KILN_HIDDEN: "no", TERM: "color" } },
    );
    expect(s.result.ok).toBe(true);
    expect(readFileSync(s.result.outputPath, "utf8")).toBe(`${realpathSync(s.cwd)}|yes||dumb stderr-token`);
    expect(s.result.predicateMatched).toBe(true);
  });

  test("distinguishes exit failure and predicate failure", async () => {
    const failed = await check({ type: "shell", command: "printf nope; exit 7" });
    expect(failed.result).toMatchObject({ ok: false, exitCode: 7, timedOut: false });
    expect(classifyCheck(failed.result)).toBe("verify");
    const missed = await check({ type: "shell", command: "printf actual", expect: { type: "regex", value: "expected$" } });
    expect(missed.result).toMatchObject({ ok: false, exitCode: 0, predicateMatched: false });
  });

  test("clamps to the acceptance timeout and records a process-group overrun", async () => {
    const s = await check({ type: "shell", command: "trap '' TERM; sleep 5", timeoutSeconds: 0.1 }, { timeoutMs: 2_000 });
    expect(s.result.timedOut).toBe(true);
    expect(s.result.durationMs).toBeLessThan(2_000);
    expect(s.result.overrunMs).toBeGreaterThan(0);
    expect(classifyCheck(s.result)).toBe("deadline");
    const event = s.record.read().find((item) => item.t === "check");
    expect(event).toMatchObject({ timedOut: true, overrunMs: s.result.overrunMs });
  });

  test("retains five MiB under the default cap while returning a 1000-character excerpt", async () => {
    const s = await check({ type: "shell", command: "yes x | head -c 5242880" }, { timeoutMs: 10_000 });
    expect(s.result.ok).toBe(true);
    expect(s.result.outputTruncated).toBe(false);
    expect(statSync(s.result.outputPath).size).toBe(5_242_880);
    expect(s.result.output.length).toBeLessThanOrEqual(1_000);
  });

  test("marks over-cap evidence truncated and keeps the bounded captured bytes", async () => {
    const s = await check({ type: "shell", command: "yes abcdef | head -c 20000" }, { maxOutputBytes: 1_000 });
    expect(s.result.ok).toBe(true);
    expect(s.result.outputTruncated).toBe(true);
    expect(readFileSync(s.result.outputPath, "utf8")).toContain("[output truncated]");
    expect(s.result.output.length).toBeLessThanOrEqual(1_000);
  });
});

describe("runCheck file", () => {
  test("checks existence and contains relative to cwd", async () => {
    const s = setup(); writeFileSync(join(s.cwd, "artifact.txt"), "alpha beta");
    const exists = await runCheck({ type: "file", path: "artifact.txt" }, s.options);
    expect(exists.ok).toBe(true);
    const contains = await runCheck({ type: "file", path: "artifact.txt", contains: "beta" }, { ...s.options, checkId: "check-2" });
    expect(contains.ok).toBe(true);
    const misses = await runCheck({ type: "file", path: "artifact.txt", contains: "gamma" }, { ...s.options, checkId: "check-3" });
    expect(misses.ok).toBe(false);
    expect(classifyCheck(misses)).toBe("verify");
  });

  test("refuses absolute, escaping and physical symlink escapes", async () => {
    const s = setup(); const outside = join(temp(), "outside.txt"); writeFileSync(outside, "secret");
    symlinkSync(outside, join(s.cwd, "linked.txt"));
    for (const [index, path] of [outside, "../outside.txt", "linked.txt"].entries()) {
      const result = await runCheck({ type: "file", path }, { ...s.options, checkId: `escape-${index}` });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("refused file path outside repo");
    }
  });

  test("refuses lexical parent traversal before resolving a path that returns inside", async () => {
    const s = setup(); writeFileSync(join(s.cwd, "artifact.txt"), "safe");
    const result = await runCheck({ type: "file", path: "unused/../artifact.txt" }, s.options);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("refused file path outside repo");
    expect(readFileSync(result.outputPath, "utf8")).toContain("unused/../artifact.txt");
  });

  test("turns NUL, symlink-loop and stat errors into retained failed check events", async () => {
    const s = setup();
    symlinkSync("loop-b", join(s.cwd, "loop-a")); symlinkSync("loop-a", join(s.cwd, "loop-b"));
    writeFileSync(join(s.cwd, "plain-file"), "plain");
    const cases = ["nul\0path", "loop-a", "plain-file/child"];
    for (const [index, path] of cases.entries()) {
      const result = await runCheck({ type: "file", path }, { ...s.options, checkId: `path-error-${index}` });
      expect(result.ok).toBe(false);
      expect(existsSync(result.outputPath)).toBe(true);
      expect(classifyCheck(result)).toBe("verify");
    }
    const events = s.record.read().filter((event) => event.t === "check");
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.ok === false && event.kind === "file")).toBe(true);
  });

  test("reports a missing in-root file as a verification failure", async () => {
    const s = await check({ type: "file", path: "missing.txt" });
    expect(s.result.ok).toBe(false);
    expect(s.result.output).toContain("file not found");
    expect(classifyCheck(s.result)).toBe("verify");
  });
});

describe("runCheck bookkeeping", () => {
  test("missing dependencies and manual checks do not create attempt events", async () => {
    const missing = await check({ type: "shell", command: "exit 0", needs: ["KILN_DEFINITELY_MISSING_DEP"] }, { which: () => null });
    expect(missing.result).toMatchObject({ ok: false, notRunReason: "missing_dependency:KILN_DEFINITELY_MISSING_DEP", durationMs: 0 });
    expect(classifyCheck(missing.result)).toBeUndefined();
    expect(missing.record.read().some((event) => event.t === "attempt")).toBe(false);

    const manual = await check({ type: "manual", instructions: "Open the application" });
    expect(manual.result).toMatchObject({ ok: false, kind: "manual", durationMs: 0 });
    expect(classifyCheck(manual.result)).toBeUndefined();
    expect(manual.record.read().some((event) => event.t === "attempt")).toBe(false);
  });

  test("repeated checks for one feature and attempt retain collision-free files", async () => {
    const s = setup();
    const first = await runCheck({ type: "shell", command: "printf first" }, { ...s.options, checkId: "first-id" });
    const second = await runCheck({ type: "shell", command: "printf second" }, { ...s.options, checkId: "second-id" });
    expect(first.outputPath).not.toBe(second.outputPath);
    expect(readFileSync(first.outputPath, "utf8")).toBe("first");
    expect(readFileSync(second.outputPath, "utf8")).toBe("second");
  });

  test("init checks record no feature id", async () => {
    const s = setup({ featureId: undefined, phase: "init", checkId: "init-id" });
    const result = await runCheck({ type: "shell", command: "exit 0" }, s.options);
    expect(result.outputPath).toContain("init-init-a1-init-id.txt");
    const event = s.record.read().find((item) => item.t === "check");
    expect(event && "featureId" in event).toBe(false);
  });

  test("rejects unsafe injected ids before writing evidence", async () => {
    const s = setup({ checkId: "../escape" });
    await expect(runCheck({ type: "shell", command: "exit 0" }, s.options)).rejects.toThrow(/invalid check id/);
    expect(existsSync(join(s.checksDir, "..", "escape"))).toBe(false);
  });
});
