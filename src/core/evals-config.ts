import type { Role } from "./config";

export type EvalSection = "lenses" | "frame" | "discover" | "ideate" | "form" | "build";
export type EvalThrough = "ideate" | "build";
export type EvalCloneAfter = "none" | "checkpoint" | "freeze";

export interface EvalPhasePlan {
  through: EvalThrough;
  cloneAfter: EvalCloneAfter;
}

export interface EvalsConfig {
  wallSeconds: number;
  pairsPerSeed: number;
  sweepPairsPerSeed: number;
  minPairs: number;
  level: number;
  minUncensoredSeeds: number;
  noninferiorityMargin: number;
  costRatioCap: number;
  sectionPhases: Record<EvalSection, EvalPhasePlan>;
  rolePhases: Record<Role, EvalPhasePlan>;
  judgeGate: "calibrated" | "removed";
  labeller?: string[];
  runBudgetUsd?: number;
  runWallSeconds?: number;
  rounds?: number;
}

export function defaultEvals(): EvalsConfig {
  return {
    wallSeconds: 172800,
    pairsPerSeed: 4,
    sweepPairsPerSeed: 8,
    minPairs: 32,
    level: 0.95,
    minUncensoredSeeds: 8,
    noninferiorityMargin: 0.10,
    costRatioCap: 1.5,
    sectionPhases: {
      lenses: { through: "ideate", cloneAfter: "none" },
      frame: { through: "ideate", cloneAfter: "none" },
      discover: { through: "ideate", cloneAfter: "none" },
      ideate: { through: "ideate", cloneAfter: "none" },
      form: { through: "build", cloneAfter: "checkpoint" },
      build: { through: "build", cloneAfter: "freeze" },
    },
    rolePhases: {
      brain: { through: "ideate", cloneAfter: "none" },
      scout: { through: "ideate", cloneAfter: "none" },
      judge: { through: "ideate", cloneAfter: "none" },
      generator: { through: "ideate", cloneAfter: "none" },
      prober: { through: "ideate", cloneAfter: "none" },
      arbiter: { through: "ideate", cloneAfter: "none" },
      critic: { through: "build", cloneAfter: "checkpoint" },
      builder: { through: "build", cloneAfter: "freeze" },
      auditor: { through: "build", cloneAfter: "freeze" },
      reflector: { through: "build", cloneAfter: "freeze" },
    },
    judgeGate: "calibrated",
  };
}
