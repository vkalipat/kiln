import { expect, test } from "bun:test";
import { WorkflowSlots } from "../../src/operator/workflow-slots";

test("workflow overflow queues in order, cancellation removes waiting work and release is idempotent", async () => {
  const slots = new WorkflowSlots(1, 2), signal = new AbortController(), cancel = new AbortController();
  const release = await slots.acquire(signal.signal);
  const cancelled = slots.acquire(cancel.signal), waiting = slots.acquire(signal.signal);
  await expect(slots.acquire(signal.signal)).rejects.toThrow("queue is full");
  cancel.abort(new Error("cancel queued workflow")); await expect(cancelled).rejects.toThrow("cancel queued");
  expect(slots.active).toBe(1); release(); release();
  const finish = await waiting; expect(slots.active).toBe(1); finish(); expect(slots.active).toBe(0);
});
