import { join } from "node:path";
import { loadConfig, saveConfig } from "../../core/config";
import { initHome } from "../../core/home";
import { kilnHome } from "../../core/paths";
import { AuthStore } from "../../providers/auth";
import { integrationCredentialSource } from "../../integrations/credentials";
import { resolveJevSettings } from "../../integrations/settings";
import type { CliIo } from "../main";

export async function integrationsCommand(args: string[], flags: Record<string, string | boolean>, io: CliIo,
  deps: { env?: NodeJS.ProcessEnv; auth?: AuthStore } = {}): Promise<number> {
  const err = io.error ?? io.write;
  if (args.length !== 2 || args[0] !== "jev" || !["status", "enable", "disable"].includes(args[1]!)
    || Object.keys(flags).some(key => !["home", "json"].includes(key))
    || (flags.home !== undefined && typeof flags.home !== "string")
    || (flags.json !== undefined && flags.json !== true)) {
    err("usage: kiln integrations jev status|enable|disable [--home PATH] [--json]\n"); return 2;
  }
  try {
    const home = typeof flags.home === "string" ? flags.home : kilnHome();
    const env = deps.env ?? process.env;
    if (args[1] !== "status") initHome(home, { plugAndPlay: true });
    const cfg = loadConfig(home);
    if (args[1] !== "status") {
      cfg.integrations = { ...cfg.integrations, jev: { ...cfg.integrations?.jev, workflows: args[1] === "enable" } };
      saveConfig(home, cfg);
    }
    const auth = deps.auth ?? new AuthStore(join(home, "auth.json"), { onWarn: () => {} });
    const credentialSource = integrationCredentialSource(auth, "typesafe", env);
    const effective = resolveJevSettings(cfg, env);
    const report = { integration: "jev", configuredWorkflows: cfg.integrations?.jev?.workflows ?? false,
      effective, credentialSource, serviceChecked: false,
      appliesTo: "new native sessions; existing sessions retain saved policy and respect disabling overrides",
      nextStep: credentialSource === "none" ? "kiln auth key jev" : null };
    if (flags.json) io.write(JSON.stringify(report, null, 2) + "\n");
    else {
      io.write(`Jev workflows: saved ${report.configuredWorkflows ? "enabled" : "disabled"}; effective ${effective.workflows && effective.enabled ? "enabled" : "disabled"}. Credential: ${credentialSource}. Service not contacted.\n`);
      if (report.nextStep) io.write(`Connect Jev with: ${report.nextStep}\n`);
      if (args[1] !== "status") io.write("Policy saved for new sessions. Existing sessions keep their original integration policy.\n");
    }
    return 0;
  } catch { err("Integration settings could not be read or saved; inspect the local configuration.\n"); return 1; }
}
