import { calculateContextTokens, shouldCompact, type CompactionSettings } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";

/**
 * Tokens of recent transcript a compaction must keep. The library requires the field; kiln never
 * runs the library's compaction, so the value only has to be a coherent budget for the tail a
 * rebuilt round would need.
 */
export const KEEP_RECENT_TOKENS = 8000;

/** Record §3: compaction is considered at 70 percent of the window, not at overflow. */
export const CONTEXT_THRESHOLD_PERCENT = 70;

export interface ContextPressureOptions {
  thresholdPercent?: number;
  keepRecentTokens?: number;
}

/** `CompactionSettings` with the two required fields filled in; `enabled` is what arms `shouldCompact`. */
export function compactionSettings(o: ContextPressureOptions = {}): CompactionSettings {
  return {
    enabled: true,
    thresholdPercent: o.thresholdPercent ?? CONTEXT_THRESHOLD_PERCENT,
    keepRecentTokens: o.keepRecentTokens ?? KEEP_RECENT_TOKENS,
  };
}

/**
 * Whether this call's usage says the model's context is filling up.
 *
 * `undefined` means the question cannot be asked: a catalog entry with a null `contextWindow` gives
 * the threshold nothing to be a percentage of, so the caller records that once and stops checking
 * rather than guessing a window and compacting a run that never needed it.
 */
export function contextPressure(model: Model, usage: Usage, o: ContextPressureOptions = {}): boolean | undefined {
  const window = model.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
  return shouldCompact(calculateContextTokens(usage), window, compactionSettings(o));
}
