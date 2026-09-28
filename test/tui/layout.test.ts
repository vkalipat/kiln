import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { renderAppLayout, renderWelcome } from "../../src/tui/layout";
import { PromptBox } from "../../src/tui/promptbox";
import { TranscriptView } from "../../src/tui/transcript";
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


const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("desktop welcome rotates actual wireframe geometry beside fixed wordmark", () => {
  const first = renderWelcome(80, 19, INITIAL_TUI_SNAPSHOT, 0).map(plain);
  const next = renderWelcome(80, 19, INITIAL_TUI_SNAPSHOT, 5).map(plain);
  expect(first.join("\n")).toContain("█████╔╝");
  expect(first.join("\n")).toMatch(/[\u2801-\u28ff]/);
  expect(first).not.toEqual(next);
  expect(first.findIndex(line => line.includes("Welcome"))).toBe(next.findIndex(line => line.includes("Welcome")));
  for (const frame of [0, 1, 8, 31, 93, 3599]) {
    const lines = renderWelcome(80, 19, INITIAL_TUI_SNAPSHOT, frame);
    expect(lines).toHaveLength(19);
    expect(lines.every(line => visibleWidth(line) === 80)).toBe(true);
  }
});

test("compact welcome keeps entry instructions visible without cropped large artwork", () => {
  const lines = renderWelcome(32, 5, INITIAL_TUI_SNAPSHOT, 12).map(plain);
  expect(lines).toHaveLength(5);
  expect(lines.join("\n")).toContain("K I L N");
  expect(lines.join("\n")).toContain("press Enter");
  expect(lines.join("\n")).toContain("Ctrl+O");
  expect(lines.every(line => visibleWidth(line) === 32)).toBe(true);
});


test("welcome animation is absent once conversation begins and does not move the draft", () => {
  const snapshot = { ...INITIAL_TUI_SNAPSHOT, transcript: [{ id: "reply", kind: "brain" as const, text: "Working on your feature." }] };
  const prompt = new PromptBox({ status: snapshot });
  prompt.setText("keep this draft");
  const transcript = new TranscriptView(snapshot.transcript);
  try {
    const input = { width: 80, height: 24, snapshot, prompt, transcript };
    const first = renderAppLayout({ ...input, frame: 0 });
    expect(renderAppLayout({ ...input, frame: 30 })).toEqual(first);
    expect(first.map(plain).join("\n")).toContain("keep this draft");
    expect(first.map(plain).join("\n")).not.toContain("Welcome to Kiln");
  } finally { prompt.dispose(); }
});
