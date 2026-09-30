import type { AuthStore } from "../providers/auth";

export type IntegrationProvider = "typesafe" | "hindsight";
const ENV_KEYS = { typesafe: "TYPESAFE_API_KEY", hindsight: "HINDSIGHT_API_KEY" } as const;

/** Local-only discovery. Never refreshes OAuth or probes the external service. */
export function resolveIntegrationCredential(auth: AuthStore, provider: IntegrationProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env[ENV_KEYS[provider]]?.trim();
  if (key) return key;
  const stored = auth.get(provider);
  return stored?.type === "api_key" ? stored.key.trim() || undefined : undefined;
}

export function integrationCredentialSource(auth: AuthStore, provider: IntegrationProvider, env: NodeJS.ProcessEnv = process.env): "env" | "stored" | "none" {
  if (env[ENV_KEYS[provider]]?.trim()) return "env";
  return resolveIntegrationCredential(auth, provider, {}) ? "stored" : "none";
}
