import type {
  Terminal,
  TerminalAppearance,
  TerminalAppearanceRequestToken,
  TerminalStartOptions,
} from "@oh-my-pi/pi-tui";

export class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  readonly kittyEnableSequence = null;
  readonly keyboardEnhancementEnterSequence = null;
  readonly keyboardEnhancementExitSequence = null;
  readonly appearance: TerminalAppearance | undefined = undefined;
  readonly writes: string[] = [];
  readonly titles: string[] = [];
  readonly progress: boolean[] = [];
  startOptions?: TerminalStartOptions;
  starts = 0;
  stops = 0;
  disconnectOnStart = false;
  cursorHidden = false;
  #input?: (data: string) => void;
  #resize?: () => void;
  #disconnect?: () => void;

  constructor(columns = 80, rows = 24) { this.columns = columns; this.rows = rows; }

  start(
    onInput: (data: string) => void,
    onResize: () => void,
    onDisconnect?: () => void,
    options?: TerminalStartOptions,
  ): void {
    this.starts += 1;
    this.#input = onInput;
    this.#resize = onResize;
    this.#disconnect = onDisconnect;
    this.startOptions = options;
    if (this.disconnectOnStart) this.#disconnect?.();
  }

  enableInput(): void {}
  async drainInput(): Promise<void> {}
  stop(): void { this.stops += 1; this.#input = undefined; this.#resize = undefined; this.#disconnect = undefined; }
  write(data: string): void { this.writes.push(data); }
  moveBy(_lines: number): void {}
  hideCursor(_force?: boolean): void { this.cursorHidden = true; }
  showCursor(_force?: boolean): void { this.cursorHidden = false; }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(title: string): void { this.titles.push(title); }
  setProgress(active: boolean): void { this.progress.push(active); }
  onAppearanceChange(_callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void): void {}

  emitInput(data: string): void { this.#input?.(data); }
  resize(columns: number, rows: number): void { this.columns = columns; this.rows = rows; this.#resize?.(); }
  disconnect(): void { this.#disconnect?.(); }
}
