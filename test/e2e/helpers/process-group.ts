import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForMarker(path: string, marker: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let contents = "";
  while (Date.now() < deadline) {
    contents = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (contents.split("\n").includes(marker)) return contents;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(marker)} in ${path}; held ${JSON.stringify(contents)}`);
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // A negative pid addresses the detached child's process group on POSIX.
  process.kill(-pid, signal);
}

export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForProcessGroupExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return;
    await delay(10);
  }
  throw new Error(`process group ${pid} survived for ${timeoutMs}ms`);
}

export function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
