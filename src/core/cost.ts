import type { Phase } from "./config";
import type { StoredEvent } from "./events";

/** Comparable cost per observed success; zero successes have no finite unit cost. */
export interface CostBlock {
  usd: number;
  tokens: number;
  turns: number;
  successes: number;
  usdPerSuccess: number | null;
  tokensPerSuccess: number | null;
  turnsPerSuccess: number | null;
  cacheReadRatio: number | null;
  cacheWrite: number;
  reasoningTokens: number | null;
}

/** Sum recorded usage without treating cache tokens as additional model calls. */
export function foldCost(events: readonly StoredEvent[], phase: Phase, successes: number): CostBlock {
  if (!Number.isSafeInteger(successes) || successes < 0) throw new Error("successes must be a non-negative safe integer");
  let current: Phase = "frame";
  let usd = 0, tokens = 0, turns = 0, input = 0, cacheRead = 0, cacheWrite = 0;
  let reasoningTokens: number | null = null;
  for (const event of events) {
    if (event.t === "phase.start") current = event.phase;
    if (event.t === "turn" && event.phase === phase) turns += 1;
    if (event.t !== "model.call" || current !== phase) continue;
    usd += event.costUsd;
    input += event.usage.input;
    cacheRead += event.usage.cacheRead;
    cacheWrite += event.usage.cacheWrite;
    tokens += event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
    const reasoning = (event as typeof event & { reasoningTokens?: number }).reasoningTokens;
    if (reasoning !== undefined) reasoningTokens = (reasoningTokens ?? 0) + reasoning;
  }
  const unit = (total: number) => successes > 0 ? total / successes : null;
  const denominator = input + cacheRead + cacheWrite;
  return { usd, tokens, turns, successes, usdPerSuccess: unit(usd), tokensPerSuccess: unit(tokens),
    turnsPerSuccess: unit(turns), cacheReadRatio: denominator > 0 ? cacheRead / denominator : null,
    cacheWrite, reasoningTokens };
}

/** Novelty/collision removals remove an id once; lost-cell ideas still survive in the archive. */
export function survivingIdeaCount(events: readonly StoredEvent[]): number {
  const ids = new Set<string>();
  const rejected = new Set<string>();
  for (const event of events) {
    if (event.t === "idea.insert") ids.add(event.id);
    if (event.t === "idea.reject" && (event.reason === "restatement" || event.reason === "collided")) rejected.add(event.id);
  }
  return [...ids].filter((id) => !rejected.has(id)).length;
}
