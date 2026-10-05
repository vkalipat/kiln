/** Bounded FIFO workflow admission. Waiting owns no browser, fetch, or provider reservation. */
export class WorkflowSlots {
  #active = 0;
  #queue: { start: () => void; cancel: () => void }[] = [];
  constructor(readonly concurrency = 4, readonly queueLimit = 64) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32 || !Number.isSafeInteger(queueLimit) || queueLimit < 1 || queueLimit > 1024) throw new Error("Invalid workflow capacity");
  }
  get active() { return this.#active; }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length >= this.queueLimit) return Promise.reject(new Error(`Workflow queue is full (${this.queueLimit} waiting); await existing tasks`));
    return new Promise((resolve, reject) => {
      const item = { start: () => {
        signal.removeEventListener("abort", item.cancel);
        this.#active++; let released = false;
        resolve(() => { if (!released) { released = true; this.#active--; this.#drain(); } });
      }, cancel: () => {
        const index = this.#queue.indexOf(item);
        if (index < 0) return;
        this.#queue.splice(index, 1); signal.removeEventListener("abort", item.cancel); reject(signal.reason); this.#drain();
      } };
      signal.addEventListener("abort", item.cancel, { once: true }); this.#queue.push(item); this.#drain();
    });
  }
  #drain() { while (this.#active < this.concurrency && this.#queue.length) this.#queue.shift()!.start(); }
}
