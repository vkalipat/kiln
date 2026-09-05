import { Key, matchesKey } from "@oh-my-pi/pi-tui";

export type AppInputAction = "quit" | "palette" | "effort" | "details" | "cancel" | "help"
  | "scroll-up" | "scroll-down" | "scroll-top" | "scroll-end";

export interface AppInputContext {
  readonly promptEmpty: boolean;
  readonly modalOpen: boolean;
}

/** Match only application-level keys; all other bytes continue to the focused pi-tui component. */
export function matchAppInput(data: string, context: AppInputContext): AppInputAction | undefined {
  if (matchesKey(data, Key.ctrl("c"))) return "quit";
  if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.alt("o"))) return "palette";
  if (matchesKey(data, Key.ctrl("s"))) return "effort";
  if (matchesKey(data, Key.alt("t"))) return "details";
  if (matchesKey(data, Key.escape) && !context.modalOpen) return "cancel";
  if (!context.modalOpen && context.promptEmpty && matchesKey(data, Key.pageUp)) return "scroll-up";
  if (!context.modalOpen && context.promptEmpty && matchesKey(data, Key.pageDown)) return "scroll-down";
  if (!context.modalOpen && context.promptEmpty && matchesKey(data, Key.home)) return "scroll-top";
  if (!context.modalOpen && context.promptEmpty && matchesKey(data, Key.end)) return "scroll-end";
  if (!context.modalOpen && context.promptEmpty && (data === "?" || matchesKey(data, Key.question))) return "help";
  if (!context.modalOpen && context.promptEmpty && (data === "/" || matchesKey(data, Key.slash))) return "palette";
  return undefined;
}
