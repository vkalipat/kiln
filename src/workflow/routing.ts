import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PHASES, ROLES, type KilnConfig } from "../core/config";
import { writeAtomic } from "../core/paths";
import { readStatus, type RunPaths } from "../core/run";
import { parseModelRef } from "../providers/models";

export interface FrozenRouting {
  version: 1;
  seedSha256: string;
  roles: KilnConfig["roles"];
  effort: KilnConfig["effort"];
  effortByRole: KilnConfig["effortByRole"];
  share: KilnConfig["budgets"]["share"];
  rounds: number;
  strictDecisionTools: boolean;
  report: unknown;
}

export function routingPath(run: RunPaths): string { return join(run.dir, "routing.json"); }
function seedHash(run: RunPaths): string {
  return createHash("sha256").update(readFileSync(run.seed, "utf8")).digest("hex");
}

function validate(value: unknown, run: RunPaths): FrozenRouting {
  if (!value || typeof value !== "object") throw new Error("invalid frozen routing plan");
  const plan = value as FrozenRouting;
  if (plan.version !== 1 || plan.seedSha256 !== seedHash(run)) throw new Error("routing plan version or seed mismatch");
  for (const role of ROLES) {
    const refs = plan.roles?.[role];
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== "string")) throw new Error(`invalid routing role ${role}`);
    for (const ref of refs) parseModelRef(ref);
  }
  const efforts = [plan.effort, ...Object.values(plan.effortByRole ?? {})];
  if (efforts.some((effort) => !["low", "medium", "high", "xhigh"].includes(effort))) throw new Error("invalid frozen routing effort");
  if (!Number.isInteger(plan.rounds) || plan.rounds < 1) throw new Error("invalid frozen routing rounds");
  if (typeof plan.strictDecisionTools !== "boolean") throw new Error("invalid frozen routing decision-tool policy");
  if (PHASES.some((phase) => !Number.isFinite(plan.share?.[phase]) || plan.share[phase] < 0)
    || Math.abs(PHASES.reduce((sum, phase) => sum + plan.share[phase], 0) - 1) > 1e-9) throw new Error("invalid frozen routing budget shares");
  return plan;
}

export function loadFrozenRouting(run: RunPaths): FrozenRouting | undefined {
  return existsSync(routingPath(run)) ? validate(JSON.parse(readFileSync(routingPath(run), "utf8")), run) : undefined;
}

/** Only called under the run lock. A resume never replans silently. */
export function freezeRouting(run: RunPaths, cfg: KilnConfig, report: unknown): FrozenRouting {
  const plan: FrozenRouting = {
    version: 1, seedSha256: seedHash(run), roles: cfg.roles,
    effort: cfg.effort, effortByRole: cfg.effortByRole,
    share: cfg.budgets.share, rounds: cfg.ideation.rounds, strictDecisionTools: cfg.provider.strictDecisionTools, report,
  };
  validate(plan, run);
  const current = loadFrozenRouting(run);
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error("run routing is already frozen");
    return current;
  }
  writeAtomic(routingPath(run), JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

/** Preserve explicit total-budget/time increases and other controls while freezing model identity. */
export function applyFrozenRouting(cfg: KilnConfig, run: RunPaths): KilnConfig {
  const plan = loadFrozenRouting(run);
  if (!plan) {
    if (readStatus(run).routingRequired) throw new Error("adaptive routing plan is missing; setup was interrupted. Start a new run instead of silently changing its models.");
    return cfg;
  }
  return {
    ...cfg, routing: { mode: "adaptive" }, roles: plan.roles,
    effort: plan.effort, effortByRole: plan.effortByRole,
    provider: { ...cfg.provider, strictDecisionTools: plan.strictDecisionTools },
    seating: { ...cfg.seating, default: plan.roles },
    budgets: { ...cfg.budgets, share: plan.share },
    ideation: { ...cfg.ideation, rounds: plan.rounds },
  };
}
