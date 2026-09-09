import type { KilnConfig } from "../core/config";
import type { WorkflowPlan } from "./plan";

/** A supplied concept needs focused alternatives, not the full broad-search portfolio. */
export function applyWorkflowProfile(cfg: KilnConfig, plan: WorkflowPlan): KilnConfig {
  if (plan.strategy?.mode === "direct") {
    // A supplied implementation needs specification/critique capacity, not an unused tournament.
    const research = plan.strategy.research === "none" ? 0 : 0.15;
    return { ...cfg, budgets: { ...cfg.budgets, share: {
      frame: 0.05, discover: research, ideate: 0, form: 0.20, build: 0.70 - research, reflect: 0.05,
    } } };
  }
  if (plan.strategy?.mode !== "focused") return cfg;
  const islands = Math.min(cfg.ideation.islands, 2);
  const ideasPerBatch = Math.min(cfg.ideation.ideasPerBatch, 3);
  const capacity = islands * ideasPerBatch * 2;
  const entrantsCap = Math.min(cfg.ideation.entrantsCap, capacity);
  return { ...cfg, ideation: { ...cfg.ideation, islands, ideasPerBatch, entrantsCap,
    anchorsCap: Math.min(cfg.ideation.anchorsCap, entrantsCap),
    pairCap: Math.min(cfg.ideation.pairCap, Math.ceil(entrantsCap * cfg.ideation.minComparisons / 2)),
  } };
}
