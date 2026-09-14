import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { main, type CliDeps } from "../../src/cli/main";
import { readStatus, writeStatus } from "../../src/core/run";
import { freezeRouting, routingPath } from "../../src/workflow/routing";
import { setupLoop } from "../build/loop-fixture";

function fixture() {
  const s = setupLoop();
  freezeRouting(s.deps.run, s.deps.cfg, { offline: true });
  writeStatus(s.deps.run, { phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "verify", message: "interrupted before builder dispatch" } });
  let providerCalls = 0;
  const deps: CliDeps = {
    apiKeyFor: async () => "offline-key",
    streamFn: (() => { providerCalls++; throw new Error("unexpected provider dispatch"); }) as never,
    buildDeps: { git: s.git, runBuilder: s.deps.runBuilder,
      runCheck: s.deps.runCheck, runAuditor: s.deps.runAuditor, runSweep: s.deps.runSweep },
  };
  const resume = () => main(["run", "resume", s.deps.run.id, "--home", s.home, "--through", "build", "--json"], { write: () => {} }, deps);
  return { s, resume, calls: () => providerCalls };
}

test("explicit CLI failed-build resume uses native entry and preserves frozen artifacts", async () => {
  const { s, resume, calls } = fixture();
  const paths = [s.deps.run.acceptanceLock, s.deps.run.features, s.project.spec, routingPath(s.deps.run)];
  const before = paths.map((path) => readFileSync(path, "utf8"));
  expect(await resume()).toBe(0);
  expect(s.builderCalls).toEqual(["f01"]);
  expect(s.auditCalls).toEqual(["f01"]);
  expect(s.record.read().some((event) => event.t === "phase.end" && event.phase === "build" && event.outcome === "ok")).toBe(true);
  expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  expect(calls()).toBe(0);
});

test("native failed-build resume rejects tampered acceptance before dispatch and retains integrity refusal", async () => {
  const { s, resume, calls } = fixture();
  const changed = structuredClone(s.features);
  changed.features[0]!.acceptance = { type: "file", path: "weaker.txt" };
  writeFileSync(s.deps.run.features, JSON.stringify(changed));
  expect(await resume()).toBe(1);
  expect(readStatus(s.deps.run)).toMatchObject({ state: "failed", outcome: { failureClass: "integrity" } });
  expect(s.builderCalls).toEqual([]);
  expect(s.auditCalls).toEqual([]);
  expect(calls()).toBe(0);
  expect(await resume()).toBe(2);
});

test("failed-build recovery retains prior spend and stops at the existing budget guard", async () => {
  const { s, resume, calls } = fixture();
  const costUsd = s.deps.cfg.budgets.usd;
  s.record.append({ t: "phase.start", phase: "build" });
  s.record.append({ t: "model.call", role: "builder", provider: "mock", model: "builder", inputHash: "prior",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd, stopReason: "error", excerpt: "" });
  expect(await resume()).toBe(0);
  expect(readStatus(s.deps.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "budget" }, usdSpent: costUsd });
  expect(s.record.costUsd()).toBe(costUsd);
  expect(s.builderCalls).toEqual([]);
  expect(calls()).toBe(0);
});
