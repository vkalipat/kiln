import { PHASES, type Phase, type Role } from "../core/config";
import { foldCost, type CostBlock } from "../core/cost";
import type { StoredEvent } from "../core/events";

export type CostSource = "metrics" | "fallback";

function validBlock(value: unknown): value is CostBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  for (const key of ["usd", "tokens", "turns", "successes", "cacheWrite"]) if (typeof block[key] !== "number" || !Number.isFinite(block[key])) return false;
  for (const key of ["usdPerSuccess", "tokensPerSuccess", "turnsPerSuccess", "cacheReadRatio", "reasoningTokens"]) {
    if (block[key] !== null && (typeof block[key] !== "number" || !Number.isFinite(block[key]))) return false;
  }
  return true;
}

/** Consume the canonical metrics.json cost block without manufacturing missing phases. */
export function readCost(metrics: unknown): Partial<Record<Phase, CostBlock>> {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return {};
  const raw = (metrics as { cost?: unknown }).cost;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<Phase, CostBlock>> = {};
  for (const phase of PHASES) {
    const value = (raw as Record<string, unknown>)[phase];
    if (validBlock(value)) out[phase] = { ...value };
  }
  return out;
}

/** Temporary compatibility path; deliberately delegates to the canonical fold. */
export function foldCostFallback(events: readonly StoredEvent[], phase: Phase, successes: number): CostBlock {
  return foldCost(events, phase, successes);
}

export interface CacheHealth {
  cacheHealthy: boolean | null;
  unhealthyCallsByRole: Partial<Record<Role, number>>;
}

/** E2 cache health is observable only in sequential phases until calls carry session identity. */
export function cacheHealth(events: readonly StoredEvent[], phase: Phase): CacheHealth {
  if (phase === "discover" || phase === "ideate") return { cacheHealthy: null, unhealthyCallsByRole: {} };
  let current: Phase = "frame";
  const turns: Partial<Record<Role, number>> = {};
  const unhealthyCallsByRole: Partial<Record<Role, number>> = {};
  let eligible = 0;
  for (const event of events) {
    if (event.t === "phase.start") current = event.phase;
    if (current !== phase) continue;
    if (event.t === "turn") turns[event.role] = event.n;
    if (event.t !== "model.call" || (turns[event.role] ?? 1) <= 1) continue;
    eligible += 1;
    if (event.usage.cacheRead <= 0) unhealthyCallsByRole[event.role] = (unhealthyCallsByRole[event.role] ?? 0) + 1;
  }
  return { cacheHealthy: eligible === 0 || Object.keys(unhealthyCallsByRole).length === 0, unhealthyCallsByRole };
}
