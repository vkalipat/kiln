import type { Component, OverlayOptions } from "@oh-my-pi/pi-tui";
import { Ellipsis, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { KILN_SYMBOLS } from "./theme";

export interface RoundedOverlayOptions {
  title?: string;
  footer?: string;
  paddingX?: number;
  minBodyRows?: number;
}

export const CENTERED_OVERLAY: OverlayOptions = {
  anchor: "center",
  width: "80%",
  maxHeight: "80%",
  margin: 1,
};

function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ");
}

/** Truncate and right-pad a terminal line to exactly `width` visible cells. */
export function fitLine(text: string, width: number): string {
  const safeWidth = Math.max(0, Math.trunc(width));
  const clipped = truncateToWidth(oneLine(text), safeWidth, Ellipsis.Omit);
  return clipped + padding(Math.max(0, safeWidth - visibleWidth(clipped)));
}

function borderLine(
  left: string,
  right: string,
  horizontal: string,
  width: number,
  label: string,
  align: "left" | "right",
): string {
  if (width <= 0) return "";
  if (width === 1) return truncateToWidth(left, 1, Ellipsis.Omit);
  const interior = width - 2;
  if (interior <= 0) return truncateToWidth(left + right, width, Ellipsis.Omit);
  const decorated = label.trim() ? ` ${oneLine(label).trim()} ` : "";
  const fitted = truncateToWidth(decorated, interior, Ellipsis.Omit);
  const ruleWidth = Math.max(0, interior - visibleWidth(fitted));
  const middle = align === "left" ? fitted + horizontal.repeat(ruleWidth) : horizontal.repeat(ruleWidth) + fitted;
  return fitLine(left + middle + right, width);
}

/** Frame already-rendered rows in the shared rounded Kiln overlay treatment. */
export function renderRoundedOverlay(
  rows: readonly string[],
  width: number,
  options: RoundedOverlayOptions = {},
): readonly string[] {
  if (width <= 0) return [];
  const safeWidth = Math.max(1, Math.trunc(width));
  if (safeWidth < 4) return rows.length > 0 ? rows.map((line) => fitLine(line, safeWidth)) : [padding(safeWidth)];

  const chars = KILN_SYMBOLS.boxRound;
  const paddingX = Math.min(Math.max(0, Math.trunc(options.paddingX ?? 1)), Math.max(0, (safeWidth - 3) >> 1));
  const contentWidth = Math.max(1, safeWidth - 2 - paddingX * 2);
  const body = rows.length > 0 ? [...rows] : [""];
  while (body.length < (options.minBodyRows ?? 1)) body.push("");
  const horizontalPadding = padding(paddingX);
  const framed = body.map((line) => `${chars.vertical}${horizontalPadding}${fitLine(line, contentWidth)}${horizontalPadding}${chars.vertical}`);

  return [
    borderLine(chars.topLeft, chars.topRight, chars.horizontal, safeWidth, options.title ?? "", "left"),
    ...framed,
    borderLine(chars.bottomLeft, chars.bottomRight, chars.horizontal, safeWidth, options.footer ?? "", "right"),
  ];
}

/** A small Component adapter for modal content that needs a rounded border. */
export class RoundedOverlay implements Component {
  debugKind = "RoundedOverlay";

  constructor(
    readonly child: Component,
    readonly options: RoundedOverlayOptions | (() => RoundedOverlayOptions) = {},
  ) {}

  render(width: number): readonly string[] {
    const options = typeof this.options === "function" ? this.options() : this.options;
    const paddingX = Math.max(0, Math.trunc(options.paddingX ?? 1));
    const childWidth = Math.max(1, Math.trunc(width) - 2 - paddingX * 2);
    return renderRoundedOverlay(this.child.render(childWidth), width, options);
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  dispose(): void {
    this.child.dispose?.();
  }

  debugState(): Record<string, unknown> {
    const options = typeof this.options === "function" ? this.options() : this.options;
    return { title: options.title ?? null, footer: options.footer ?? null };
  }
}
