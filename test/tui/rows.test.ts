import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { TuiActivityEntry, TuiTournamentEntry } from "../../src/tui/contracts";
import { renderActivityGroup, renderToolRow, renderTournamentGroup } from "../../src/tui/rows";
import { ansi } from "../../src/tui/theme";

const WIDTHS = [20, 40, 80, 120] as const;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const bounded = (lines: readonly string[], width: number) => lines.every((line) => visibleWidth(line) <= width);

describe("tool and grouped rows", () => {
  test("tool rows keep unicode and ANSI output within every requested width", () => {
    for (const width of WIDTHS) {
      const lines = renderToolRow({
        id: "tool-1",
        status: "done",
        verb: "Edited",
        args: ansi.cyan("src/火🔥.ts +12 -4"),
        body: [ansi.green("const 火 = '🔥';"), "second line with a deliberately long explanation"],
        expanded: true,
      }, width);
      expect(bounded(lines, width)).toBe(true);
      expect(plain(lines[0]!)).toStartWith("✓ Edited");
      expect(plain(lines[1]!)).toStartWith("  const 火");
    }
  });

  test("all tool states have their specified glyph and running uses the injected frame", () => {
    const cases = [["done", "✓"], ["error", "✗"], ["cancelled", "⊘"], ["blocked", "?"]] as const;
    for (const [status, glyph] of cases) expect(plain(renderToolRow({ id: status, status, verb: "Run" }, 40)[0]!)).toBe(`${glyph} Run`);
    expect(plain(renderToolRow({ id: "r", status: "running", verb: "Run", frame: 0 }, 40)[0]!))
      .not.toBe(plain(renderToolRow({ id: "r", status: "running", verb: "Run", frame: 1 }, 40)[0]!));
  });

  test("activity groups reveal correlated child rows only when expanded", () => {
    const entry: TuiActivityEntry = {
      id: "scouts", kind: "activity", status: "running", label: "Scouting", detail: "3 agents",
      actions: [
        { id: "a", status: "done", verb: "Scout", args: "prior art" },
        { id: "b", status: "running", verb: "Scout", args: "market" },
      ],
    };
    const collapsed = renderActivityGroup(entry, 80);
    const expanded = renderActivityGroup({ ...entry, expanded: true }, 80);
    expect(collapsed).toHaveLength(1);
    expect(expanded).toHaveLength(3);
    expect(plain(expanded[1]!)).toStartWith("  ✓ Scout");
    expect(bounded(expanded, 80)).toBe(true);
  });

  test("tournament snapshots render a compact frontier table", () => {
    const entry: TuiTournamentEntry = {
      id: "round-2", kind: "tournament", judged: 12, ties: 2, expanded: true,
      frontier: [
        { id: "idea-α", value: 1.25, feasibility: 0.75, cell: "product" },
        { id: "idea-β", value: 0.5, feasibility: 1.1, cell: "research" },
      ],
    };
    expect(renderTournamentGroup(entry, 80).map((line) => plain(line).trimEnd())).toEqual([
      "✓ Judged 12 pairs, 2 ties ▾",
      "  id      value        feasible     cell",
      "  idea-α  1.25         0.75         product",
      "  idea-β  0.50         1.10         research",
    ]);
    for (const width of WIDTHS) expect(bounded(renderTournamentGroup(entry, width), width)).toBe(true);
  });
});
