import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { deriveIdeas, formatRawIsland, parseRawIsland, rawIslandPath, writeRawIsland } from "../../src/ideation/island-raw";

const IDEA = `# Idea 1

## Title
Raw split

## Mechanism
move the durable raw-file layer out of orchestration

## Draws on
append-only logs

## Axes
- audience: SOLO

## Testable claim
the same bytes reconstruct the same id

## Cheapest test
round-trip this fixture

## Strongest failure reason
metadata could be lost

## Probability
5%
`;

describe("island raw-file boundary", () => {
  test("round-trips metadata, bytes, bounds, ids, and case mappings", () => {
    const raw = formatRawIsland(
      { round: 2, island: 3, ref: "mock/strong", operator: { id: "M4" } },
      [{ text: IDEA, bounded: true }],
    );
    expect(parseRawIsland(raw)).toMatchObject({ meta: { round: 2, island: 3, model: "mock/strong", operator: "M4" }, batches: [{ bounded: true }] });
    const [idea] = deriveIdeas(raw, 2, 3, [{ name: "audience", values: ["solo", "teams", "enterprise"] }]);
    expect(idea).toMatchObject({ dossier: { id: "r2-i3-1", axisValues: { audience: "solo" }, operator: "M4" }, vsBound: true });

    const home = mkdtempSync(join(tmpdir(), "kiln-island-raw-"));
    const run = createRun(home, "seed");
    expect(writeRawIsland(run, 2, 3, raw)).toBe(rawIslandPath(run, 2, 3));
    expect(readFileSync(rawIslandPath(run, 2, 3), "utf8")).toBe(raw);
  });
});
