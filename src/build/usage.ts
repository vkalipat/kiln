import type { PhaseDeps } from "../phases/frame";
import { currentRunControl, throwIfRunCancelled } from "../core/run-control";

export interface UsagePause { reason: string; wakeAt: string }

export const USAGE_POLL_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol("usage poll timed out");
const CANCELLED = Symbol("usage poll cancelled");

async function boundedUsage(
  work: Promise<{ used: number; limit?: number; resetAt?: string } | undefined>,
  timeoutMs: number,
): Promise<{ used: number; limit?: number; resetAt?: string } | undefined> {
  const signal = currentRunControl()?.signal;
  throwIfRunCancelled(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, timeoutMs)); });
  const cancellation = new Promise<typeof CANCELLED>((resolve) => {
    if (!signal) return;
    onAbort = () => resolve(CANCELLED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([work, timeout, cancellation]);
    if (result === CANCELLED) { throwIfRunCancelled(signal); return undefined; }
    return result === TIMED_OUT ? undefined : result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function isUsageLimit(status: number | undefined, message: string | undefined): boolean {
  return status === 429 || /usage[-_ ]?limit|quota|rate[-_ ]?limit/i.test(message ?? "");
}

export async function pauseInfo(deps: PhaseDeps, provider: string, reactive: boolean, nowMs: number, timeoutMs = USAGE_POLL_TIMEOUT_MS): Promise<UsagePause | undefined> {
  const work = deps.fetchUsage?.(provider);
  const usage = work ? await boundedUsage(work, timeoutMs) : undefined;
  throwIfRunCancelled();
  if (!reactive && (!usage?.limit || usage.used / usage.limit < 0.95)) return undefined;
  return { reason: "usage_limit", wakeAt: usage?.resetAt ?? new Date(nowMs + 3_600_000).toISOString() };
}
