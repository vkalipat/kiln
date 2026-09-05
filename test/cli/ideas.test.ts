import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { initHome } from "../../src/core/home";
import { acquireRunLock } from "../../src/core/lock";
import { RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { main } from "../../src/cli/main";
import type { FrontierFile } from "../../src/phases/ideate";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-ideas-cli-")); initHome(home);
  const run = createRun(home, "seed", { id: "run-1" }); const ids = ["r1-i1-1", "r1-i1-2"];
  const frontier: FrontierFile = {
    version: 1, mode: "loop", round: 1, rawFront: [...ids], shown: [...ids], eligible: [...ids],
    ideas: ids.map((id, index) => ({ id, backfill: false, cell: `c${index}`, value: { mean: 2 - index, lo: 1 - index, hi: 3 - index, n: 3 }, feasibility: { mean: index, lo: index - 1, hi: index + 1, n: 3 } })),
    ladders: { value: [...ids], feasibility: [...ids].reverse() }, searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true,
  };
  writeFileSync(run.frontier, `${JSON.stringify(frontier, null, 2)}\n`);
  writeStatus(run, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" }, shape: "product" });
  const out: string[] = []; const err: string[] = [];
  return { home, run, ids, out, err, io: { write: (text: string) => out.push(text), error: (text: string) => err.push(text) } };
}

describe("kiln ideas", () => {
  test("frontier prints both JSON and a table", async () => {
    const s = fixture();
    expect(await main(["ideas", "frontier", s.run.id, "--home", s.home, "--json"], s.io)).toBe(0);
    expect(JSON.parse(s.out.join("")).shown).toEqual(s.ids);
    s.out.length = 0;
    expect(await main(["ideas", "frontier", s.run.id, "--home", s.home], s.io)).toBe(0);
    expect(s.out.join("")).toContain("feasibility");
  });

  test("pick records the final id and advances to form", async () => {
    const s = fixture();
    expect(await main(["ideas", "pick", s.run.id, s.ids[1]!, "--home", s.home], s.io)).toBe(0);
    expect(readStatus(s.run)).toMatchObject({ chosenIdeaId: s.ids[1], phase: "form", state: "running" });
    expect(new RunRecord(s.run.record).read().findLast((event) => event.t === "checkpoint.decision")).toMatchObject({ kind: "pick", id: s.ids[1] });
  });

  test("reject removes the idea and another records steering for a new round", async () => {
    const rejected = fixture();
    expect(await main(["ideas", "reject", rejected.run.id, rejected.ids[0]!, "too", "broad", "--home", rejected.home], rejected.io)).toBe(0);
    expect(JSON.parse(readFileSync(rejected.run.frontier, "utf8")).shown).toEqual([rejected.ids[1]]);
    const another = fixture();
    expect(await main(["ideas", "another", another.run.id, "focus", "on", "teams", "--home", another.home], another.io)).toBe(0);
    expect(readStatus(another.run)).toMatchObject({ ideationRounds: 2, state: "running", cursor: { round: 2, step: "round.start" } });
  });

  test("unknown runs and invalid actions are usage errors", async () => {
    const s = fixture();
    expect(await main(["ideas", "frontier", "missing", "--home", s.home], s.io)).toBe(2);
    expect(await main(["ideas", "nope", s.run.id, "--home", s.home], s.io)).toBe(2);
  });

  test("a live lock refuses mutation unless force is explicit", async () => {
    const s = fixture(); const held = acquireRunLock(s.run);
    expect(await main(["ideas", "pick", s.run.id, s.ids[0]!, "--home", s.home], s.io)).toBe(2);
    expect(readStatus(s.run).chosenIdeaId).toBeUndefined();
    expect(await main(["ideas", "pick", s.run.id, s.ids[0]!, "--home", s.home, "--force"], s.io)).toBe(0);
    expect(readStatus(s.run).chosenIdeaId).toBe(s.ids[0]);
    held.release();
  });
});

describe("kiln judge pair", () => {
  test("judges two rendered files standalone in both orders", async () => {
    const s = fixture();
    for (const id of s.ids) writeFileSync(join(s.run.renderedDir, `${id}-r1.md`), `# ${id}\n\n## Mechanism\nmechanism\n`);
    writeFileSync(join(s.run.criteriaDir, "r1-test.md"), "Prefer concrete value.\n");
    const judge = createMockModel({ id: "judge", handler: () => ({ content: [{ type: "toolCall", name: "verdict", arguments: { valueWinner: "A", feasibilityWinner: "B", reason: "tradeoff" } }] }) } as never);
    const code = await main(["judge", "pair", s.run.id, s.ids[0]!, s.ids[1]!, "--home", s.home, "--json"], s.io, { streamFn: streamMock as never, models: { judge: judge as never }, apiKeyFor: async () => "k" });
    expect(code).toBe(0);
    expect(JSON.parse(s.out.join("")).map((line: { order: string }) => line.order).sort()).toEqual(["ab", "ba"]);
    expect(readdirSync(s.run.renderedDir)).toHaveLength(2);
  });
});
