import { Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { TuiSnapshot } from "./contracts";
import { PromptBox } from "./promptbox";
import { ansi, EFFORT_STYLE } from "./theme";
import { TranscriptView } from "./transcript";

function fit(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), Ellipsis.Unicode);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function centered(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), Ellipsis.Unicode);
  const left = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
  return fit(" ".repeat(left) + clipped, width);
}

/** Empty-run takeover shown until the first seed is submitted. */
export function renderWelcome(width: number, height: number, snapshot: Readonly<TuiSnapshot>): readonly string[] {
  width = Math.max(0, Math.trunc(width));
  height = Math.max(0, Math.trunc(height));
  if (width === 0 || height === 0) return [];

  const accent = EFFORT_STYLE[snapshot.effort];
  const content = [
    accent("· : • ● • : ·"),
    ansi.bold("Welcome to Kiln"),
    "Shape an idea into a durable build.",
    "",
    "Type a seed and press Enter",
    `${accent(snapshot.effort)} · Ctrl+S effort · Ctrl+O commands · ? help`,
  ];
  const visible = content.slice(0, height);
  const before = Math.max(0, Math.floor((height - visible.length) / 2));
  const after = Math.max(0, height - before - visible.length);
  return [
    ...Array.from({ length: before }, () => " ".repeat(width)),
    ...visible.map((line) => centered(line, width)),
    ...Array.from({ length: after }, () => " ".repeat(width)),
  ];
}

export interface AppLayoutInput {
  readonly width: number;
  readonly height: number;
  readonly snapshot: Readonly<TuiSnapshot>;
  readonly transcript: TranscriptView;
  readonly prompt: PromptBox;
}

/** Pin the prompt to the bottom and give every remaining row to the transcript. */
export function renderAppLayout(input: AppLayoutInput): readonly string[] {
  const width = Math.max(0, Math.trunc(input.width));
  const height = Math.max(0, Math.trunc(input.height));
  if (width === 0 || height === 0) return [];

  const prompt = [...input.prompt.render(width)];
  const visiblePrompt = prompt.slice(Math.max(0, prompt.length - height));
  const transcriptHeight = Math.max(0, height - visiblePrompt.length);
  let upper: readonly string[];
  if (!input.snapshot.runId && input.snapshot.transcript.length === 0) {
    upper = renderWelcome(width, transcriptHeight, input.snapshot);
  } else if (transcriptHeight > 0) {
    input.transcript.setViewportHeight(transcriptHeight);
    const rendered = input.transcript.render(width);
    const padding = Math.max(0, transcriptHeight - rendered.length);
    upper = [...Array.from({ length: padding }, () => ""), ...rendered];
  } else {
    upper = [];
  }

  return [...upper, ...visiblePrompt].slice(-height)
    .map((line) => truncateToWidth(line, width, Ellipsis.Omit));
}
