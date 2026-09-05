import type { EditorTheme, MarkdownTheme, SelectListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";
import type { TuiEffort, TuiPhase, TuiToolStatus } from "./contracts";

type Style = (text: string) => string;
const sgr = (open: string): Style => (text) => `\x1b[${open}m${text}\x1b[0m`;

export const ansi = {
  bold: sgr("1"),
  dim: sgr("2"),
  italic: sgr("3"),
  underline: sgr("4"),
  black: sgr("30"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
  brightBlue: sgr("94"),
  selection: sgr("30;43"),
  rgb: (r: number, g: number, b: number): Style => sgr(`38;2;${r};${g};${b}`),
} as const;

export const PHASE_STYLE: Readonly<Record<TuiPhase, Style>> = {
  frame: ansi.rgb(255, 215, 0),
  discover: ansi.rgb(0, 205, 220),
  ideate: ansi.rgb(61, 255, 166),
  form: ansi.rgb(61, 212, 255),
  build: ansi.rgb(216, 179, 255),
  reflect: ansi.rgb(150, 150, 150),
};

export const EFFORT_STYLE: Readonly<Record<TuiEffort, Style>> = {
  low: ansi.rgb(255, 215, 0),
  medium: ansi.rgb(61, 255, 166),
  high: ansi.rgb(61, 212, 255),
  ultra: ansi.rgb(216, 179, 255),
};

export const TOOL_STYLE: Readonly<Record<TuiToolStatus, Style>> = {
  queued: ansi.yellow,
  running: ansi.blue,
  done: ansi.green,
  error: ansi.red,
  cancelled: ansi.yellow,
  blocked: ansi.yellow,
};

const sharp = {
  topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
  horizontal: "─", vertical: "│", teeDown: "┬", teeUp: "┴",
  teeLeft: "┤", teeRight: "├", cross: "┼",
};

export const KILN_SYMBOLS: SymbolTheme = {
  cursor: "▌",
  inputCursor: "▌",
  boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  boxSharp: sharp,
  table: sharp,
  quoteBorder: "│",
  hrChar: "─",
  spinnerFrames: ["⣯", "⣽", "⡿", "⢿", "⣻", "⣟", "⡯", "⣷"],
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: ansi.yellow,
  selectedText: ansi.selection,
  description: ansi.dim,
  scrollInfo: ansi.gray,
  noMatch: ansi.dim,
  symbols: KILN_SYMBOLS,
  icon: ansi.cyan,
  hovered: ansi.dim,
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => text,
  accentColor: ansi.blue,
  textColor: (text) => text,
  selectList: selectListTheme,
  symbols: KILN_SYMBOLS,
  editorPaddingX: 1,
  hintStyle: ansi.dim,
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => ansi.bold(ansi.blue(text)),
  link: (text) => ansi.underline(ansi.blue(text)),
  linkUrl: ansi.dim,
  code: (text) => ansi.bold(ansi.yellow(text)),
  codeBlock: (text) => text,
  codeBlockBorder: ansi.gray,
  quote: ansi.dim,
  quoteBorder: ansi.gray,
  hr: ansi.gray,
  listBullet: (text) => text,
  bold: ansi.bold,
  italic: ansi.italic,
  strikethrough: sgr("9"),
  underline: ansi.underline,
  symbols: KILN_SYMBOLS,
};

export const TOOL_GLYPHS: Readonly<Record<TuiToolStatus, string>> = {
  queued: "⣯", running: "⣯", done: "✓", error: "✗", cancelled: "⊘", blocked: "?",
};

export const WAVE_FRAMES = ["∼", "≈", "≋", "≈", "∼"] as const;
