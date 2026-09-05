import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { createCliRuntime } from "../../src/cli/runtime";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { Limiter } from "../../src/core/limiter";
import { effortKey, writeEffortFile, type EffortEntry } from "../../src/evals/effort";
import { createRunExecutor } from "../../src/evals/executor";
import { effortFor } from "../../src/providers/models";
import { runFrame } from "../../src/phases/frame";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-runtime-effort-"));
  const model = createMockModel({ id: "brain", provider: "mock", responses: [{ content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["fixture lacks a problem"] } }] }] });
  Object.assign(model, { thinking: { efforts: ["low", "medium", "high"] } });
  const cfg = defaultConfig();
  const entry: EffortEntry = { winner: "low", sweptLevels: ["low", "medium", "high"], metric: "pairWinRate", quality: 0.5, usdPerSuccess: 1, n: 96, at: "2026-09-05T12:00:00.000Z", evalId: "measured" };
  writeEffortFile(home, { version: 1, entries: { [effortKey("brain", "mock/brain", "default")]: entry } });
  const deps = { models: { brain: model }, apiKeyFor: async () => "mock", streamFn: streamMock as never };
  return { home, model, cfg, deps };
}

test("an ordinary phase call consumes the measured winner without persisting runtime state", async () => {
  const { home, model, cfg, deps } = fixture();
  const configBefore = JSON.stringify(cfg); const effortPath = join(home, "evals", "effort.json"); const before = readFileSync(effortPath, "utf8");
  const runtime = await createCliRuntime(home, cfg, deps);
  expect(effortFor(cfg, "brain", model)).toBe("low");
  const run = createRun(home, "insufficient seed"); const record = new RunRecord(run.record);
  await runFrame({ home, cfg, run, record, models: runtime.models, apiKeyFor: runtime.apiKeyFor, streamFn: deps.streamFn, effort: cfg.effort, limiter: new Limiter(1) });
  expect(record.read().filter((event) => event.t === "model.call").map((event) => event.effortSent)).toEqual(["low"]);
  expect(JSON.stringify(cfg)).toBe(configBefore);
  expect(readFileSync(effortPath, "utf8")).toBe(before);
});

test("model and profile changes expire entries and missing files retain configured effort", async () => {
  const { home, model, cfg, deps } = fixture();
  await createCliRuntime(home, cfg, deps);
  expect(effortFor(cfg, "brain", { ...model, id: "different" })).toBe("high");
  await createCliRuntime(home, cfg, { ...deps, runtimeEffort: { profile: "frontier" } });
  expect(effortFor(cfg, "brain", model)).toBe("high");
  const clean = mkdtempSync(join(tmpdir(), "kiln-no-effort-"));
  await createCliRuntime(clean, cfg, deps);
  expect(effortFor(cfg, "brain", model)).toBe("high");
});

test("the staged executor retains its frozen explicit effort table", async () => {
  const { home, model, cfg, deps } = fixture();
  const staged = mkdtempSync(join(tmpdir(), "kiln-frozen-effort-")); saveConfig(staged, cfg);
  let observed: string | undefined;
  const executor = createRunExecutor(home, { ...deps, runFrame: async (d) => {
    observed = effortFor(d.cfg, "brain", model);
    return { outcome: "honest_exit", kind: "underspecified", reasons: ["fixture"] };
  } });
  await executor({ home: staged, seedText: "seed", seedIdentity: { id: "dev-product-01", split: "dev", sha256: "a".repeat(64) }, arm: "A0", through: "ideate", cloneAfter: "none", rounds: 1, runId: "frozen", effort: { brain: { level: "medium", source: "profile" } } });
  expect(observed).toBe("medium");
});
