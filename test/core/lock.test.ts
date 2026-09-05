import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, readRunLock, releaseRunLock } from "../../src/core/lock";
import { createRun } from "../../src/core/run";

function deadPid(): number {
  const r = spawnSync("/bin/echo", ["gone"]);
  const pid = r.pid ?? 0;
  try {
    process.kill(pid, 0);
    throw new Error(`pid ${pid} is somehow still alive`);
  } catch {
    return pid;
  }
}

function freshRun() {
  return createRun(mkdtempSync(join(tmpdir(), "kiln-")), "seed");
}

async function waitForFiles(paths: readonly string[], timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return true;
    await Bun.sleep(2);
  }
  return paths.every((path) => existsSync(path));
}

async function contend(lockPath: string, runId: string, count = 6): Promise<{ ready: boolean; completed: boolean; results: string[]; childrenOk: boolean }> {
  const moduleUrl = new URL("../../src/core/lock.ts", import.meta.url).href;
  const barrier = mkdtempSync(join(tmpdir(), "kiln-run-lock-barrier-"));
  const go = join(barrier, "go");
  const release = join(barrier, "release");
  const readyPaths = Array.from({ length: count }, (_, index) => join(barrier, `${index}.ready`));
  const resultPaths = Array.from({ length: count }, (_, index) => join(barrier, `${index}.result`));
  const children = Array.from({ length: count }, (_, index) => {
    const script = [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `const { acquireRunLock, RunLockedError } = await import(${JSON.stringify(moduleUrl)});`,
      `const paths = { id: ${JSON.stringify(runId)}, lock: ${JSON.stringify(lockPath)} };`,
      `writeFileSync(${JSON.stringify(readyPaths[index])}, "ready");`,
      `while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);`,
      `try {`,
      `  const lock = acquireRunLock(paths);`,
      `  writeFileSync(${JSON.stringify(resultPaths[index])}, "won");`,
      `  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(1);`,
      `  lock.release();`,
      `} catch (error) {`,
      `  if (!(error instanceof RunLockedError)) throw error;`,
      `  writeFileSync(${JSON.stringify(resultPaths[index])}, "locked");`,
      `}`,
    ].join("\n");
    return Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" });
  });

  const ready = await waitForFiles(readyPaths);
  writeFileSync(go, "go");
  const completed = await waitForFiles(resultPaths);
  writeFileSync(release, "release");
  const exits = await Promise.all(children.map(async (child) => {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr };
  }));
  return {
    ready,
    completed,
    results: resultPaths.filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8")),
    childrenOk: exits.every((result) => result.code === 0 && result.stderr === ""),
  };
}

describe("run lock", () => {
  test("acquire writes pid, host and start time; release removes the file", () => {
    const p = freshRun();
    const lock = acquireRunLock(p);
    expect(existsSync(p.lock)).toBe(true);
    const held = JSON.parse(readFileSync(p.lock, "utf8")) as { pid: number; host: string; startedAt: string };
    expect(held.pid).toBe(process.pid);
    expect(held.host).toBe(hostname());
    expect(Number.isNaN(Date.parse(held.startedAt))).toBe(false);
    lock.release();
    expect(existsSync(p.lock)).toBe(false);
    lock.release(); // idempotent
  });

  test("a second acquire fails and names the holding pid", () => {
    const p = freshRun();
    const lock = acquireRunLock(p);
    expect(() => acquireRunLock(p)).toThrow(new RegExp(String(process.pid)));
    expect(() => acquireRunLock(p)).toThrow(/--force/);
    expect(existsSync(p.lock)).toBe(true);
    lock.release();
  });

  test("a stale lock held by a dead pid is replaced", () => {
    const p = freshRun();
    writeFileSync(p.lock, JSON.stringify({ pid: deadPid(), host: "somewhere", startedAt: new Date().toISOString() }));
    const lock = acquireRunLock(p);
    expect(readRunLock(p)?.pid).toBe(process.pid);
    lock.release();
  });

  test("an unreadable lock file is treated as stale", () => {
    const p = freshRun();
    writeFileSync(p.lock, "{not json");
    const lock = acquireRunLock(p);
    expect(readRunLock(p)?.pid).toBe(process.pid);
    lock.release();
  });

  test("force overrides a live lock", () => {
    const p = freshRun();
    const first = acquireRunLock(p);
    const second = acquireRunLock(p, { force: true });
    expect(readRunLock(p)?.pid).toBe(process.pid);
    expect(second.info.token).not.toBe(first.info.token);
    first.release();
    expect(readRunLock(p)?.token).toBe(second.info.token);
    second.release();
    first.release();
  });

  test("a token-less release cannot remove a tokenized lock from the same pid", () => {
    const p = freshRun();
    const lock = acquireRunLock(p);
    releaseRunLock(p);
    expect(readRunLock(p)?.token).toBe(lock.info.token);
    lock.release();
  });

  test("a readiness barrier gives exactly one winner over absent and stale locks", async () => {
    for (const stale of [false, true]) {
      const p = freshRun();
      if (stale) writeFileSync(p.lock, JSON.stringify({ pid: deadPid(), host: "old", startedAt: "2026-01-01T00:00:00.000Z", token: "old" }));
      const contention = await contend(p.lock, p.id);
      expect(contention.ready).toBe(true);
      expect(contention.completed).toBe(true);
      expect(contention.childrenOk).toBe(true);
      expect(contention.results.filter((result) => result === "won")).toHaveLength(1);
      expect(contention.results.filter((result) => result === "locked")).toHaveLength(5);
      expect(existsSync(p.lock)).toBe(false);
    }
  });

  test("release does not remove a lock another process now holds", () => {
    const p = freshRun();
    const lock = acquireRunLock(p);
    writeFileSync(p.lock, JSON.stringify({ pid: deadPid(), host: "elsewhere", startedAt: new Date().toISOString() }));
    lock.release();
    expect(existsSync(p.lock)).toBe(true);
    releaseRunLock(p);
  });

  test("releaseRunLock is a no-op when nothing is locked", () => {
    const p = freshRun();
    expect(() => releaseRunLock(p)).not.toThrow();
  });
});
