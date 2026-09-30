import { join } from "node:path";
import { loadConfig } from "../../core/config";
import { kilnHome } from "../../core/paths";
import { resolveIntegrationCredential } from "../../integrations/credentials";
import { AuthStore } from "../../providers/auth";
import { parseModelRef } from "../../providers/models";
import { resolveStep } from "../../operator/routing";
import type { OperatorStepKind } from "../../operator/context";
import { classifyOperatorStep } from "../../routing/jev";
import type { CliDeps, CliIo } from "../main";

const STEPS: readonly OperatorStepKind[] = ["research", "ideate", "implement", "synthesize"];
/** Read-only advisory command. Only --jev authorizes transmission of the supplied summary. */
export async function routeSuggestCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps = {}): Promise<number> {
  const fail = io.error ?? io.write;
  const summary = cmd.join(" ").trim();
  const step = flags.step ?? "synthesize";
  if (Object.keys(flags).some((key) => !["home", "step", "jev", "json"].includes(key))
    || (flags.home !== undefined && typeof flags.home !== "string")
    || !summary || summary.length > 16000 || typeof step !== "string" || !STEPS.includes(step as OperatorStepKind)
    || (flags.jev !== undefined && flags.jev !== true) || (flags.json !== undefined && flags.json !== true)) {
    fail("usage: kiln model suggest <summary> [--step research|ideate|implement|synthesize] [--jev] [--json]\nReview requires an explicit producer and is excluded from this advisor.\n"); return 2;
  }
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  try {
    const cfg = loadConfig(home);
    const auth = deps.authStoreFactory?.(join(home, "auth.json")) ?? new AuthStore(join(home, "auth.json"));
    const providers = [...new Set(Object.values(cfg.roles).flat().map((ref) => parseModelRef(ref).provider))];
    const available = new Set(auth.configuredProviders(providers));
    const decision = await classifyOperatorStep(summary, {
      fallback: step as OperatorStepKind, allowedSteps: STEPS, enabled: flags.jev === true,
      apiKey: flags.jev === true ? resolveIntegrationCredential(auth, "typesafe") : undefined, fetch: deps.fetchImpl,
    });
    let route: { modelRef: string; effort: string | null; role: string; reason: string } | null = null;
    try {
      const selected = resolveStep(decision.choice, cfg, available, summary);
      route = { modelRef: selected.modelRef, effort: selected.effort, role: selected.role, reason: selected.reason };
    } catch { /* Missing credentials or expired routing evidence cannot authorize an unadmitted seat. */ }
    const result = { advisory: true, decision, route, providerCheck: "local_credentials_only",
      note: route ? "Suggestion only; no model was switched or dispatched. Credentials do not prove provider entitlement."
        : "No model suggestion: local credentials, routing evidence, or compatibility requirements are not satisfied. No model was dispatched." };
    if (flags.json) io.write(JSON.stringify(result, null, 2) + "\n");
    else io.write(`Suggested step: ${decision.choice} (${decision.source}: ${decision.reason})\n${route ? `Model: ${route.modelRef}; effort: ${route.effort ?? "none"}\n` : ""}${result.note}\n`);
    return 0;
  } catch { fail("Unable to prepare a route suggestion from local configuration.\n"); return 1; }
}
