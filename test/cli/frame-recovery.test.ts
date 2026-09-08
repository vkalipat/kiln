import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { acquireRunLock } from "../../src/core/lock";
import { recoverCompletedFrame } from "../../src/phases/frame-recovery";
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const brief = "## Problem\np\n## Constraints\n- c\n## Search success\n- s\n## Non-goals\n- n\n## Shape\nproduct\n## Axes\n- who: a | b | c\n## Discovery questions\n- q1\n- q2\n";
function fixture() {
  const h = mkdtempSync(join(tmpdir(), "kiln-frame-recover-")); homes.push(h); initHome(h);
  const run = createRun(h, "seed", { id: "recoverable" }); writeFileSync(run.brief, brief); writeFileSync(run.record, "");
  writeStatus(run, { state: "failed", outcome: { kind: "failure", failureClass: "budget", message: "turn cap 10 reached in frame" } });
  return { h, run };
}
test("offline recovery preserves the brief and advances only the historical frame-cap failure", async () => {
  const { h, run } = fixture(); const out: string[] = []; let calls = 0;
  expect(await main(["run", "recover-frame", run.id, "--home", h, "--json"], { write: (s) => out.push(s) }, { apiKeyFor: async () => { calls++; throw Error("no provider access allowed"); } })).toBe(0);
  expect(calls).toBe(0); expect(readFileSync(run.brief, "utf8")).toBe(brief);
  expect(readStatus(run)).toMatchObject({ state: "running", phase: "discover", shape: "product" });
  expect(readStatus(run).outcome).toBeUndefined(); expect(JSON.parse(out[0]!).providerCalls).toBe(0);
  expect(() => recoverCompletedFrame(run)).toThrow("only a frame turn-cap");
});
test("recovery refuses malformed artifacts, integrity failures, and active locks without changing status", () => {
  const { run } = fixture(); const before = readFileSync(run.status, "utf8");
  writeFileSync(run.brief, "incomplete"); expect(() => recoverCompletedFrame(run)).toThrow("fails validation");
  expect(readFileSync(run.status, "utf8")).toBe(before); writeFileSync(run.brief, brief);
  const lock = acquireRunLock(run); try { expect(() => recoverCompletedFrame(run)).toThrow(); } finally { lock.release(); }
  expect(readFileSync(run.status, "utf8")).toBe(before);
  writeStatus(run, { outcome: { kind: "failure", failureClass: "integrity", message: "turn cap 10 reached in frame" } });
  expect(() => recoverCompletedFrame(run)).toThrow("only a frame turn-cap");
});
