import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { createRun, writeStatus } from "../../src/core/run";
import { acquireRunLock } from "../../src/core/lock";
import { requestOperatorSteering, watchOperatorSteering } from "../../src/operator/steering-mailbox";

test("native CLI steering preserves text, invokes no model and cannot cross an ownership generation", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-steering-")); initHome(home);
  const run = createRun(home, "Synthetic mailbox fixture");
  writeFileSync(join(run.dir, "operator.json"), JSON.stringify({ engine: "omp", version: 1 }));
  writeStatus(run, { state: "running" });
  let lock = acquireRunLock(run), close: (() => Promise<void>) | undefined;
  const delivered: string[] = [], failures: Error[] = [];
  try {
    close = watchOperatorSteering(run, async text => { delivered.push(text); }, error => failures.push(error), new AbortController().signal);
    const text = "  Preserve this direction.\n\nAnd this paragraph.\n", file = join(home, "steer.md"); writeFileSync(file, text);
    let output = "";
    const code = await main(["task", "steer", run.id, "--seed-file", file, "--home", home, "--json"], { write: value => { output += value; } },
      { createOperatorRuntime: async () => { throw new Error("No model may be launched by steering"); } });
    expect(code).toBe(0); expect(JSON.parse(output).status).toBe("queued");
    for (let i = 0; i < 20 && !delivered.length; i++) await Bun.sleep(20);
    expect(delivered).toEqual([text]); expect(failures).toHaveLength(0);
    await close();
    requestOperatorSteering(run, "Stale direction"); lock.release(); lock = acquireRunLock(run);
    close = watchOperatorSteering(run, async text => { delivered.push(text); }, error => failures.push(error), new AbortController().signal);
    requestOperatorSteering(run, "New direction");
    for (let i = 0; i < 20 && delivered.length < 2; i++) await Bun.sleep(20);
    expect(delivered).toEqual([text, "New direction"]);
    lock.release(); expect(() => requestOperatorSteering(run, "No owner")).toThrow("No active operator");
    writeFileSync(run.lock, JSON.stringify({ pid: 2147483647, host: hostname(), startedAt: new Date().toISOString() }));
    expect(() => requestOperatorSteering(run, "Crashed owner")).toThrow("No active operator");
    writeFileSync(run.lock, JSON.stringify({ pid: process.pid, host: "another-host", startedAt: new Date().toISOString() }));
    expect(() => requestOperatorSteering(run, "Unverifiable remote owner")).toThrow("No active operator");
  } finally { await close?.(); lock.release(); rmSync(home, { recursive: true, force: true }); }
});
