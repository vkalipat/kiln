import { join } from "node:path";
import { initHome } from "../../core/home";
import { kilnHome } from "../../core/paths";
import { currentRunControl } from "../../core/run-control";
import { redactText } from "../../core/secrets";
import {
  AUTH_PROVIDERS, openUrl, providerChoice, PROVIDER_CHOICES, type LoginProvider,
} from "../../onboarding/auth";
import { askSecret, askText, readSecretStdin } from "../../onboarding/input";
import { AuthStore } from "../../providers/auth";
import type { CliDeps, CliIo } from "../main";
import { printJson, table } from "../output";

const AUTH_USAGE = "usage: kiln auth login [anthropic|openai] [--device|--no-browser] | kiln auth key <anthropic|openai> [--api-key-stdin] | kiln auth status [--json] | kiln auth logout <anthropic|openai|all>\n";

function safeAuthError(raw: string, sensitiveInputs: readonly string[]): string {
  const variants = sensitiveInputs.flatMap((value) => [value, encodeURIComponent(value)]);
  return redactText(raw, variants)
    .replace(/("(?:access_token|refresh_token|api_key|key|code)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\{[^\n]{80,}\}/g, "[provider response omitted]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .slice(0, 500);
}

function createStore(home: string, deps: CliDeps): AuthStore {
  return deps.authStoreFactory?.(join(home, "auth.json")) ?? new AuthStore(join(home, "auth.json"));
}

async function chooseProvider(io: CliIo, deps: CliDeps): Promise<(typeof PROVIDER_CHOICES)[number] | undefined> {
  io.write("Connect a provider\n  1) Anthropic · Claude Pro/Max\n  2) OpenAI · ChatGPT Plus/Pro\n");
  const answer = (await askText("Provider [1]: ", io, deps)).trim();
  if (!answer || answer === "1") return PROVIDER_CHOICES[0];
  if (answer === "2") return PROVIDER_CHOICES[1];
  return providerChoice(answer);
}

async function login(
  requested: string | undefined,
  flags: Record<string, string | boolean>,
  auth: AuthStore,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const choice = providerChoice(requested) ?? (!requested ? await chooseProvider(io, deps) : undefined);
  if (!choice) { (io.error ?? io.write)(AUTH_USAGE); return 2; }
  const provider: LoginProvider = choice.id === "openai" && flags.device === true ? "openai-codex-device" : choice.login;
  const launch = deps.openUrl ?? openUrl;
  const ambientSignal = currentRunControl()?.signal;
  const localController = !deps.authAbortController && !ambientSignal ? new AbortController() : undefined;
  const signal = deps.authAbortController?.signal ?? ambientSignal ?? localController!.signal;
  const onSigint = () => localController?.abort("user_cancelled");
  if (localController) process.once("SIGINT", onSigint);
  const sensitiveInputs: string[] = [];
  const secret = async (prompt: string) => {
    const value = await askSecret(prompt, io, deps, onSigint);
    if (value) sensitiveInputs.push(value);
    return value;
  };
  try {
    const credential = await auth.login(provider, {
      signal,
      onAuth: (info) => {
        if (flags["no-browser"] !== true) { try { launch(info.launchUrl ?? info.url); } catch { /* copy fallback below remains authoritative */ } }
        io.write(`${flags["no-browser"] === true ? "Open" : "If the browser did not open, use"} this URL:\n${info.url}\n`);
        if (info.launchUrl && info.launchUrl !== info.url) io.write(`Local shortcut: ${info.launchUrl}\n`);
        if (info.instructions) io.write(`${info.instructions}\n`);
      },
      onPrompt: (message, options) => secret(`${message}${options?.placeholder ? ` (${options.placeholder})` : ""}: `),
      onManualCodeInput: () => secret("Paste the redirect URL or authorization code: "),
      onProgress: (message) => io.write(`${message}\n`),
    });
    const who = credential.type === "oauth" ? credential.email ?? credential.accountId : undefined;
    io.write(`Connected ${choice.name}${who ? ` as ${who}` : ""}.\n`);
    return 0;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = safeAuthError(raw, sensitiveInputs);
    const fallback = choice.id === "openai" && provider !== "openai-codex-device"
      ? " Try `kiln auth login openai --device` for headless or blocked callback environments."
      : "";
    (io.error ?? io.write)(`Login failed: ${message}${fallback}\n`);
    return 1;
  } finally { if (localController) process.off("SIGINT", onSigint); }
}

async function setKey(provider: string | undefined, flags: Record<string, string | boolean>, auth: AuthStore, io: CliIo, deps: CliDeps): Promise<number> {
  const choice = providerChoice(provider);
  if (!choice) { (io.error ?? io.write)(AUTH_USAGE); return 2; }
  let key: string;
  try { key = (await (flags["api-key-stdin"] === true ? readSecretStdin(deps) : askSecret("API key: ", io, deps))).trim(); }
  catch { (io.error ?? io.write)("API key input cancelled.\n"); return 1; }
  if (!key) { (io.error ?? io.write)("API key cannot be empty.\n"); return 2; }
  if (auth.get(choice.apiKey)) io.write(`Replacing the stored ${choice.name} credential.\n`);
  auth.setApiKey(choice.apiKey, key);
  io.write(`Connected ${choice.name} with an API key.\n`);
  return 0;
}

function status(auth: AuthStore, json: boolean, io: CliIo): number {
  const rows = AUTH_PROVIDERS.map((provider) => {
    const stored = auth.get(provider);
    const expires = stored?.type === "oauth" ? new Date(stored.expires).toISOString() : "";
    const identity = stored?.type === "oauth" ? stored.email ?? stored.accountId ?? "" : "";
    return { provider, source: auth.source(provider), identity, expires };
  });
  if (json) printJson(io, rows);
  else table(io, [["provider", "source", "identity", "expires"], ...rows.map((row) => [row.provider, row.source, row.identity, row.expires])]);
  return 0;
}

function logout(requested: string | undefined, auth: AuthStore, io: CliIo): number {
  if (requested === "all") {
    for (const provider of auth.providers()) auth.remove(provider);
    io.write("Removed all stored Kiln credentials.\n");
    return 0;
  }
  const choice = providerChoice(requested);
  if (!choice) { (io.error ?? io.write)(AUTH_USAGE); return 2; }
  const targets = choice.id === "openai" ? ["openai-codex", "openai"] : ["anthropic"];
  for (const provider of targets) auth.remove(provider);
  const env = targets.some((provider) => auth.source(provider) === "env");
  io.write(`Removed stored ${choice.name} credentials.${env ? " Environment credentials remain active." : ""}\n`);
  return 0;
}

export async function authCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: CliDeps): Promise<number> {
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  initHome(home);
  const auth = createStore(home, deps);
  if (cmd[0] === "login") {
    const provider = cmd[1] ?? (typeof flags.provider === "string" ? flags.provider : undefined);
    if (flags.method === "api-key" || flags.method === "key") return setKey(provider, flags, auth, io, deps);
    return login(provider, flags, auth, io, deps);
  }
  if (cmd[0] === "key") return setKey(cmd[1] ?? (typeof flags.provider === "string" ? flags.provider : undefined), flags, auth, io, deps);
  if (cmd[0] === "status") return status(auth, flags.json === true, io);
  if (cmd[0] === "logout") return logout(cmd[1], auth, io);
  (io.error ?? io.write)(AUTH_USAGE);
  return 2;
}
