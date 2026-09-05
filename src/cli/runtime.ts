import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { currentRunControl, RunCancelledError, throwIfRunCancelled } from "../core/run-control";
import { claudeUsageProvider, openaiCodexUsageProvider, resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { KilnConfig, Role } from "../core/config";
import type { ProbeSpec } from "../ideation/probe";
import { AuthStore } from "../providers/auth";
import { availableProviders, resolveRole, resolveRoleOn } from "../providers/models";
import type { PhaseDeps } from "../phases/frame";
import type { CliDeps, CliIo } from "./main";
import { readEffortFile, resolveEffort } from "../evals/effort";
import { registerRuntimeEffort } from "../providers/effort-runtime";

/** Providers an injected key resolver can actually satisfy. */
async function providersWith(apiKeyFor: (provider: string) => Promise<string | undefined>, cfg: KilnConfig): Promise<Set<string>> {
  const out = new Set<string>();
  for (const refs of Object.values(cfg.roles)) {
    for (const ref of refs) {
      const provider = ref.split("/")[0]!;
      if (!out.has(provider) && await apiKeyFor(provider)) out.add(provider);
    }
  }
  return out;
}

function providerUsage(auth: AuthStore, deps: CliDeps): NonNullable<PhaseDeps["fetchUsage"]> {
  return async (provider) => {
    const implementation = provider === "anthropic" ? claudeUsageProvider : provider === "openai-codex" ? openaiCodexUsageProvider : undefined;
    if (!implementation) return undefined;
    // Refresh/exchange first; the store persists refreshed OAuth credentials for the usage call.
    await auth.apiKeyFor(provider);
    const stored = auth.get(provider);
    if (stored?.type !== "oauth") return undefined;
    const report = await implementation.fetchUsage({
      provider: provider as never,
      credential: {
        type: "oauth", accessToken: stored.access, refreshToken: stored.refresh,
        expiresAt: stored.expires, accountId: stored.accountId, projectId: stored.projectId,
        email: stored.email, orgId: stored.orgId, orgName: stored.orgName,
        enterpriseUrl: stored.enterpriseUrl, apiEndpoint: stored.apiEndpoint,
      },
    }, { fetch: deps.fetchImpl ?? fetch });
    if (!report) return undefined;
    return usageSnapshot(report);
  };
}

/** Reduce a provider report to the most-consumed window used by the ideate pause policy. */
export function usageSnapshot(report: UsageReport): { used: number; limit: 1; resetAt?: string } | undefined {
  const ranked = report.limits.flatMap((limit) => {
    const used = resolveUsedFraction(limit);
    return used === undefined ? [] : [{ used, resetAt: limit.window?.resetsAt }];
  }).sort((a, b) => b.used - a.used);
  const worst = ranked[0];
  return worst ? { used: worst.used, limit: 1, resetAt: worst.resetAt === undefined ? undefined : new Date(worst.resetAt).toISOString() } : undefined;
}

export interface CliRuntime {
  auth: AuthStore;
  apiKeyFor: (provider: string) => Promise<string | undefined>;
  available: Set<string>;
  models: PhaseDeps["models"];
  modelsOn: NonNullable<PhaseDeps["modelsOn"]>;
  fetchUsage: NonNullable<PhaseDeps["fetchUsage"]>;
}

export async function createCliRuntime(home: string, cfg: KilnConfig, deps: CliDeps): Promise<CliRuntime> {
  if (deps.runtimeEffort?.enabled === false) registerRuntimeEffort(cfg);
  else {
    const measured = readEffortFile(home);
    const profile = deps.runtimeEffort?.profile ?? "default";
    registerRuntimeEffort(cfg, (role, model) => resolveEffort(cfg, role, { model, ref: `${String(model.provider)}/${model.id}` }, measured, profile).level);
  }
  const auth = new AuthStore(join(home, "auth.json"));
  const apiKeyFor = deps.apiKeyFor ?? ((provider: string) => auth.apiKeyFor(provider, { preferApiKeys: cfg.preferApiKeys }));
  const overrides: Partial<Record<Role, Model>> = { ...(deps.models ?? {}) };
  if (deps.brainModel) overrides.brain = deps.brainModel;
  if (deps.scoutModel) overrides.scout = deps.scoutModel;
  const discovered = deps.apiKeyFor ? await providersWith(deps.apiKeyFor, cfg) : await availableProviders(auth, cfg);
  // Injected models are admitted seats in embedded/test runs. Put them first so cross-provider
  // critic/auditor selection chooses the paired injected provider instead of a credential shim.
  const available = new Set<string>([
    ...Object.values(overrides).flatMap((model) => model ? [String(model.provider)] : []),
    ...discovered,
  ]);
  const resolved = new Map<Role, { model: Model; ref: string }>();
  const models: PhaseDeps["models"] = (role) => {
    const cached = resolved.get(role);
    if (cached) return cached;
    const override = overrides[role];
    const value = override ? { model: override, ref: `${String(override.provider)}/${override.id}` } : resolveRole(role, cfg, available);
    resolved.set(role, value);
    return value;
  };
  const modelsOn: NonNullable<PhaseDeps["modelsOn"]> = (role, provider, excludeRef) => {
    const override = overrides[role];
    const ref = override ? `${String(override.provider)}/${override.id}` : undefined;
    if (override && String(override.provider) === provider && ref !== excludeRef) return { model: override, ref: ref! };
    return resolveRoleOn(role, provider, cfg, available, excludeRef);
  };
  return { auth, apiKeyFor, available, models, modelsOn, fetchUsage: deps.fetchUsage ?? providerUsage(auth, deps) };
}

export async function askCli(prompt: string, io: CliIo, deps: CliDeps): Promise<string> {
  const signal = currentRunControl()?.signal;
  throwIfRunCancelled(signal);
  let close: (() => void) | undefined;
  const read = async () => {
    if (io.ask) return io.ask(prompt);
    if (deps.stdin) return deps.stdin();
    io.write(prompt);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    close = () => input.close();
    return input.question("");
  };
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => { signal?.removeEventListener("abort", abort); close?.(); };
    const abort = () => { cleanup(); reject(new RunCancelledError(signal?.reason)); };
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { throwIfRunCancelled(signal); return read(); }).then(
      (answer) => { cleanup(); if (signal?.aborted) reject(new RunCancelledError(signal.reason)); else resolve(answer); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/** Interactive mode prints exactly the first frozen probe spec before its process launches. */
export function firstProbePreview(io: CliIo, enabled: boolean): PhaseDeps["onProbePreview"] {
  if (!enabled) return undefined;
  let shown = false;
  return (spec: ProbeSpec) => {
    if (shown) return;
    shown = true;
    io.write(`\nFirst probe script (${spec.ideaId})\n`);
    for (const file of spec.files) io.write(`--- ${file.path}\n${file.content}${file.content.endsWith("\n") ? "" : "\n"}`);
    io.write(`command: ${spec.command}\nneeds: ${spec.needs.join(", ") || "none"}\nnetworkRequired: ${spec.networkRequired}\n\n`);
  };
}
