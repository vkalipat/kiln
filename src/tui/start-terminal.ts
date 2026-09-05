import type { Terminal } from "@oh-my-pi/pi-tui";

/** Preserve the complete pi-tui Terminal API while routing disconnect through app cleanup. */
export function observeTerminalDisconnect(terminal: Terminal, onDisconnect: () => void): Terminal {
  return new Proxy(terminal, {
    get(target, property) {
      if (property === "start") {
        return (
          onInput: Parameters<Terminal["start"]>[0],
          onResize: Parameters<Terminal["start"]>[1],
          _onDisconnect?: Parameters<Terminal["start"]>[2],
          options?: Parameters<Terminal["start"]>[3],
        ) => target.start(onInput, onResize, onDisconnect, options);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Terminal;
}
