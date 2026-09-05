import type { PhaseDeps } from "../phases/frame";
import { throwIfRunCancelled } from "../core/run-control";

export interface UsagePause { reason: string; wakeAt: string }

export function isUsageLimit(status: number | undefined, message: string | undefined): boolean {
  return status === 429 || /usage[-_ ]?limit|quota|rate[-_ ]?limit/i.test(message ?? "");
}

export async function pauseInfo(deps: PhaseDeps, provider: string, reactive: boolean, nowMs: number): Promise<UsagePause | undefined> {
  const usage = await deps.fetchUsage?.(provider);
  throwIfRunCancelled();
  if (!reactive && (!usage?.limit || usage.used / usage.limit < 0.95)) return undefined;
  return { reason: "usage_limit", wakeAt: usage?.resetAt ?? new Date(nowMs + 3_600_000).toISOString() };
}
