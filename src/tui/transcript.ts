import { Ellipsis, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@oh-my-pi/pi-tui";
import type { TuiTranscriptEntry } from "./contracts";
import { ActivityGroup, ToolRow, TournamentGroup } from "./rows";
import { ansi, markdownTheme } from "./theme";
import type { TickSource } from "./ticker";
import { STATIC_TICKER } from "./ticker";

interface CachedEntry {
  entry: TuiTranscriptEntry;
  expanded: boolean;
  showThinking: boolean;
  signature: string;
  width: number;
  frame: number;
  lines: readonly string[];
}
interface Layout {
  version: number;
  blocks: (readonly string[])[];
  offsets: number[];
  total: number;
}

export interface TranscriptOptions {
  height?: number;
  follow?: boolean;
  detailsExpanded?: boolean;
  ticker?: TickSource;
}

function entrySignature(entry: TuiTranscriptEntry, expanded: boolean, showThinking: boolean): string {
  return `${expanded ? 1 : 0}\0${showThinking ? 1 : 0}\0${JSON.stringify(entry)}`;
}

function entryFrame(entry: TuiTranscriptEntry, frame: number): number {
  if (entry.kind === "tool" && (entry.status === "running" || entry.status === "queued")) return frame;
  if (entry.kind === "activity" && (
    entry.status === "running" || entry.status === "queued" ||
    entry.actions.some((action) => action.status === "running" || action.status === "queued")
  )) return frame;
  return 0;
}

function wrapStyled(text: string, width: number, style: (value: string) => string, prefix = ""): string[] {
  const inner = Math.max(1, width - visibleWidth(prefix));
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(style(line), inner))
    .map((line) => truncateToWidth(prefix + line, width, Ellipsis.Unicode));
}

export function renderUserEntry(text: string, width: number, interrupted = false): string[] {
  if (width <= 0) return [];
  const suffix = interrupted ? ` ${ansi.yellow("(interrupted)")}` : "";
  return wrapStyled(text + suffix, width, (value) => ansi.italic(ansi.green(value)), ansi.green("▌▌") + " ");
}

/** Scrollable transcript with width-keyed entry caches and persistent expansion state. */
export class TranscriptView implements Component {
  #entries: readonly TuiTranscriptEntry[] = [];
  #entryCache = new Map<string, CachedEntry>();
  #byId = new Map<string, TuiTranscriptEntry>();
  #animated: number[] = [];
  #layouts = new Map<number, Layout>();
  #markdown = new Map<string, Markdown>();
  #expanded = new Map<string, boolean>();
  #height?: number;
  #follow: boolean;
  #showThinking: boolean;
  #scrollOffset = 0;
  #lastTotalRows = 0;
  #lastVisibleRows = 0;
  #version = 0;
  #renderCache?: { key: string; lines: readonly string[] };
  readonly ticker: TickSource;

  constructor(entries: readonly TuiTranscriptEntry[] = [], options: TranscriptOptions = {}) {
    this.#entries = entries;
    this.#indexEntries();
    this.#height = options.height;
    this.#follow = options.follow ?? true;
    this.#showThinking = options.detailsExpanded ?? false;
    this.ticker = options.ticker ?? STATIC_TICKER;
  }

  get entries(): readonly TuiTranscriptEntry[] { return this.#entries; }
  get follow(): boolean { return this.#follow; }

  setEntries(entries: readonly TuiTranscriptEntry[]): void {
    if (entries === this.#entries) return;
    this.#entries = entries;
    this.#indexEntries();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const [key, cached] of this.#entryCache) if (!ids.has(cached.entry.id)) this.#entryCache.delete(key);
    for (const id of this.#markdown.keys()) if (!ids.has(id)) this.#markdown.delete(id);
    for (const id of this.#expanded.keys()) if (!ids.has(id)) this.#expanded.delete(id);
    this.#invalidate();
  }

  append(entry: TuiTranscriptEntry): void { this.setEntries([...this.#entries, entry]); }

  setViewportHeight(height: number | undefined): void {
    const next = height === undefined ? undefined : Math.max(1, Math.trunc(height));
    if (next === this.#height) return;
    this.#height = next;
    this.#invalidate();
  }

  isExpanded(id: string): boolean {
    const entry = this.#byId.get(id);
    return this.#expanded.get(id) ?? Boolean(entry && "expanded" in entry && entry.expanded);
  }

  setExpanded(id: string, expanded: boolean): void {
    this.#expanded.set(id, expanded);
    for (const [key, cached] of this.#entryCache) if (cached.entry.id === id) this.#entryCache.delete(key);
    this.#invalidate();
  }

  toggleExpanded(id: string): boolean {
    const expanded = !this.isExpanded(id);
    this.setExpanded(id, expanded);
    return expanded;
  }

  setAllExpanded(expanded: boolean): void {
    for (const entry of this.#entries) {
      if (entry.kind === "tool" || entry.kind === "activity" || entry.kind === "tournament") this.#expanded.set(entry.id, expanded);
    }
    this.#showThinking = expanded;
    this.#entryCache.clear();
    this.#invalidate();
  }

  toggleAll(): boolean {
    const expandable = this.#entries.filter((entry) => entry.kind === "tool" || entry.kind === "activity" || entry.kind === "tournament");
    const expand = !this.#showThinking || expandable.some((entry) => !this.isExpanded(entry.id));
    this.setAllExpanded(expand);
    return expand;
  }

  scrollBy(delta: number): void {
    const max = Math.max(0, this.#lastTotalRows - this.#lastVisibleRows);
    const origin = this.#follow ? max : this.#scrollOffset;
    this.#scrollOffset = Math.max(0, Math.min(max, origin + Math.trunc(delta)));
    this.#follow = this.#scrollOffset >= max;
    this.#renderCache = undefined;
  }

  scrollToEnd(): void { this.#follow = true; this.#renderCache = undefined; }

  scrollState(): { offset: number; totalRows: number; visibleRows: number; follow: boolean } {
    return { offset: this.#scrollOffset, totalRows: this.#lastTotalRows, visibleRows: this.#lastVisibleRows, follow: this.#follow };
  }

  render(width: number): readonly string[] {
    width = Math.max(0, Math.trunc(width));
    if (width === 0) return [];
    const animatedFrame = this.#animated.length ? this.ticker.frame : 0;
    const key = `${width}\0${this.#height ?? "all"}\0${this.#version}\0${this.#scrollOffset}\0${this.#follow}\0${animatedFrame}`;
    if (this.#renderCache?.key === key) return this.#renderCache.lines;

    let contentWidth = width;
    let layout = this.#layout(contentWidth);
    const height = this.#height ?? layout.total;
    if (layout.total > height && width > 1) {
      contentWidth = width - 1;
      layout = this.#layout(contentWidth);
    }

    this.#lastTotalRows = layout.total;
    this.#lastVisibleRows = Math.min(height, layout.total);
    const maxOffset = Math.max(0, layout.total - height);
    if (this.#follow) this.#scrollOffset = maxOffset;
    else this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
    let lines = this.#visibleLines(layout, this.#scrollOffset, height);

    if (layout.total > height && width > 1) {
      const thumbSize = Math.max(1, Math.floor((height * height) / layout.total));
      const travel = Math.max(0, height - thumbSize);
      const thumbStart = maxOffset === 0 ? 0 : Math.round((this.#scrollOffset / maxOffset) * travel);
      lines = lines.map((line, index) => truncateToWidth(line, contentWidth, Ellipsis.Unicode) + ansi.gray(index >= thumbStart && index < thumbStart + thumbSize ? "█" : "▐"));
    }
    this.#renderCache = { key, lines };
    return lines;
  }

  invalidate(): void {
    this.#entryCache.clear();
    for (const markdown of this.#markdown.values()) markdown.invalidate();
    this.#invalidate();
  }

  #indexEntries(): void {
    this.#byId = new Map(this.#entries.map(entry => [entry.id, entry]));
    this.#animated = [];
    this.#entries.forEach((entry, index) => { if (entryFrame(entry, 1)) this.#animated.push(index); });
  }

  #layout(width: number): Layout {
    let layout = this.#layouts.get(width);
    if (!layout || layout.version !== this.#version) {
      layout = { version: this.#version, blocks: this.#entries.map(entry => this.#renderEntry(entry, width)), offsets: [], total: 0 };
      this.#offsets(layout);
      // Only the full width and scrollbar width need to remain hot.
      if (this.#layouts.size >= 2 && !this.#layouts.has(width)) {
        const retiredWidth = this.#layouts.keys().next().value!;
        this.#layouts.delete(retiredWidth);
        for (const [key, cached] of this.#entryCache) if (cached.width === retiredWidth) this.#entryCache.delete(key);
      }
      this.#layouts.set(width, layout);
    } else {
      let resized = false;
      for (const index of this.#animated) {
        const lines = this.#renderEntry(this.#entries[index]!, width);
        resized ||= lines.length !== layout.blocks[index]!.length;
        layout.blocks[index] = lines;
      }
      if (resized) this.#offsets(layout);
    }
    return layout;
  }

  #offsets(layout: Layout): void {
    let total = 0;
    layout.offsets = layout.blocks.map(lines => {
      if (lines.length && total) total++;
      const offset = total;
      total += lines.length;
      return offset;
    });
    layout.total = total;
  }

  #visibleLines(layout: Layout, start: number, height: number): string[] {
    let lo = 0, hi = layout.blocks.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (layout.offsets[mid]! + layout.blocks[mid]!.length <= start) lo = mid + 1; else hi = mid; }
    const lines: string[] = [], end = Math.min(layout.total, start + height);
    for (let index = lo; index < layout.blocks.length && lines.length < height; index++) {
      const block = layout.blocks[index]!, offset = layout.offsets[index]!;
      if (!block.length) continue;
      if (offset > start && offset - 1 < end) lines.push("");
      for (let row = Math.max(0, start - offset); row < block.length && offset + row < end; row++) lines.push(block[row]!);
    }
    return lines;
  }

  #renderEntry(entry: TuiTranscriptEntry, width: number): readonly string[] {
    const expanded = this.isExpanded(entry.id);
    const frame = entryFrame(entry, this.ticker.frame);
    const cacheKey = `${entry.id}\0${width}`;
    const cached = this.#entryCache.get(cacheKey);
    const signature = cached?.entry === entry && cached.expanded === expanded && cached.showThinking === this.#showThinking
      ? cached.signature : entrySignature(entry, expanded, this.#showThinking);
    if (cached?.signature === signature && cached.width === width && cached.frame === frame) return cached.lines;
    let lines: readonly string[];
    if (entry.kind === "user") lines = renderUserEntry(entry.text, width, entry.interrupted);
    else if (entry.kind === "brain") {
      let markdown = this.#markdown.get(entry.id);
      if (!markdown) {
        markdown = new Markdown(entry.text, 0, 0, markdownTheme, {}, 4);
        this.#markdown.set(entry.id, markdown);
      } else markdown.setText(entry.text);
      markdown.transientRenderCache = entry.streaming ?? false;
      lines = markdown.render(width);
    } else if (entry.kind === "thinking") {
      lines = this.#showThinking ? wrapStyled(entry.text, width, (value) => ansi.dim(ansi.italic(value))) : [];
    } else if (entry.kind === "tool") {
      lines = new ToolRow({ ...entry, expanded }, this.ticker).render(width);
    } else if (entry.kind === "activity") {
      lines = new ActivityGroup({ ...entry, expanded }, this.ticker).render(width);
    } else if (entry.kind === "tournament") {
      lines = new TournamentGroup({ ...entry, expanded }).render(width);
    } else {
      lines = [];
    }
    this.#entryCache.set(cacheKey, { entry, expanded, showThinking: this.#showThinking, signature, width, frame, lines });
    return lines;
  }

  #invalidate(): void { this.#version += 1; this.#renderCache = undefined; }
}
