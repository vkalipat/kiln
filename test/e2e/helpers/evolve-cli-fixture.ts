// Test-only preload: the executable stays unchanged and only paid vehicle boundaries are replaced.
import { mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as seedsModule from "../../../src/evals/seeds";
import { RealGitRunner } from "../../../src/build/git";
import { appendLine } from "../../../src/core/paths";
import { createRun, readStatus, writeStatus } from "../../../src/core/run";
import type { EvolveEvalDeps } from "../../../src/evolution/evolve";

const loadSeeds = seedsModule.loadSeeds;
mock.module(join(import.meta.dir, "../../../src/evals/seeds.ts"), () => ({ ...seedsModule, loadSeeds: (home: string, split?: "dev" | "heldout") => loadSeeds(home, split).slice(0, 1) }));
const mainModule = await import("../../../src/cli/main");
const runMain = mainModule.main;
mock.module(join(import.meta.dir, "../../../src/cli/main.ts"), () => ({ ...mainModule, main: async (argv: string[], io?: Parameters<typeof runMain>[1]) => {
  const { flags } = mainModule.parseArgs(argv); if (typeof flags.home !== "string") throw new Error("fixture requires an explicit temporary home");
  const home = flags.home; const calls = join(home, "evolution", "work", "fixture-calls.jsonl");
  const deps: EvolveEvalDeps = {
    git: new RealGitRunner(),
    models: (role) => ({ model: { id: role, provider: "fixture", thinking: { efforts: ["low", "medium", "high", "xhigh"] } } as never, ref: `fixture/${role}` }),
    arbiter: async () => ({ conflicts: false, against: null, reason: "fixture-compatible" }),
    archive: async (reason) => { throw new Error(`unexpected fixture archive ${reason}`); },
    executor: async (spec) => {
      appendLine(calls, JSON.stringify({ kind: "executor", id: spec.runId }));
      const run = createRun(spec.home, spec.seedText, { id: spec.runId });
      const shape = spec.seedIdentity.id.split("-")[1] as "product" | "research" | "creative";
      writeStatus(run, { state: "done", phase: "ideate", shape, seed: spec.seedIdentity, outcome: { kind: "success" } });
      return { runId: spec.runId, seedId: spec.seedIdentity.id, split: spec.seedIdentity.split, arm: spec.arm, shape, status: readStatus(run), outcome: { kind: "success" }, costUsd: 0, metrics: {} };
    },
    judge: async ({ evalDir, seed }) => {
      const path = join(evalDir, "judged.jsonl");
      const prior = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { seedId: string }) : [];
      if (!prior.some((line) => line.seedId === seed.id)) {
        appendLine(calls, JSON.stringify({ kind: "judge", id: seed.id }));
        for (let pair = 0; pair < 4; pair += 1) for (const order of ["ab", "ba"]) appendLine(path, JSON.stringify({ seedId: seed.id, pair, order, score: 0.5, source: "fixture" }));
      }
      return Array.from({ length: 4 }, () => ({ seedId: seed.id, score: 0.5 }));
    },
  };
  return runMain(argv, io, { evolve: { eval: deps } });
} }));
