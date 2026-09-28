import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { PromptBox } from "../../src/tui/promptbox";

const WIDTHS = [20, 40, 80, 120] as const;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("PromptBox", () => {
  test("operator route displays model, step and actual routed effort within terminal width", () => {
    for (const width of [12, 20, 40, 80, 120]) {
      const box = new PromptBox({ status: { mode: "operator", phase: "frame", state: "running", costUsd: 0.42, directory: "~/a",
        routing: { kind: "implement", modelRef: "provider/builder", effort: "xhigh" } } });
      const lines = box.render(width);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      if (width >= 80) {
        expect(plain(lines[0]!)).toContain("implement");
        expect(plain(lines[0]!)).toContain("provider/builder · xhigh");
      }
      box.dispose();
    }
  });

  test("operator submission preserves multiline edge whitespace while legacy submission stays trimmed", () => {
    const raw = "  first line\n    indented line\n\n";
    for (const mode of [undefined, "operator"] as const) {
      const box = new PromptBox({ status: { mode, phase: "frame", state: "idle", costUsd: 0, directory: "~/a" } });
      let submitted: string | undefined;
      box.onSubmit = (text) => { submitted = text; };
      box.setText(raw); box.handleInput("\r");
      expect(submitted).toBe(mode ? raw : raw.trim());
      box.dispose();
    }
  });
  test("operator mode changes only the phase text to work", () => {
    const box = new PromptBox({ status: { phase: "frame", mode: "operator", state: "idle", costUsd: 0, directory: "~/a" } });
    const lines = box.render(80).map(plain);
    expect(lines[0]).toContain("work");
    expect(lines[0]).not.toContain("frame");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toStartWith("╭"); expect(lines[0]).toEndWith("╮");
    box.dispose();
  });
  test("keeps top and bottom status on a rounded frame with three body rows", () => {
    for (const width of WIDTHS) {
      const box = new PromptBox({
        status: { phase: "build", state: "running", costUsd: 12.34, activity: "Running Tools", directory: "~/Documents/火-kiln", branch: "main" },
      });
      box.setText("ship 🔥");
      const lines = box.render(width);
      expect(lines).toHaveLength(5);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(plain(lines[0]!)).toStartWith("╭");
      expect(plain(lines[0]!)).toEndWith("╮");
      expect(plain(lines.at(-1)!)).toStartWith("╰");
      expect(plain(lines.at(-1)!)).toEndWith("╯");
      box.dispose();
    }
  });

  test("places cost and phase on top and activity and location on bottom", () => {
    const box = new PromptBox({
      status: { phase: "ideate", state: "running", costUsd: 0.42, activity: "Thinking", directory: "~/agents", branch: "main" },
    });
    const lines = box.render(80).map(plain);
    expect(lines[0]).toContain("$0.42");
    expect(lines[0]).toContain("ideate");
    expect(lines.at(-1)).toContain("∼ Thinking");
    expect(lines.at(-1)).toContain("~/agents (main)");
    box.dispose();
  });

  test("empty-question toggles inline help and queue rows remain width safe", () => {
    const box = new PromptBox({ status: { phase: "frame", state: "idle", costUsd: 0, directory: "~/a" } });
    box.setQueue([{ text: "steer toward ceramics 🔥", steering: true }]);
    box.handleInput("?");
    const shown = box.render(40);
    expect(shown.map(plain).join("\n")).toContain("command palette");
    expect(shown.map(plain).join("\n")).toContain("steering:");
    expect(shown.every((line) => visibleWidth(line) <= 40)).toBe(true);
    box.handleInput("?");
    expect(box.render(40).length).toBeLessThan(shown.length);
    box.dispose();
  });
});
