import { join } from "node:path";
import { AuthStore } from "../providers/auth";

export const AUTH_PROVIDERS = ["anthropic", "openai-codex", "openai"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export type LoginProvider = "anthropic" | "openai-codex" | "openai-codex-device";
export type ApiKeyProvider = "anthropic" | "openai";

export interface ProviderChoice {
  readonly id: "anthropic" | "openai";
  readonly name: string;
  readonly login: LoginProvider;
  readonly apiKey: ApiKeyProvider;
}

export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  { id: "anthropic", name: "Anthropic", login: "anthropic", apiKey: "anthropic" },
  { id: "openai", name: "OpenAI", login: "openai-codex", apiKey: "openai" },
] as const;

export function providerChoice(value: string | undefined): ProviderChoice | undefined {
  const id = value?.trim().toLowerCase();
  if (id === "anthropic" || id === "claude") return PROVIDER_CHOICES[0];
  if (id === "openai" || id === "chatgpt" || id === "openai-codex") return PROVIDER_CHOICES[1];
  return undefined;
}

export function authStore(home: string): AuthStore {
  return new AuthStore(join(home, "auth.json"));
}

export interface LocalAuthState {
  readonly required: boolean;
  readonly configured: readonly AuthProvider[];
}

/** First-run detection is intentionally local: stored and environment credentials only. */
export function localAuthState(home: string, store = authStore(home)): LocalAuthState {
  const configured = store.configuredProviders(AUTH_PROVIDERS) as AuthProvider[];
  return { required: configured.length === 0, configured };
}

export type OpenUrl = (url: string) => void;

/** Open the system browser without a shell. Login always retains a copy/paste fallback. */
export const openUrl: OpenUrl = (url) => {
  const windowsScript = `$ErrorActionPreference='Stop';Start-Process '${url.replaceAll("'", "''")}'`;
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")]
      : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
    void child.exited.catch(() => {});
  } catch {
    // Best effort: the full authorization URL is still displayed for copy/paste.
  }
};
