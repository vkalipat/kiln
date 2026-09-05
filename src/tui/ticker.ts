export interface TickSource {
  readonly frame: number;
  readonly animations: boolean;
  subscribe(listener: () => void): () => void;
}

export interface TickerOptions {
  animations?: boolean;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

/** One shared cadence for every animated TUI component; consumers never create timers. */
export class TuiTicker implements TickSource {
  readonly animations: boolean;
  readonly intervalMs: number;
  #frame = 0;
  #listeners = new Set<() => void>();
  #timer?: ReturnType<typeof setInterval>;
  #setInterval: NonNullable<TickerOptions["setIntervalFn"]>;
  #clearInterval: NonNullable<TickerOptions["clearIntervalFn"]>;

  constructor(options: TickerOptions = {}) {
    this.animations = options.animations ?? process.env.NO_ANIMATION !== "1";
    this.intervalMs = options.intervalMs ?? 200;
    this.#setInterval = options.setIntervalFn ?? setInterval;
    this.#clearInterval = options.clearIntervalFn ?? clearInterval;
  }

  get frame(): number { return this.animations ? this.#frame : 0; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.animations && !this.#timer) this.#timer = this.#setInterval(() => this.advance(), this.intervalMs);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  }

  /** Deterministic seam used by virtual schedulers and tests. */
  advance(): void {
    if (!this.animations) return;
    this.#frame += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  dispose(): void {
    this.#listeners.clear();
    this.#stop();
  }

  #stop(): void {
    if (!this.#timer) return;
    this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export const STATIC_TICKER: TickSource = { frame: 0, animations: false, subscribe: () => () => {} };
