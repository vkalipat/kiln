import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { renderWelcome } from "../../src/tui/layout";
import { INITIAL_TUI_SNAPSHOT } from "../../src/tui/controller-status";

test("welcome artwork changes with the shared animation frame without changing layout", () => {
  const first = renderWelcome(80, 18, INITIAL_TUI_SNAPSHOT, 0);
  const next = renderWelcome(80, 18, INITIAL_TUI_SNAPSHOT, 1);
  expect(first).not.toEqual(next);
  expect(first).toHaveLength(18);
  expect(next).toHaveLength(18);
  for (const line of [...first, ...next]) expect(visibleWidth(line)).toBe(80);
  expect(first.join("\n")).toContain("Welcome to Kiln");
});

test("welcome artwork is stable with a disabled clock and fits narrow terminals", () => {
  expect(renderWelcome(12, 4, INITIAL_TUI_SNAPSHOT, 0)).toEqual(renderWelcome(12, 4, INITIAL_TUI_SNAPSHOT, 0));
  for (const line of renderWelcome(12, 4, INITIAL_TUI_SNAPSHOT, 3)) expect(visibleWidth(line)).toBe(12);
});
