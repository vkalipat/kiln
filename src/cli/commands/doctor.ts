import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../../providers/auth";
import { loadConfig, ROLES } from "../../core/config";
import { kilnHome } from "../../core/paths";
import { prepareStepRouting } from "../../operator/routing";
import { parseModelRef } from "../../providers/models";
import { memoryBank, memoryUrl } from "../../integrations/hindsight";
import { integrationCredentialSource } from "../../integrations/credentials";
import { resolveJevSettings } from "../../integrations/settings";
import type { CliIo } from "../main";

export interface DoctorDeps { env?: Record<string, string | undefined>; auth?: AuthStore }
const packages = ["pi-agent-core", "pi-ai", "pi-catalog", "pi-coding-agent", "pi-tui", "pi-utils"];
function packageVersion(name: string): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    for (let n = 0; n < 8; n++, dir = dirname(dir)) {
      const path = join(dir, "package.json");
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      if (pkg.name === name && typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version)) return pkg.version;
    }
  } catch { /* Diagnostic only: never return paths or raw import errors. */ }
  return null;
}

/** Offline configuration inspection only. Never initializes homes or resolves live credentials. */
export async function doctorCommand(args: string[], flags: Record<string, string | boolean>, io: CliIo, deps: DoctorDeps = {}): Promise<number> {
  const usage = () => { (io.error ?? io.write)("usage: kiln doctor [--json] [--require jev|hindsight|jev,hindsight] [--home PATH] [--cwd PATH]\n"); return 2; };
  if (args.length || Object.keys(flags).some(k => !["json", "require", "home", "cwd"].includes(k))
    || (flags.json !== undefined && flags.json !== true)
    || ["require", "home", "cwd"].some(k => flags[k] !== undefined && (typeof flags[k] !== "string" || !String(flags[k]).trim()))) return usage();
  const required = flags.require === undefined ? [] : String(flags.require).split(",");
  if (new Set(required).size !== required.length || required.some(k => !["jev", "hindsight"].includes(k))) return usage();
  const env = deps.env ?? process.env, home = typeof flags.home === "string" ? flags.home : kilnHome();
  const blockers: string[] = [], warnings: string[] = [];
  const output = (report: object) => { io.write(JSON.stringify(report, null, 2) + "\n"); };
  if (!existsSync(join(home, "config.json"))) { output({ version: 1, ready: false, offline: true, liveChecked: false, blockers: ["home_needs_setup"] }); return 1; }
  try {
    const cfg = loadConfig(home);
    const auth = deps.auth ?? new AuthStore(join(home, "auth.json"), { onWarn: () => {} });
    let cwdReady = false;
    try { cwdReady = statSync(typeof flags.cwd === "string" ? flags.cwd : process.cwd()).isDirectory(); } catch { /* No paths emitted. */ }
    if (!cwdReady) blockers.push("cwd_unavailable");
    const versions = Object.fromEntries(packages.map(p => [p, packageVersion(`@oh-my-pi/${p}`)]));
    if (Object.values(versions).some(v => v === null)) blockers.push("native_dependency_unavailable");
    const providers = [...new Set(Object.values(cfg.roles).flat().map(ref => parseModelRef(ref).provider))];
    const configured = auth.configuredProviders(providers);
    const roles = Object.fromEntries(ROLES.map(role => [role, { compatible: false }]));
    let routingReady = false;
    try {
      const plan = prepareStepRouting(cfg, new Set(configured), "General task");
      for (const role of ROLES) roles[role] = { compatible: Boolean(plan.selectedRoleRefs[role]) };
      routingReady = true;
    } catch { blockers.push(configured.length ? "native_role_plan_unavailable" : "native_credentials_missing"); }
    const settings = resolveJevSettings(cfg, env);
    const jevCredential = integrationCredentialSource(auth, "typesafe", env) !== "none";
    const jevReady = settings.enabled && settings.workflows && jevCredential;
    // Configuration values are never rendered. Even endpoint paths can contain credentials.
    const url = env.KILN_HINDSIGHT_URL, bank = env.KILN_HINDSIGHT_BANK;
    let endpoint: string | null = null, loopback = false, memoryValid = false;
    try {
      if (url && bank) {
        const parsed = new URL(memoryUrl(url)); memoryBank(bank);
        loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
        endpoint = loopback ? `${parsed.protocol}//loopback` : `${parsed.protocol}//remote`;
        memoryValid = true;
      }
    } catch { /* Invalid URLs, bank names, and embedded tokens remain private. */ }
    const memoryCredential = integrationCredentialSource(auth, "hindsight", env) !== "none";
    const hindsightReady = memoryValid && (loopback || memoryCredential);
    if (!jevReady) (required.includes("jev") ? blockers : warnings).push("jev_not_configured");
    if (!hindsightReady) (required.includes("hindsight") ? blockers : warnings).push("hindsight_not_configured");
    output({ version: 1, ready: blockers.length === 0, offline: true, liveChecked: false,
      versions: { bun: Bun.version, ...versions }, native: { codeAvailable: true, configured: routingReady, credentialConfigured: configured.length > 0, roles, liveChecked: false },
      operator: { budgetUsd: cfg.operator?.budgetUsd !== undefined ? cfg.operator.budgetUsd : cfg.budgets.usd,
        wallSeconds: cfg.operator?.wallSeconds !== undefined ? cfg.operator.wallSeconds : cfg.budgets.wallSeconds,
        nullMeans: "unlimited", appliesTo: "new_sessions", computeMonitor: { codeAvailable: true }, scopedTeams: { codeAvailable: true } },
      jev: { codeAvailable: true, enabled: settings.enabled, workflows: settings.workflows, credentialConfigured: jevCredential, configured: jevReady, liveChecked: false },
      hindsight: { codeAvailable: true, endpoint, bankConfigured: Boolean(bank), configurationValid: memoryValid, credentialConfigured: memoryCredential, configured: hindsightReady, liveChecked: false },
      blockers, warnings, limitations: ["Credential presence does not establish live authentication or model entitlement.", "No provider, DNS, service, or challenge execution was attempted."] });
    return blockers.length ? 1 : 0;
  } catch { output({ version: 1, ready: false, offline: true, liveChecked: false, blockers: ["local_configuration_invalid"] }); return 1; }
}
