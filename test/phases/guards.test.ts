import { describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { parseBrief, type PhaseDeps } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { assertShapeFrozen } from "../../src/phases/guards";

const brief = (shape: "product" | "research") => `# Brief

## Problem
p

## Constraints
- c

## Search success
- s

## Non-goals
- n

## Shape
${shape}

## Axes
- audience: a | b | c
- mechanism: x | y | z
- outcome: fast | safe | cheap

## Discovery questions
- q?
`;

function setup(): PhaseDeps {
  const home = mkdtempSync(join(tmpdir(), "kiln-guard-"));
  const run = createRun(home, "seed");
  const body = brief("product");
  writeFileSync(run.brief, body);
  const parsed = parseBrief(body);
  writeStatus(run, { shape: parsed.shape, shapeHash: shapeHash(parsed), phase: "discover" });
  return {
    home,
    run,
    record: new RunRecord(run.record),
    cfg: defaultConfig(),
    models: () => { throw new Error("not used"); },
    apiKeyFor: async () => undefined,
    effort: "medium",
    limiter: new Limiter(1),
  };
}

describe("assertShapeFrozen", () => {
  const cases = [
    { name: "matching brief", mutate: (_d: PhaseDeps) => {}, outcome: undefined },
    { name: "legacy status without a hash", mutate: (d: PhaseDeps) => writeStatus(d.run, { shape: undefined, shapeHash: undefined }), outcome: undefined },
    { name: "changed shape", mutate: (d: PhaseDeps) => writeFileSync(d.run.brief, brief("research")), outcome: "failed" },
    { name: "missing brief", mutate: (d: PhaseDeps) => unlinkSync(d.run.brief), outcome: "failed" },
  ] as const;

  for (const item of cases) {
    test(item.name, () => {
      const deps = setup();
      item.mutate(deps);
      expect(assertShapeFrozen(deps)?.outcome).toBe(item.outcome);
      if (item.outcome === "failed") {
        expect(readStatus(deps.run).state).toBe("failed");
        expect(deps.record.read().some((event) => event.t === "failure" && event.class === "integrity")).toBe(true);
      }
    });
  }
});
