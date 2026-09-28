import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../../src/cli/main";
import { createRun } from "../../src/core/run";
import type { OperatorRuntimeOptions } from "../../src/operator/runtime";
import { acquireRunLock } from "../../src/core/lock";
import { requestRunPause } from "../../src/core/pause-request";

test("operator CLI preserves a file prompt and forwards per-task budgets without changing home configuration", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-task-cli-"));
  const path = join(home, "input.md"), seed = "  Research and ideate.\n\nKeep this exact.\n";
  writeFileSync(path, seed); const output: string[] = [];
  let observed: OperatorRuntimeOptions | undefined, prompted: string | undefined, disposed = false;
  const code = await main(["task", "--seed-file", path, "--home", home, "--cwd", home, "--budget", "25", "--wall-seconds", "1500", "--json"], { write: text => output.push(text) }, {
    createOperatorRuntime: async options => {
      observed = options; const run = createRun(home, seed);
      return { run, prompt: async text => { prompted = text; return { run, text: "done", stopped: "completed", costUsd: 0, taskQualityValidated: false }; },
        steer: async () => ({ status: "delivered", sourceIds: [] }), cancel: async () => {}, setEffort: async () => {}, dispose: async () => { disposed = true; } };
    },
  });
  expect(code).toBe(0); expect(prompted).toBe(seed);
  expect(observed).toMatchObject({ seed, budgetUsd: 25, wallSeconds: 1500, cwd: home });
  expect(disposed).toBe(true);
  expect(JSON.parse(output.join("")).taskQualityValidated).toBe(false);
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).budgets.wallSeconds).not.toBe(1500);
});

test("CLI local greeting and invalid limits cannot instantiate an operator or call a provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-task-local-")); let called = 0;
  const deps = { createOperatorRuntime: async (): Promise<never> => { called++; throw new Error("must not run"); } };
  const output: string[] = [];
  expect(await main(["task", "HI", "--home", home], { write: text => output.push(text) }, deps)).toBe(0);
  expect(await main(["task", "Build something", "--home", home, "--budget", "NaN"], { write: () => {} }, deps)).toBe(2);
  expect(await main(["task", "Build something", "--home", home, "--through", "reflect"], { write: () => {} }, deps)).toBe(2);
  expect(called).toBe(0); expect(readdirSync(join(home, "runs"))).toHaveLength(0);
});

test("operator CLI forwards cooperative pause and disposes before returning", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-task-pause-"));
  let disposed = false, aborted = false;
  const sigintBefore = process.listenerCount("SIGINT"), sigtermBefore = process.listenerCount("SIGTERM");
  const code = await main(["task", "Inspect this task", "--home", home], { write: () => {} }, {
    createOperatorRuntime: async options => {
      const run = createRun(home, options.seed!); const lock = acquireRunLock(run);
      options.onEvent?.({ type: "run", run });
      return { run, prompt: async () => {
        expect(requestRunPause(run)).toBe(true);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("operator did not receive pause")), 1500);
          options.signal!.addEventListener("abort", () => { aborted = true; clearTimeout(timeout); resolve(); }, { once: true });
        });
        return { run, text: "paused", stopped: "paused", costUsd: 0, taskQualityValidated: false };
      }, steer: async () => ({ status: "delivered", sourceIds: [] }), cancel: async () => {}, setEffort: async () => {},
      dispose: async () => { disposed = true; lock.release(); } };
    },
  });
  expect(code).toBe(0); expect(aborted).toBe(true); expect(disposed).toBe(true);
  expect(process.listenerCount("SIGINT")).toBe(sigintBefore); expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
});
