import { ProcessTerminal, TUI, type Terminal, type TUIOptions } from "@oh-my-pi/pi-tui";
import { KilnTuiApp } from "./app";
import type { TuiControllerPort } from "./contracts";
import { observeTerminalDisconnect } from "./start-terminal";
import { TuiTicker, type TickerOptions } from "./ticker";

export interface StartTuiOptions {
  readonly terminal?: Terminal;
  readonly runId?: string;
  readonly seed?: string;
  readonly animations?: boolean;
  readonly env?: { readonly NO_ANIMATION?: string };
  readonly tickerOptions?: Omit<TickerOptions, "animations">;
  readonly tuiOptions?: TUIOptions;
  /** Fullscreen overlays always use the software cursor; retained for embedding compatibility. */
  readonly showHardwareCursor?: boolean;
}

export interface TuiLifecycle {
  readonly app: KilnTuiApp;
  readonly tui: TUI;
  readonly terminal: Terminal;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

/** Launch the alternate-buffer app. Await `done`; `stop` is idempotent and persists cancellation. */
export function startTui(controller: TuiControllerPort, options: StartTuiOptions = {}): TuiLifecycle {
  const terminal = options.terminal ?? new ProcessTerminal();
  const animations = options.animations ?? (options.env?.NO_ANIMATION ?? process.env.NO_ANIMATION) !== "1";
  const ticker = new TuiTicker({ ...options.tickerOptions, animations });
  let disconnect = () => {};
  const tuiTerminal = observeTerminalDisconnect(terminal, () => disconnect());
  const tui = new TUI(tuiTerminal, false, options.tuiOptions);
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let app!: KilnTuiApp;
  let stopping: Promise<void> | undefined;
  let tickerOff: (() => void) | undefined;

  const finish = (error?: unknown, cancel = true): Promise<void> => {
    if (stopping) return stopping;
    app.beginShutdown();
    stopping = (async () => {
      let failure = error;
      try { tui.stop(); } catch (stopError) { failure ??= stopError; }
      try { app.dispose(); } catch (disposeError) { failure ??= disposeError; }
      tickerOff?.();
      ticker.dispose();
      if (cancel) {
        try { await app.cancelForShutdown(); } catch (cancelError) { failure ??= cancelError; }
      }
      if (failure === undefined) resolveDone();
      else rejectDone(failure);
    })();
    return stopping;
  };
  disconnect = () => { void finish(); };

  app = new KilnTuiApp({ controller, tui, terminal: tuiTerminal, ticker, onQuit: () => { void finish(); }, onFatal: (error) => { void finish(error); } });
  try {
    tui.start();
    if (!stopping) {
      tui.showOverlay(app, { anchor: "bottom-left", width: "100%", maxHeight: "100%", fullscreen: true, mouseTracking: false });
      app.mount();
      tui.addInputListener((data) => app.handleGlobalInput(data));
      tickerOff = ticker.subscribe(() => tui.requestComponentRender(app));
      tui.renderNow();
      if (options.runId) app.launch({ runId: options.runId });
      else if (options.seed) app.submit(options.seed);
    }
  } catch (error) {
    try { tui.stop(); } catch {}
    app.dispose();
    tickerOff?.();
    ticker.dispose();
    throw error;
  }

  return { app, tui, terminal, done, stop: () => finish() };
}

export const startKilnTui = startTui;
