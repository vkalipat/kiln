import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@oh-my-pi/pi-tui";
import type { TuiActivityEntry, TuiFrontierRow, TuiToolEntry, TuiToolStatus, TuiTournamentEntry } from "./contracts";
import { ansi, KILN_SYMBOLS, TOOL_GLYPHS, TOOL_STYLE } from "./theme";
import type { TickSource } from "./ticker";
import { STATIC_TICKER } from "./ticker";

export interface ToolRowOptions extends Omit<TuiToolEntry, "kind"> {
  frame?: number;
  indent?: number;
}

const bodyLines = (body: string | readonly string[] | undefined): string[] =>
  body === undefined ? [] : (typeof body === "string" ? body.split("\n") : [...body]);

function glyph(status: TuiToolStatus, frame: number): string {
  const raw = status === "running" || status === "queued"
    ? KILN_SYMBOLS.spinnerFrames[frame % KILN_SYMBOLS.spinnerFrames.length]!
    : TOOL_GLYPHS[status];
  return TOOL_STYLE[status](raw);
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), Ellipsis.Unicode);
}

function indentedBody(lines: readonly string[], width: number, status: TuiToolStatus, indent: number): string[] {
  if (lines.length === 0 || width <= indent) return [];
  const prefix = " ".repeat(indent);
  const color = status === "error" ? ansi.red : ansi.dim;
  return lines.flatMap((source) => wrapTextWithAnsi(source, Math.max(1, width - indent)))
    .map((line) => fit(prefix + color(line), width));
}

export function renderToolRow(options: ToolRowOptions, width: number): string[] {
  const indent = Math.max(0, options.indent ?? 0);
  const available = Math.max(0, width - indent);
  if (available === 0) return [];
  const hasBody = bodyLines(options.body).length > 0;
  const detail = options.args ? ` ${ansi.dim(options.args.replace(/\s+/g, " ").trim())}` : "";
  const toggle = hasBody ? ` ${ansi.dim(options.expanded ? "▾" : "▸")}` : "";
  const head = " ".repeat(indent) + fit(`${glyph(options.status, options.frame ?? 0)} ${options.verb}${detail}${toggle}`, available);
  if (!hasBody || !options.expanded) return [fit(head, width)];
  return [fit(head, width), ...indentedBody(bodyLines(options.body), width, options.status, indent + 2)];
}

export class ToolRow implements Component {
  #cache?: { key: string; lines: readonly string[] };
  constructor(public entry: TuiToolEntry, private readonly ticker: TickSource = STATIC_TICKER) {}
  render(width: number): readonly string[] {
    const key = `${width}\0${this.ticker.frame}\0${JSON.stringify(this.entry)}`;
    if (this.#cache?.key === key) return this.#cache.lines;
    const lines = renderToolRow({ ...this.entry, frame: this.ticker.frame }, width);
    this.#cache = { key, lines };
    return lines;
  }
  setExpanded(expanded: boolean): void { this.entry = { ...this.entry, expanded }; this.#cache = undefined; }
  invalidate(): void { this.#cache = undefined; }
}

export interface ActivityGroupOptions extends Omit<TuiActivityEntry, "kind"> { frame?: number }

export function renderActivityGroup(group: ActivityGroupOptions, width: number): string[] {
  const detail = group.detail ? ` ${ansi.dim(group.detail.replace(/\s+/g, " ").trim())}` : "";
  const head = fit(`${glyph(group.status, group.frame ?? 0)} ${group.label}${detail} ${ansi.dim(group.expanded ? "▾" : "▸")}`, width);
  if (!group.expanded) return [head];
  const children = group.actions.flatMap((action) => {
    const rows = renderToolRow({ ...action, frame: group.frame, indent: 2 }, width);
    return rows.length === 0 ? [] : rows;
  });
  return [head, ...children];
}

export class ActivityGroup implements Component {
  #cache?: { key: string; lines: readonly string[] };
  constructor(public entry: TuiActivityEntry, private readonly ticker: TickSource = STATIC_TICKER) {}
  render(width: number): readonly string[] {
    const key = `${width}\0${this.ticker.frame}\0${JSON.stringify(this.entry)}`;
    if (this.#cache?.key === key) return this.#cache.lines;
    const lines = renderActivityGroup({ ...this.entry, frame: this.ticker.frame }, width);
    this.#cache = { key, lines };
    return lines;
  }
  setExpanded(expanded: boolean): void { this.entry = { ...this.entry, expanded }; this.#cache = undefined; }
  invalidate(): void { this.#cache = undefined; }
}

function number(value: number | undefined): string { return value === undefined ? "—" : value.toFixed(2); }

export function renderFrontierTable(rows: readonly TuiFrontierRow[], width: number): string[] {
  if (width < 8) return rows.map((row) => fit(row.id, width));
  const idWidth = Math.min(Math.max(2, ...rows.map((row) => visibleWidth(row.id))), Math.max(2, width - 13));
  const scoreWidth = width >= 38 ? 11 : width >= 25 ? 7 : 5;
  const cellWidth = Math.max(0, width - idWidth - scoreWidth * 2 - 6);
  const columns = (id: string, value: string, feasibility: string, cell = "") => {
    const pad = (text: string, n: number) => {
      const clipped = fit(text, n);
      return clipped + " ".repeat(Math.max(0, n - visibleWidth(clipped)));
    };
    const base = `${pad(id, idWidth)}  ${pad(value, scoreWidth)}  ${pad(feasibility, scoreWidth)}`;
    return cellWidth > 0 ? `${base}  ${pad(cell, cellWidth)}` : base;
  };
  const header = columns("id", "value", "feasible", "cell");
  return [ansi.bold(fit(header, width)), ...rows.map((row) => fit(columns(row.id, number(row.value), number(row.feasibility), row.cell), width))];
}

export function renderTournamentGroup(group: Omit<TuiTournamentEntry, "kind" | "id">, width: number): string[] {
  const head = fit(`${ansi.green("✓")} Judged ${group.judged} pairs, ${group.ties} ties ${ansi.dim(group.expanded ? "▾" : "▸")}`, width);
  if (!group.expanded) return [head];
  return [head, ...renderFrontierTable(group.frontier, Math.max(0, width - 2)).map((line) => fit(`  ${line}`, width))];
}

export class TournamentGroup implements Component {
  #cache?: { key: string; lines: readonly string[] };
  constructor(public entry: TuiTournamentEntry) {}
  render(width: number): readonly string[] {
    const key = `${width}\0${JSON.stringify(this.entry)}`;
    if (this.#cache?.key === key) return this.#cache.lines;
    const lines = renderTournamentGroup(this.entry, width);
    this.#cache = { key, lines };
    return lines;
  }
  setExpanded(expanded: boolean): void { this.entry = { ...this.entry, expanded }; this.#cache = undefined; }
  invalidate(): void { this.#cache = undefined; }
}
