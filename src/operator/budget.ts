/** FIFO admission shared by native SDK sessions and legacy ideation workers. */
export class OperatorBudgetError extends Error {
  constructor(message: string, readonly details?: { requestedUsd: number; availableUsd: number; chargedUsd: number; limitUsd: number }) {
    super(details ? `${message}: requested $${details.requestedUsd.toFixed(6)}, available $${details.availableUsd.toFixed(6)} (charged $${details.chargedUsd.toFixed(6)} of $${details.limitUsd.toFixed(6)})` : message);
    this.name = "OperatorBudgetError";
  }
}
export interface OperatorTicket { reservedUsd: number; settle(actualUsd?: number): number }
export class OperatorBudget {
  private active = new Map<number, number>();
  private next = 0;
  private queue: Array<{ amount: number; resolve: (ticket: OperatorTicket) => void; reject: (error: unknown) => void; cleanup: () => void }> = [];
  constructor(readonly limitUsd: number, private settledUsd = 0) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || !Number.isFinite(settledUsd) || settledUsd < 0) throw new OperatorBudgetError("Invalid operator budget");
  }
  get chargedUsd() { return this.settledUsd + [...this.active.values()].reduce((a, b) => a + b, 0); }
  get activeCount() { return this.active.size; }
  get queuedCount() { return this.queue.length; }
  chargeUnreserved(amount: number) {
    if (!Number.isFinite(amount) || amount < 0) throw new OperatorBudgetError("Invalid unreserved charge");
    this.settledUsd += amount; this.drain();
  }
  acquire(amount: number, signal?: AbortSignal): Promise<OperatorTicket> {
    if (!Number.isFinite(amount) || amount < 0) return Promise.reject(new OperatorBudgetError("Invalid operator reservation"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const item = { amount, resolve, reject, cleanup: () => {} };
      const abort = () => { const i = this.queue.indexOf(item); if (i < 0) return; this.queue.splice(i, 1); item.cleanup(); reject(signal?.reason); this.drain(); };
      item.cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true }); this.queue.push(item); this.drain();
    });
  }
  private drain() {
    while (this.queue.length) {
      const item = this.queue[0]!;
      if (this.chargedUsd + item.amount > this.limitUsd) {
        if (this.activeCount > 0) return;
        for (const queued of this.queue.splice(0)) {
          queued.cleanup(); queued.reject(new OperatorBudgetError("Operator estimated exposure budget exhausted", {
            requestedUsd: queued.amount, availableUsd: Math.max(0, this.limitUsd - this.chargedUsd), chargedUsd: this.chargedUsd, limitUsd: this.limitUsd,
          }));
        }
        return;
      }
      this.queue.shift(); item.cleanup(); const id = ++this.next; this.active.set(id, item.amount);
      let done = false;
      item.resolve({ reservedUsd: item.amount, settle: (actual) => {
        if (done) throw new Error("Operator reservation already settled"); done = true;
        const retained = actual !== undefined && Number.isFinite(actual) && actual >= 0 ? actual : item.amount;
        this.active.delete(id); this.settledUsd += retained; this.drain(); return retained;
      } });
    }
  }
}
