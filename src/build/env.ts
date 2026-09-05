const BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "SHELL", "USER"] as const;

/** The complete environment for an init, acceptance, or regression check. */
export function checkEnv(needs: readonly string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string) => Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  for (const name of BASE_ENV) if (typeof env[name] === "string") set(name, env[name]!);
  for (const name of needs) if (typeof env[name] === "string") set(name, env[name]!);
  // A declared TERM never widens this fixed non-interactive value.
  set("TERM", "dumb");
  return out;
}
