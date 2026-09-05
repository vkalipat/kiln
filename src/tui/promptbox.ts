import {
  Editor,
  Ellipsis,
  padding,
  registerComposerStyle,
  truncateToWidth,
  visibleWidth,
  type Component,
  type ComposerChromeContext,
  type ComposerRowContext,
  type ComposerStyle,
} from "@oh-my-pi/pi-tui";
import type { TuiEffort, TuiPhase, TuiRunState } from "./contracts";
import { renderShortcutHelp } from "./help";
import { ansi, editorTheme, PHASE_STYLE, WAVE_FRAMES } from "./theme";
import type { TickSource } from "./ticker";
import { STATIC_TICKER } from "./ticker";

export interface PromptBoxStatus {
  phase: TuiPhase;
  state: TuiRunState;
  costUsd: number;
  effort?: TuiEffort;
  activity?: string;
  directory: string;
  branch?: string;
}

export interface QueuedPrompt { text: string; steering?: boolean }
export interface PromptBoxOptions {
  status: PromptBoxStatus;
  ticker?: TickSource;
  maxBodyRows?: number;
}

let styleSequence = 0;
const border = (ctx: ComposerChromeContext, text: string) => ctx.borderColor(text);

function topBorder(ctx: ComposerChromeContext): string {
  const available = Math.max(0, ctx.width - 2);
  const content = ctx.topBorder ? truncateToWidth(ctx.topBorder.content, available, Ellipsis.Unicode) : "";
  const fill = Math.max(0, available - visibleWidth(content));
  return border(ctx, ctx.box.topLeft + ctx.box.horizontal.repeat(fill)) + content + border(ctx, ctx.box.topRight);
}

function row(ctx: ComposerRowContext): string[] {
  const inner = Math.max(0, ctx.width - 2);
  const content = truncateToWidth(padding(ctx.paddingX) + ctx.text, inner, "");
  const fill = Math.max(0, inner - visibleWidth(content));
  return [border(ctx, ctx.box.vertical) + content + padding(fill) + border(ctx, ctx.box.vertical)];
}

function createPromptStyle(id: string, bottomProvider: (ctx: ComposerChromeContext) => string): ComposerStyle {
  return {
    id,
    filledSurface: false,
    sideBorders: true,
    verticalChrome: 2,
    statusAttachment: "top-border",
    bottomBar: "none",
    bottomBarGap: false,
    defaultPromptGutter: undefined,
    defaultPaddingX: (requested) => Math.max(0, requested ?? 1),
    sideChromeWidth: (paddingX) => paddingX + 1,
    renderTop: topBorder,
    renderRow: row,
    renderBottom: bottomProvider,
  };
}

function fitLabels(left: string, right: string, available: number): { left: string; right: string; fill: number } {
  if (available <= 0) return { left: "", right: "", fill: 0 };
  let fittedLeft = truncateToWidth(left, available, Ellipsis.Unicode);
  let remaining = Math.max(0, available - visibleWidth(fittedLeft));
  let fittedRight = truncateToWidth(right, remaining, Ellipsis.Unicode);
  if (right && remaining < Math.min(8, visibleWidth(right))) {
    fittedRight = truncateToWidth(right, Math.min(available, Math.max(8, Math.floor(available / 2))), Ellipsis.Unicode);
    fittedLeft = truncateToWidth(left, Math.max(0, available - visibleWidth(fittedRight)), Ellipsis.Unicode);
  }
  return { left: fittedLeft, right: fittedRight, fill: Math.max(0, available - visibleWidth(fittedLeft) - visibleWidth(fittedRight)) };
}

export function renderPromptBottom(width: number, status: PromptBoxStatus, frame = 0): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  const active = status.activity ?? (status.state === "running" ? "Working" : status.state);
  const wave = WAVE_FRAMES[frame % WAVE_FRAMES.length]!;
  const left = active ? ` ${ansi.blue(wave)} ${active} ` : "";
  const location = `${status.directory}${status.branch ? ` (${status.branch})` : ""}`;
  const right = location ? ` ${location} ` : "";
  const fitted = fitLabels(left, right, width - 2);
  return `╰${fitted.left}${"─".repeat(fitted.fill)}${fitted.right}╯`;
}

export function renderPromptTop(width: number, status: PromptBoxStatus): { content: string; width: number } {
  const cost = ansi.dim(` $${status.costUsd.toFixed(2)} `);
  const phase = PHASE_STYLE[status.phase](` ${status.phase} `);
  const content = truncateToWidth(cost + phase, Math.max(0, width), Ellipsis.Unicode);
  return { content, width: visibleWidth(content) };
}

function queueLines(queue: readonly QueuedPrompt[], width: number): string[] {
  if (queue.length === 0 || width < 2) return [];
  const inner = width - 2;
  const lines = queue.map((item) => {
    const text = `${item.steering ? "steering: " : "queued: "}${item.text.replace(/\s+/g, " ").trim()}`;
    const content = truncateToWidth(` ${ansi.dim(text)} `, inner, Ellipsis.Unicode);
    return `│${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}│`;
  });
  return [`╭${"─".repeat(inner)}╮`, ...lines, `╰${"─".repeat(inner)}╯`];
}

/** Rounded three-row editor whose live run status is embedded in its borders. */
export class PromptBox implements Component {
  readonly editor: Editor;
  readonly ticker: TickSource;
  #status: PromptBoxStatus;
  #queue: readonly QueuedPrompt[] = [];
  #showHelp = false;
  #disposeStyle: () => void;

  constructor(options: PromptBoxOptions) {
    this.#status = options.status;
    this.ticker = options.ticker ?? STATIC_TICKER;
    const id = `kiln-prompt-${++styleSequence}`;
    const style = createPromptStyle(id, (ctx) => {
      const line = renderPromptBottom(ctx.width, this.#status, this.ticker.frame);
      return ctx.borderColor(line);
    });
    this.#disposeStyle = registerComposerStyle(style);
    this.editor = new Editor(editorTheme);
    this.editor.setBorderStyle(id);
    this.editor.setPaddingX(1);
    this.editor.setScrollbarVisible(true);
    this.editor.setMaxHeight(Math.max(5, (options.maxBodyRows ?? 8) + 2));
    this.editor.setTopBorderProvider((available) => renderPromptTop(available, this.#status));
  }

  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  get debugChildren(): readonly Component[] { return [this.editor]; }
  get onSubmit(): Editor["onSubmit"] { return this.editor.onSubmit; }
  set onSubmit(value: Editor["onSubmit"]) { this.editor.onSubmit = value; }

  setStatus(status: PromptBoxStatus): void { this.#status = status; }
  setQueue(queue: readonly QueuedPrompt[]): void { this.#queue = [...queue]; }
  setText(text: string): void { this.editor.setText(text); }
  getText(): string { return this.editor.getText(); }
  setMaxBodyRows(rows: number): void { this.editor.setMaxHeight(Math.max(5, Math.trunc(rows) + 2)); }
  toggleHelp(): boolean { this.#showHelp = !this.#showHelp; return this.#showHelp; }

  handleInput(data: string): void {
    if (data === "?" && this.editor.textEquals("")) { this.toggleHelp(); return; }
    this.editor.handleInput(data);
  }

  render(width: number): readonly string[] {
    width = Math.max(0, Math.trunc(width));
    if (width === 0) return [];
    const rendered = [...this.editor.render(width)];
    if (rendered.length >= 2) {
      const bodyRows = rendered.length - 2;
      const blank = width < 2 ? "" : `│${" ".repeat(width - 2)}│`;
      for (let count = bodyRows; count < 3; count += 1) rendered.splice(rendered.length - 1, 0, blank);
      if (this.#showHelp && width >= 4) {
        const inner = width - 4;
        const help = renderShortcutHelp(inner).map((line) => {
          const content = truncateToWidth(line, inner, Ellipsis.Unicode);
          return `│ ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))} │`;
        });
        rendered.splice(1, 0, ...help);
      }
    }
    return [...queueLines(this.#queue, width), ...rendered].map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void { this.editor.invalidate(); }
  dispose(): void { this.#disposeStyle(); }
}
