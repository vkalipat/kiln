import { Key, matchesKey, type Component } from "@oh-my-pi/pi-tui";
import { fitLine, renderRoundedOverlay } from "./overlay";
import { ansi } from "./theme";

export interface Shortcut {
  key: string;
  description: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: "Ctrl+O", description: "command palette" },
  { key: "Ctrl+S", description: "switch effort" },
  { key: "Alt+T", description: "expand/collapse details" },
  { key: "Esc", description: "cancel step; state is saved" },
  { key: "Enter", description: "submit" },
  { key: "Shift+Enter", description: "newline" },
  { key: "↑/↓", description: "navigate an overlay" },
  { key: "?", description: "toggle this help" },
] as const;

function renderShortcut(shortcut: Shortcut): string {
  return `${ansi.blue(shortcut.key.padEnd(12))}${ansi.dim(shortcut.description)}`;
}

export function shortcutHelpRows(width: number): readonly string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  if (safeWidth < 58) return SHORTCUTS.map(renderShortcut);
  const gap = 2;
  const columnWidth = Math.max(1, Math.floor((safeWidth - gap) / 2));
  const rows: string[] = [];
  for (let index = 0; index < SHORTCUTS.length; index += 2) {
    const left = fitLine(renderShortcut(SHORTCUTS[index]!), columnWidth);
    const right = SHORTCUTS[index + 1] ? renderShortcut(SHORTCUTS[index + 1]!) : "";
    rows.push(left + " ".repeat(gap) + right);
  }
  return rows;
}

/** Inline form used inside the prompt body (without the modal frame). */
export function renderShortcutHelp(width: number): readonly string[] {
  return shortcutHelpRows(width);
}

export interface ShortcutHelpOptions {
  onClose?: () => void;
}

export class ShortcutHelp implements Component {
  onClose?: () => void;

  constructor(options: ShortcutHelpOptions = {}) {
    this.onClose = options.onClose;
  }

  render(width: number): readonly string[] {
    const contentWidth = Math.max(1, Math.trunc(width) - 4);
    return renderRoundedOverlay(shortcutHelpRows(contentWidth), width, {
      title: "Keyboard shortcuts",
      footer: "? or Esc close",
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "?" || matchesKey(data, Key.question)) this.onClose?.();
  }
}

/** Name used by hosts that present the block as a modal overlay. */
export const HelpOverlay = ShortcutHelp;
