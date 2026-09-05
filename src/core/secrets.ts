/**
 * Keeping credentials out of two places they have no business being: the environment of a shell
 * command the model chose, and the run record on disk. Both are best-effort — the goal is that a
 * routine `env` dump or a tool result quoting a config file cannot leak a live key.
 */

export const REDACTED = "[REDACTED]";

/** Name suffixes that mark an environment variable as carrying a credential. */
const SECRET_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET"];

/** Exact names that carry a credential without matching a suffix rule. */
const SECRET_NAMES = new Set(["ANTHROPIC_OAUTH_TOKEN", "OPENAI_CODEX_OAUTH_TOKEN"]);

/** Provider key shapes worth catching even when they never passed through the environment. */
const KEY_PATTERN = /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g;

/** Values shorter than this are not treated as secrets: redacting `"1"` or `"true"` everywhere
 *  would mangle far more than it protects. */
const MIN_SECRET_LENGTH = 8;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((s) => name.endsWith(s));
}

/** `env` with every credential-named variable removed. */
export function redactEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isSecretEnvName(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The live credential values worth searching for in text, longest first so a value that contains
 *  another is replaced whole. */
export function secretValues(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => isSecretEnvName(k) && typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
}

/** `text` with any known secret value and any provider-shaped key replaced. */
export function redactText(text: string, values: string[] = secretValues()): string {
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
  return out.replace(KEY_PATTERN, REDACTED);
}

/** `redactText` applied to every string inside a JSON-shaped value. */
export function redactValue<T>(value: T, values: string[] = secretValues()): T {
  if (typeof value === "string") return redactText(value, values) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, values)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, values);
    return out as unknown as T;
  }
  return value;
}
