import { existsSync, readFileSync } from "node:fs";
import type { RunRecord } from "../core/record";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import type { PhaseDeps } from "../phases/frame";
import type { Archive } from "./archive";

export interface PauseInfo { reason: string; wakeAt: string }

export function readJsonIfPresent<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export function usageFraction(usage: { used: number; limit?: number }): number {
  if (usage.limit && usage.limit > 0) return usage.used / usage.limit;
  return usage.used > 1 ? usage.used / 100 : usage.used;
}

/** Reactive usage-limit detection and the round-boundary 95% poll share one adapter. */
export async function pauseInfo(d: PhaseDeps, afterSeq?: number, boundary = false): Promise<PauseInfo | undefined> {
  const events = d.record.read();
  let provider: string | undefined;
  let reason = "usage window is at least 95% consumed";
  if (!boundary) {
    const hit = events.findLast((event) => event.seq > (afterSeq ?? 0) && event.t === "model.call" &&
      (event.errorStatus === 429 || /usage.?limit|rate.?limit/i.test(event.error ?? "")));
    if (!hit || hit.t !== "model.call") return undefined;
    provider = hit.provider;
    reason = hit.error ?? `provider ${hit.provider} returned ${hit.errorStatus ?? "a usage-limit error"}`;
  }
  if (!d.fetchUsage) {
    if (boundary) return undefined;
    return { reason, wakeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  }
  const providers = provider ? [provider] : [...new Set(["brain", "generator", "scout", "arbiter", "prober", "judge"].map((role) => String(d.models(role as Parameters<PhaseDeps["models"]>[0]).model.provider)))];
  for (const candidate of providers) {
    try {
      const usage = await d.fetchUsage(candidate);
      throwIfRunCancelled();
      if (!usage) continue;
      if (!boundary || usageFraction(usage) >= 0.95) return { reason, wakeAt: usage.resetAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    } catch (error) {
      rethrowIfRunCancelled(error);
      if (!boundary) return { reason, wakeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    }
  }
  return undefined;
}

export function searchHealth(archive: Archive, floor = 0.8): { searchHealth: number; noveltyEnforced: boolean } {
  const checked = archive.ids().flatMap((id) => archive.get(id)?.evidence.priorArt ? [archive.get(id)!.evidence.priorArt!] : []);
  const rate = checked.length === 0 ? 1 : checked.filter((item) => item.status !== "search_failed").length / checked.length;
  return { searchHealth: rate, noveltyEnforced: rate >= floor };
}

export function latestSteering(record: RunRecord): string | undefined {
  const event = record.read().findLast((item) => item.t === "checkpoint.decision" && item.kind === "another_round" && item.steering);
  return event?.t === "checkpoint.decision" ? event.steering : undefined;
}
