import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { TuiTranscriptEntry } from "../../src/tui/contracts";
import { TuiTicker } from "../../src/tui/ticker";
import { TranscriptView } from "../../src/tui/transcript";

const WIDTHS = [20, 40, 80, 120] as const;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

const entries: TuiTranscriptEntry[] = [
  { id: "u1", kind: "user", text: "Compare 火 kilns 🔥 without losing ANSI width." },
  { id: "b1", kind: "brain", text: "## Result\n\n- one `inline` value\n- two" },
  { id: "t1", kind: "tool", status: "done", verb: "Read", args: "src/火.ts", body: "body detail" },
  {
    id: "g1", kind: "activity", status: "done", label: "Scouted", actions: [
      { id: "s1", status: "done", verb: "Scout", args: "papers" },
      { id: "s2", status: "done", verb: "Scout", args: "products" },
    ],
  },
  { id: "think", kind: "thinking", text: "private chain" },
];

describe("TranscriptView", () => {
  test("renders and caches ANSI/unicode rows at 20/40/80/120", () => {
    const transcript = new TranscriptView(entries);
    for (const width of WIDTHS) {
      const first = transcript.render(width);
      const second = transcript.render(width);
      expect(second).toBe(first);
      expect(first.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(plain(transcript.render(80)[0]!)).toStartWith("▌▌ Compare 火");
  });

  test("ticker frames invalidate running rows without evicting a static transcript", () => {
    const ticker = new TuiTicker({ animations: true });
    const staticView = new TranscriptView(entries, { ticker });
    const staticFrame = staticView.render(80);
    ticker.advance();
    expect(staticView.render(80)).toBe(staticFrame);

    const runningView = new TranscriptView([{ id: "r", kind: "tool", status: "running", verb: "Probe" }], { ticker });
    const before = runningView.render(80);
    ticker.advance();
    const after = runningView.render(80);
    expect(after).not.toBe(before);
    expect(plain(after[0]!)).not.toBe(plain(before[0]!));
  });

  test("expansion is persistent per group and Alt+T-style toggle reveals thinking", () => {
    const transcript = new TranscriptView(entries);
    expect(transcript.render(80).map(plain).join("\n")).not.toContain("body detail");
    transcript.toggleExpanded("t1");
    expect(transcript.render(80).map(plain).join("\n")).toContain("body detail");
    transcript.toggleExpanded("t1");
    expect(transcript.render(80).map(plain).join("\n")).not.toContain("body detail");
    expect(transcript.toggleAll()).toBe(true);
    const expanded = transcript.render(80).map(plain).join("\n");
    expect(expanded).toContain("Scout papers");
    expect(expanded).toContain("private chain");
  });

  test("follow mode tracks appends while manual scrolling retains its position", () => {
    const transcript = new TranscriptView(entries, { height: 5 });
    transcript.render(40);
    expect(transcript.scrollState().follow).toBe(true);
    transcript.append({ id: "last", kind: "brain", text: "LATEST" });
    expect(transcript.render(40).map(plain).join("\n")).toContain("LATEST");

    transcript.scrollBy(-3);
    const before = transcript.render(40).map(plain).join("\n");
    const offset = transcript.scrollState().offset;
    expect(transcript.scrollState().follow).toBe(false);
    transcript.append({ id: "newer", kind: "brain", text: "NEWER" });
    const after = transcript.render(40).map(plain).join("\n");
    expect(transcript.scrollState().offset).toBe(offset);
    expect(after.split("\n").map((line) => line.slice(0, -1))).toEqual(before.split("\n").map((line) => line.slice(0, -1)));
    expect(after).not.toContain("NEWER");
    transcript.scrollToEnd();
    expect(transcript.render(40).map(plain).join("\n")).toContain("NEWER");
  });
});
