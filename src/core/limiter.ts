/**
 * A FIFO concurrency gate shared by islands, scouts, probes and judge pairs.
 *
 * The slot, not the counter, is what a finishing task hands over: decrementing `running` and then
 * waking a waiter would let a caller arriving in between take the freed slot ahead of the queue and
 * push the real concurrency to N+1, since the woken waiter resumes on a later microtask. Passing the
 * slot straight to the head of the queue keeps both the cap and the call order exact.
 */
export class Limiter {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`limiter concurrency must be a positive integer, got ${concurrency}`);
    }
  }

  /** Tasks currently holding a slot. */
  get active(): number {
    return this.running;
  }

  /** Tasks waiting for a slot. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Run `fn` when a slot is free. NEVER call `run()` from inside another `run()` callback on the
   * same instance: the inner call waits for a slot the outer call holds, and the process hangs
   * silently. Orchestration code must run nested work (a scout inside an island, a probe inside a
   * judge call) outside the limiter or on a separate instance.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.running += 1;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
