import type { KilnConfig } from "../core/config";

/** Environment overrides are invocation-local; the selected policy is frozen per run. */
export function resolveJevSettings(cfg: KilnConfig, env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: env.KILN_JEV_ENABLED !== "0",
    workflows: env.KILN_JEV_WORKFLOWS !== undefined
      ? env.KILN_JEV_WORKFLOWS === "1" : cfg.integrations?.jev?.workflows === true,
  };
}
