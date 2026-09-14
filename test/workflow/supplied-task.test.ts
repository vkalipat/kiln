import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import type { PhaseDeps } from "../../src/phases/frame";
import { planWorkflow } from "../../src/workflow/plan";
import { prepareDeterministicDirectFrame } from "../../src/workflow/supplied-task";

function fixture() {
  const seed = "Build a dependency-free JSON formatter CLI.\n\n## Keep as data\n```text\nexact\n```\n";
  const home = mkdtempSync(join(tmpdir(), "kiln-direct-frame-"));
  const run = createRun(home, seed);
  const record = new RunRecord(run.record);
  const deps = { home, run, record, cfg: defaultConfig(), workflow: planWorkflow(readFileSync(run.seed, "utf8")) } as PhaseDeps;
  return { seed, run, record, deps };
}

test("deterministic direct framing is idempotent and never parses request headings as brief structure", () => {
  const { seed, run, record, deps } = fixture();
  prepareDeterministicDirectFrame(deps);
  const first = readFileSync(run.brief, "utf8");
  prepareDeterministicDirectFrame(deps);
  expect(readFileSync(run.seed, "utf8")).toBe(seed);
  expect(readFileSync(run.brief, "utf8")).toBe(first);
  expect(first).not.toContain("## Keep as data");
  expect(record.read().filter((event) => event.t === "phase.start" && event.phase === "frame")).toHaveLength(1);
  expect(record.read().filter((event) => event.t === "phase.end" && event.phase === "frame")).toHaveLength(1);

  writeFileSync(run.brief, "# historical or tampered model frame\n");
  expect(() => prepareDeterministicDirectFrame(deps)).toThrow("refusing to overwrite");
  expect(readFileSync(run.brief, "utf8")).toBe("# historical or tampered model frame\n");
});

test("an unmarked historical direct plan cannot enter deterministic framing", () => {
  const { run, deps } = fixture();
  deps.workflow = { ...deps.workflow!, directFrame: undefined };
  writeFileSync(run.brief, "# existing model frame\n");
  expect(() => prepareDeterministicDirectFrame(deps)).toThrow("frozen adaptive direct/no-research plan");
  expect(readFileSync(run.brief, "utf8")).toBe("# existing model frame\n");
});
