/** Scheduling policy only: capability admission, explicit effort and role context stay with the router. */
export type JevRoutingMode = "boundaries" | "per_prompt";
export type JevRoutingTrigger = "prompt" | "route_step_auto" | "explicit_step";

function mode(value: unknown): JevRoutingMode {
  if (value !== "boundaries" && value !== "per_prompt") throw new Error("Jev routing mode must be boundaries or per_prompt");
  return value;
}

/**
 * Existing policy without a mode used per-prompt classification. Preserve that
 * behavior on resume; a pre-Jev run has no such policy and remains locally routed.
 * The caller separately preserves its saved enabled flag and credential handling.
 */
export function resolveJevRoutingMode(options: {
  isResume: boolean;
  savedPolicy?: { mode?: unknown };
  requestedMode?: unknown;
}): JevRoutingMode {
  const requested = options.requestedMode === undefined ? undefined : mode(options.requestedMode);
  if (!options.isResume) return requested ?? "boundaries";
  const saved = options.savedPolicy;
  if (saved !== undefined && (!saved || typeof saved !== "object" || Array.isArray(saved))) {
    throw new Error("Invalid saved Jev routing policy");
  }
  const frozen = saved?.mode !== undefined ? mode(saved.mode) : saved ? "per_prompt" : "boundaries";
  if (requested !== undefined && requested !== frozen) {
    throw new Error("Resume preserves its Jev routing mode; start a new run to change it");
  }
  return frozen;
}

/** Does not grant permission to dispatch: disabled/missing-key/budget/cancel guards still apply. */
export function shouldClassifyJev(routingMode: JevRoutingMode, trigger: JevRoutingTrigger): boolean {
  mode(routingMode);
  if (trigger === "route_step_auto") return true;
  if (trigger === "explicit_step") return false;
  if (trigger === "prompt") return routingMode === "per_prompt";
  throw new Error("Unknown Jev routing trigger");
}
