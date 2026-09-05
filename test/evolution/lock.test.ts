import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEvolveLock,
  evolveLockPath,
  readEvolveLock,
  releaseEvolveLock,
} from "../../src/evolution/lock";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "kiln-evolve-lock-"));
}

function deadPid(): number {
  const result = spawnSync("/bin/echo", ["gone"]);
  const pid = result.pid ?? 0;
  try {
    process.kill(pid, 0);
    throw new Error(`pid ${pid} is unexpectedly alive`);
  } catch {
    return pid;
  }
}

async function waitForFiles(paths: readonly string[], timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return true;
    await Bun.sleep(2);
  }
  return paths.every((path) => existsSync(path));
}

async function contend(home: string, count = 6): Promise<{ ready: boolean; completed: boolean; results: string[]; childrenOk: boolean }> {
  const moduleUrl = new URL("../../src/evolution/lock.ts", import.meta.url).href;
  const barrier = join(home, "barrier");
  mkdirSync(barrier);
  const go = join(barrier, "go");
  const release = join(barrier, "release");
  const readyPaths = Array.from({ length: count }, (_, index) => join(barrier, `${index}.ready`));
  const resultPaths = Array.from({ length: count }, (_, index) => join(barrier, `${index}.result`));
  const children = Array.from({ length: count }, (_, index) => {
    const script = [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `const { acquireEvolveLock } = await import(${JSON.stringify(moduleUrl)});`,
      `writeFileSync(${JSON.stringify(readyPaths[index])}, "ready");`,
      `while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);`,
      `try {`,
      `  const lock = acquireEvolveLock(${JSON.stringify(home)});`,
      `  writeFileSync(${JSON.stringify(resultPaths[index])}, "won");`,
      `  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(1);`,
      `  lock.release();`,
      `} catch (error) {`,
      `  if (error?.name !== "EvolveLockedError") throw error;`,
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

describe("evolution lock", () => {
  test("targets evolution/evolve.lock and releases its unique acquisition", () => {
    const home = freshHome();
    const lock = acquireEvolveLock(home);
    expect(lock.path).toBe(join(home, "evolution", "evolve.lock"));
    expect(evolveLockPath(home)).toBe(lock.path);
    const stored = JSON.parse(readFileSync(lock.path, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ pid: process.pid, host: hostname(), owner: lock.info.owner });
    expect(Number.isNaN(Date.parse(String(stored.startedAt)))).toBe(false);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    lock.release();
  });

  test("refuses a live holder and a stale handle cannot release its force replacement", () => {
    const home = freshHome();
    const first = acquireEvolveLock(home);
    expect(() => acquireEvolveLock(home)).toThrow(new RegExp(String(process.pid)));
    expect(() => acquireEvolveLock(home)).toThrow(/--force/);
    const second = acquireEvolveLock(home, { force: true });
    expect(second.info.owner).not.toBe(first.info.owner);
    first.release();
    expect(readEvolveLock(home)?.owner).toBe(second.info.owner);
    second.release();
  });

  test("replaces dead and unreadable stale locks", () => {
    for (const content of [
      JSON.stringify({ pid: deadPid(), host: "old-host", startedAt: "2026-01-01T00:00:00.000Z", owner: "old" }),
      "{not json",
    ]) {
      const home = freshHome();
      const path = evolveLockPath(home);
      mkdirSync(join(home, "evolution"));
      writeFileSync(path, content);
      const lock = acquireEvolveLock(home);
      expect(readEvolveLock(home)?.owner).toBe(lock.info.owner);
      lock.release();
    }
  });

  test("release requires the exact owner token", () => {
    const home = freshHome();
    const lock = acquireEvolveLock(home);
    releaseEvolveLock(home, "another-owner");
    expect(existsSync(lock.path)).toBe(true);
    releaseEvolveLock(home, lock.info.owner);
    expect(existsSync(lock.path)).toBe(false);
  });

  test("a readiness barrier gives exactly one winner over absent and stale locks", async () => {
    for (const stale of [false, true]) {
      const home = freshHome();
      if (stale) {
        mkdirSync(join(home, "evolution"));
        writeFileSync(evolveLockPath(home), JSON.stringify({ pid: deadPid(), host: "old", startedAt: "2026-01-01T00:00:00.000Z", owner: "old" }));
      }
      const contention = await contend(home);
      expect(contention.ready).toBe(true);
      expect(contention.completed).toBe(true);
      expect(contention.childrenOk).toBe(true);
      expect(contention.results.filter((result) => result === "won")).toHaveLength(1);
      expect(contention.results.filter((result) => result === "locked")).toHaveLength(5);
      expect(existsSync(evolveLockPath(home))).toBe(false);
    }
  });

  test("a legacy owner-less live lock blocks but cannot be released as ours", () => {
    const home = freshHome();
    const path = evolveLockPath(home);
    mkdirSync(join(home, "evolution"));
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    expect(() => acquireEvolveLock(home)).toThrow();
    releaseEvolveLock(home, "missing");
    expect(existsSync(path)).toBe(true);
  });
});
