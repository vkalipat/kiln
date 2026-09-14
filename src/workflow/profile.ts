import type { KilnConfig } from "../core/config";
import type { WorkflowPlan } from "./plan";

/** One immutable candidate for adaptive, model-priced portfolio fitting. */
export interface PortfolioCandidate {
  config: KilnConfig;
  candidates: number;
  entrants: number;
  pairs: number;
}

/** A supplied concept needs focused alternatives, not the full broad-search portfolio. */
export function applyWorkflowProfile(cfg: KilnConfig, plan: WorkflowPlan): KilnConfig {
  if (plan.strategy?.mode === "direct") {
    // A supplied implementation needs specification/critique capacity, not an unused tournament.
    const research = plan.strategy.research === "none" ? 0 : 0.15;
    return { ...cfg, build: { ...cfg.build, minFeatures: 1 }, budgets: { ...cfg.budgets, share: {
      frame: 0.05, discover: research, ideate: 0, form: 0.20, build: 0.70 - research, reflect: 0.05,
    } } };
  }
  if (plan.strategy?.mode !== "focused" && plan.strategy?.mode !== "exploratory") return cfg;
  // Legacy shares budgeted only 4% to framing plus discovery, while execution borrowed
  // the whole run. Reserve a usable research stage and explicit downstream capacity.
  // These are planning allocations, not measured optimal ratios; the total stays fixed.
  const balanced = { ...cfg, budgets: { ...cfg.budgets, share: {
    frame: 0.05, discover: 0.15, ideate: 0.40, form: 0.075, build: 0.30, reflect: 0.025,
  } } };
  if (plan.strategy.mode === "exploratory") return balanced;
  const islands = Math.min(cfg.ideation.islands, 2);
  const ideasPerBatch = Math.min(cfg.ideation.ideasPerBatch, 3);
  const capacity = islands * ideasPerBatch * 2;
  const entrantsCap = Math.min(cfg.ideation.entrantsCap, capacity);
  return { ...balanced, ideation: { ...cfg.ideation, islands, ideasPerBatch, entrantsCap,
    anchorsCap: Math.min(cfg.ideation.anchorsCap, entrantsCap),
    pairCap: Math.min(cfg.ideation.pairCap, Math.ceil(entrantsCap * cfg.ideation.minComparisons / 2)),
  } };
}

/**
 * Largest-first breadth alternatives. Only adaptive planning calls this: historical/manual and
 * evaluator profiles keep their exact dimensions. Every retained idea still receives prior-art
 * and probe handling, every pair is judged in both orders, and pair capacity remains sufficient
 * for the configured minimum comparisons.
 */
export function adaptivePortfolioCandidates(cfg: KilnConfig): PortfolioCandidate[] {
  const out: PortfolioCandidate[] = [];
  const seen = new Set<string>();
  const minimumEntrants = cfg.ideation.minComparisons + 1;
  for (let islands = cfg.ideation.islands; islands >= 1; islands -= 1) {
    for (let ideasPerBatch = cfg.ideation.ideasPerBatch; ideasPerBatch >= 1; ideasPerBatch -= 1) {
      const candidates = islands * ideasPerBatch * 2;
      const entrants = Math.min(cfg.ideation.entrantsCap, candidates);
      if (entrants < minimumEntrants || cfg.ideation.minComparisons >= entrants) continue;
      const pairs = Math.ceil(entrants * cfg.ideation.minComparisons / 2);
      if (pairs > cfg.ideation.pairCap || pairs > entrants * (entrants - 1) / 2) continue;
      const key = `${islands}|${ideasPerBatch}|${entrants}|${pairs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        candidates,
        entrants,
        pairs,
        config: {
          ...cfg,
          ideation: {
            ...cfg.ideation,
            islands,
            ideasPerBatch,
            entrantsCap: entrants,
            anchorsCap: Math.min(cfg.ideation.anchorsCap, entrants),
            pairCap: pairs,
            arbiterCaps: {
              // A fresh batch with an unknown axis value fails validation before commit, so the
              // shared axis/novelty allowance can spend at most one novelty unit per candidate.
              novelty: Math.min(cfg.ideation.arbiterCaps.novelty, candidates),
              collision: Math.min(cfg.ideation.arbiterCaps.collision, candidates),
            },
            checkpointMax: Math.min(cfg.ideation.checkpointMax, entrants),
            checkpointMin: Math.min(cfg.ideation.checkpointMin, entrants),
          },
        },
      });
    }
  }
  return out.sort((a, b) => Number(b.config.ideation.islands > 1) - Number(a.config.ideation.islands > 1)
    || b.candidates - a.candidates
    || b.config.ideation.islands - a.config.ideation.islands
    || b.config.ideation.ideasPerBatch - a.config.ideation.ideasPerBatch);
}
