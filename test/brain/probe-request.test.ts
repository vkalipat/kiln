import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { probeRequestTool } from "../../src/brain/tools/probe-request";

test("probe requests preserve exact long assignments and reject oversized ones explicitly", async () => {
  const run = createRun(mkdtempSync(join(tmpdir(), "kiln-assignment-")), "seed"); const record = new RunRecord(run.record);
  let received = "";
  const tool = probeRequestTool({ cwd: run.dir, roots: [run.dir], run, record, onProbeRequest: (ideas) => { received = ideas[0]!.rationale; } });
  const rationale = "x".repeat(500) + " essential tail";
  expect((await tool.execute("one", { ideas: [{ ideaId: "id", rationale }] })).isError).not.toBe(true);
  expect(received).toBe(rationale);
  expect(record.read().find((event) => event.t === "probe.request")).toMatchObject({ ideas: [{ ideaId: "id", rationale }] });
  expect((await tool.execute("two", { ideas: [{ ideaId: "id", rationale: "x".repeat(8001) }] })).isError).toBe(true);
  expect(record.read().filter((event) => event.t === "probe.request")).toHaveLength(1);
});
