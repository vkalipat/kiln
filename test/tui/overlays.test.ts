import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { CheckpointModal } from "../../src/tui/checkpoint";
import type { TuiCheckpointAnswer, TuiCheckpointSnapshot } from "../../src/tui/contracts";
import { EffortDial, fromConfigEffort, nextEffort, toConfigEffort } from "../../src/tui/dial";
import { ShortcutHelp, renderShortcutHelp } from "../../src/tui/help";
import { fitLine, renderRoundedOverlay } from "../../src/tui/overlay";
import { CommandPalette, PALETTE_COMMANDS, commandToArgv, filterPaletteCommands } from "../../src/tui/palette";

const WIDTHS = [20, 40, 80, 120] as const;

function expectWidthSafe(render: (width: number) => readonly string[]): void {
  for (const width of WIDTHS) {
    const lines = render(width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

const checkpoint: TuiCheckpointSnapshot = {
  round: 3,
  ideas: [
    { id: "kiln-a", title: "Local-first review", summary: "Review changes against durable run evidence." },
    { id: "kiln-b", title: "Paired evaluator" },
    { id: "kiln-c", title: "Budget governor" },
    { id: "kiln-d", title: "Context manifest" },
  ],
  groups: [["kiln-a", "kiln-b", "kiln-c", "kiln-d"]],
  groupIndex: 0,
  valueLadder: ["kiln-a", "kiln-c", "kiln-b", "kiln-d"],
  feasibilityLadder: ["kiln-d", "kiln-b", "kiln-a", "kiln-c"],
};

describe("rounded overlay", () => {
  test("frames and pads content without exceeding narrow terminals", () => {
    expect(fitLine("abcdef", 4)).toBe("abcd");
    expect(renderRoundedOverlay(["body"], 20, { title: "Title" })[0]).toStartWith("╭");
    expectWidthSafe((width) => renderRoundedOverlay(["a very long line ".repeat(20)], width, { title: "Long overlay title", footer: "Enter continue" }));
  });
});

describe("command palette", () => {
  test("contains every specified command with a CLI argv mapping", () => {
    expect(PALETTE_COMMANDS.map((command) => command.label)).toEqual([
      "run: new", "run: resume", "run: show record", "ideas: frontier", "ideas: pick",
      "ideas: another round", "project: form", "build: start", "build: pause", "evolve: eval",
      "evolve: promote", "evolve: rollback", "evals: calibrate", "auth: login anthropic",
      "auth: login openai", "auth: status", "auth: logout", "model: roles", "mode: toggle",
    ]);
    expect(commandToArgv("ideas: another round", ["run-7", "try local"])).toEqual(["ideas", "another", "run-7", "try local"]);
    expect(commandToArgv("run: show record", ["run-7"])).toEqual(["run", "record", "run-7"]);
    expect(commandToArgv("auth: login anthropic")).toEqual(["auth", "login", "anthropic"]);
    expect(PALETTE_COMMANDS.every((command) => command.argv.length > 0)).toBe(true);
  });

  test("fuzzy filters and selects through the pi-tui list", () => {
    expect(filterPaletteCommands("rol evo")[0]?.id).toBe("evolve: rollback");
    let selected = "";
    const palette = new CommandPalette({ onSelect: (command) => { selected = command.id; } });
    palette.setFilter("calibrate");
    palette.handleInput("\r");
    expect(selected).toBe("evals: calibrate");
    expectWidthSafe((width) => palette.render(width));
  });
});

describe("effort dial", () => {
  test("maps the display-only ultra name to xhigh config", () => {
    expect(toConfigEffort("ultra")).toBe("xhigh");
    expect(fromConfigEffort("xhigh")).toBe("ultra");
    expect(nextEffort("ultra")).toBe("low");
    expect(nextEffort("low", -1)).toBe("ultra");
  });

  test("cycles and commits the selected effort", () => {
    const selected: Array<[string, string]> = [];
    const dial = new EffortDial("high", { onSelect: (effort, config) => { selected.push([effort, config]); } });
    dial.handleInput("\x1b[C");
    dial.handleInput("\r");
    expect(dial.effort).toBe("ultra");
    expect(selected).toEqual([["ultra", "xhigh"]]);
    expectWidthSafe((width) => dial.render(width));
  });
});

describe("checkpoint modal", () => {
  test("collects distinct best and worst choices before opening decisions", () => {
    const answers: TuiCheckpointAnswer[] = [];
    const modal = new CheckpointModal(checkpoint, { onAnswer: (answer) => { answers.push(answer); } });
    modal.chooseCurrent();
    expect(modal.stage).toBe("worst");
    expect(modal.selectedIndex).toBe(1);
    modal.chooseCurrent();
    expect(answers[0]).toEqual({ kind: "bws", groupIndex: 0, best: "kiln-a", worst: "kiln-b" });
    expect(modal.stage).toBe("decision");
    modal.chooseCurrent();
    modal.chooseCurrent();
    expect(answers[1]).toEqual({ kind: "pick", id: "kiln-a" });
    expectWidthSafe((width) => modal.render(width));
  });

  test("captures steering for another round", () => {
    const answers: TuiCheckpointAnswer[] = [];
    const complete = { ...checkpoint, groupIndex: checkpoint.groups.length };
    const modal = new CheckpointModal(complete, { onAnswer: (answer) => { answers.push(answer); } });
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B");
    modal.handleInput("\r");
    for (const character of "test a cheaper probe") modal.handleInput(character);
    modal.handleInput("\r");
    expect(answers).toEqual([{ kind: "another_round", steering: "test a cheaper probe" }]);
  });

  test("renders both ranking ladders", () => {
    const plain = new CheckpointModal(checkpoint).render(80).join("\n");
    expect(plain).toContain("Value");
    expect(plain).toContain("Feasibility");
  });
});

describe("shortcut help", () => {
  test("uses one column when narrow and two when wide", () => {
    expect(renderShortcutHelp(30)).toHaveLength(8);
    expect(renderShortcutHelp(76)).toHaveLength(4);
    expectWidthSafe((width) => new ShortcutHelp().render(width));
  });
});
