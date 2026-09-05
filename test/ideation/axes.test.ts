import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { applyAxisMappings, recordedAxisMappings } from "../../src/ideation/axes";
import type { DerivedIdea } from "../../src/ideation/islands";
import type { PhaseDeps } from "../../src/phases/frame";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-axis-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const model = createMockModel({ id: "arbiter", responses: [{ content: [{ type: "toolCall", name: "axis_map", arguments: { value: "teams", reason: "closest" } }] }] as never });
  const deps = { home, run, record, cfg: defaultConfig(), models: () => ({ model: model as never, ref: "mock/arbiter" }), apiKeyFor: async () => "k", effort: "low", streamFn: streamMock as never, limiter: new Limiter(1) } as PhaseDeps;
  return { deps, record };
}

function idea(): DerivedIdea {
  return {
    dossier: { id: "r1-i1-1", title: "x", mechanism: "m", draws: "d", axisValues: { audience: "workgroups" }, testableClaim: "c", cheapestTest: "t", failureReason: "f", parents: [] },
    block: "raw", vsBound: true, mapped: [], unknown: [{ axis: "audience", value: "workgroups", allowed: ["solo", "teams", "enterprise"] }],
  };
}

describe("OOV axis mapping", () => {
  test("uses one arbiter call, records the mapping, and reuses it without another call", async () => {
    const { deps, record } = setup();
    const first = idea();
    expect(await applyAxisMappings(deps, [first], [], 1)).toMatchObject({ arbiterCalls: 1 });
    expect(first.dossier.axisValues.audience).toBe("teams");
    expect(recordedAxisMappings(record).size).toBe(1);
    const calls = record.read().filter((event) => event.t === "model.call").length;
    const replay = idea();
    expect(await applyAxisMappings(deps, [replay], [], 1)).toMatchObject({ arbiterCalls: 0 });
    expect(replay.dossier.axisValues.audience).toBe("teams");
    expect(record.read().filter((event) => event.t === "model.call").length).toBe(calls);
  });

  test("uses a recorded deterministic fallback once the cap is spent", async () => {
    const { deps, record } = setup();
    const candidate = idea();
    expect(await applyAxisMappings(deps, [candidate], [], 0)).toEqual({ arbiterCalls: 0, costUsd: 0 });
    expect(candidate.dossier.axisValues.audience).toBe("solo");
    expect([...recordedAxisMappings(record).values()][0]?.source).toBe("cap_fallback");
  });
});
