import { expect, test } from "bun:test";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { CONFLICT_SCHEMA, createConflictArbiter } from "../../src/evolution/conflict";

test("conflict is strict, terminal, and records its model call", async () => {
  expect(CONFLICT_SCHEMA.additionalProperties).toBe(false);
  expect((CONFLICT_SCHEMA.required as readonly string[]).slice().sort()).toEqual(Object.keys(CONFLICT_SCHEMA.properties).sort());
  const home = mkdtempSync(join(tmpdir(), "kiln-conflict-"));
  const record = new RunRecord(join(home, "record.jsonl"));
  const model = createMockModel({ responses: [{ content: [{ type: "toolCall", name: "conflict", arguments: { conflicts: false, against: null, reason: "Compatible guidance." } }] }] });
  const arbiter = createConflictArbiter({ home, cfg: defaultConfig(), runId: "operator-test", record, model, streamFn: streamMock as never, apiKeyFor: async () => "mock" });
  const input = { bullet: "Keep a narrow scope.", against: "Work one feature at a time.", againstId: null, kind: "role_prompt" as const };
  expect(await arbiter(input)).toEqual({ conflicts: false, against: null, reason: "Compatible guidance." });
  expect(await arbiter(input)).toEqual({ conflicts: false, against: null, reason: "Compatible guidance." });
  expect(model.calls).toHaveLength(1);
  expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(1);
  expect(record.read().filter((event) => event.t === "tool.call" && event.name === "conflict")).toHaveLength(1);
});

test("missing or invalid conflict decisions never authorize a mutation", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-conflict-"));
  const model = createMockModel({ responses: [{ content: ["I cannot decide."] }] });
  const arbiter = createConflictArbiter({ home, cfg: defaultConfig(), runId: "operator-test", record: new RunRecord(join(home, "record.jsonl")), model, streamFn: streamMock as never, apiKeyFor: async () => "mock" });
  await expect(arbiter({ bullet: "Keep a narrow scope.", against: "Work one feature at a time.", againstId: null, kind: "role_prompt" })).rejects.toMatchObject({ reason: "arbiter_invalid" });
});
