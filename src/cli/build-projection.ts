import { phaseAvailableUsd, spentByPhase } from "../core/budget";
import type { KilnConfig } from "../core/config";
import type { StoredEvent } from "../core/events";
import { derivedCaps } from "../formation/features";

export interface ProjectionRow { name: string; value: string }

/** Pure projected build-cost rows used by both text output and unit tests. */
export function buildProjectionRows(cfg: KilnConfig, events: readonly StoredEvent[]): ProjectionRow[] {
  const caps = derivedCaps(cfg);
  const projected = caps.maxFeatures * cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd;
  const available = phaseAvailableUsd(cfg.budgets, "build", spentByPhase(events));
  const usd = (value: number) => `$${value.toFixed(3)}`;
  return [
    { name: "features (derived max)", value: String(caps.maxFeatures) },
    { name: "expected attempts", value: String(cfg.build.expectedAttempts) },
    { name: "expected attempt usd", value: usd(cfg.build.expectedAttemptUsd) },
    { name: "attempt ceiling", value: usd(caps.attemptCeiling) },
    { name: "feature ceiling", value: usd(caps.featureCeilingBase) },
    { name: "projected build usd", value: usd(projected) },
    { name: "projected usd per success", value: usd(cfg.build.expectedAttempts * cfg.build.expectedAttemptUsd) },
    { name: "available build usd", value: usd(available) },
  ];
}
