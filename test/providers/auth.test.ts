import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/providers/auth";

function store(overrides: Partial<ConstructorParameters<typeof AuthStore>[1]> = {}) {
  const d = mkdtempSync(join(tmpdir(), "kiln-"));
  const env: Record<string, string> = {};
  const refreshCalls: string[] = [];
  const s = new AuthStore(join(d, "auth.json"), {
    getDefinition: (id) => ({ login: async (cb) => { cb.onAuth({ url: `https://login/${id}` }); return { refresh: "r", access: `${id}-access`, expires: Date.now() + 3600_000 }; } }),
    // Models the real library: `getOAuthApiKey` passes an unexpired credential through unchanged.
    // Expiry handling is `refreshOAuthToken`'s job, invoked by `AuthStore` before this is called.
    getOAuthApiKey: async (provider, creds) => { const c = creds[provider]; return c ? { newCredentials: c, apiKey: c.access } : null; },
    refreshOAuthToken: async (provider, creds) => { refreshCalls.push(provider); return { ...creds, access: `${creds.access}-refreshed`, expires: Date.now() + 3600_000 }; },
    getEnvApiKey: (p) => env[p],
    ...overrides,
  });
  return { s, env, d, refreshCalls };
}

describe("AuthStore", () => {
  test("login stores oauth credential with 0600 and lists provider", async () => {
    const { s, d } = store();
    const seen: string[] = [];
    const cred = await s.login("anthropic", { onAuth: (i) => seen.push(i.url), onPrompt: async () => "" });
    expect(cred.type).toBe("oauth");
    expect(seen).toEqual(["https://login/anthropic"]);
    expect(s.providers()).toEqual(["anthropic"]);
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    // No world-readable temp copy of the credential is left behind by the atomic write.
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(d)).toEqual(["auth.json"]);
  });

  test("a corrupt auth.json yields an empty store and one warning", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "auth.json");
    writeFileSync(path, "{not json");
    const warnings: string[] = [];
    const s = new AuthStore(path, { onWarn: (m) => warnings.push(m), getEnvApiKey: () => undefined, getDefinition: () => undefined });
    expect(s.providers()).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(path);
  });

  test("a corrupt auth.json does not stop a later login from rewriting the file", async () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "auth.json");
    writeFileSync(path, "{not json");
    const s = new AuthStore(path, {
      onWarn: () => {},
      getDefinition: (id) => ({ login: async () => ({ refresh: "r", access: `${id}-access`, expires: Date.now() + 3600_000 }) }),
      getEnvApiKey: () => undefined,
    });
    await s.login("anthropic", { onAuth: () => {}, onPrompt: async () => "" });
    expect(s.providers()).toEqual(["anthropic"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("ignores malformed credential entries without treating them as configured", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const path = join(d, "auth.json");
    writeFileSync(path, JSON.stringify({
      anthropic: { type: "bogus", provider: "anthropic" },
      openai: { type: "api_key", provider: "elsewhere", key: "key" },
      "openai-codex": { type: "oauth", provider: "openai-codex", refresh: "", access: "a", expires: "soon" },
      invalidIdentity: { type: "oauth", provider: "invalidIdentity", refresh: "r", access: "a", expires: 1, email: {} },
      invalidDate: { type: "oauth", provider: "invalidDate", refresh: "r", access: "a", expires: Number.MAX_VALUE },
    }));
    const warnings: string[] = [];
    const s = new AuthStore(path, { onWarn: (message) => warnings.push(message), getEnvApiKey: () => undefined, getDefinition: () => undefined });
    expect(s.configuredProviders(["anthropic", "openai", "openai-codex"])).toEqual([]);
    expect(warnings).toEqual(["kiln: ignoring invalid credential entries"]);
  });

  test("apiKeyFor passes an unexpired credential through getOAuthApiKey and persists", async () => {
    const { s } = store();
    await s.login("openai-codex", { onAuth: () => {}, onPrompt: async () => "" });
    expect(await s.apiKeyFor("openai-codex")).toBe("openai-codex-access");
    const again = new AuthStore(s.path, {
      getOAuthApiKey: async (p, c) => ({ newCredentials: c[p]!, apiKey: c[p]!.access }),
      getEnvApiKey: () => undefined,
      getDefinition: () => undefined,
      refreshOAuthToken: async (_p, c) => c,
    });
    expect(await again.apiKeyFor("openai-codex")).toBe("openai-codex-access");
  });

  test("env fallback and preferApiKeys", async () => {
    const { s, env } = store();
    env.anthropic = "sk-env";
    expect(await s.apiKeyFor("anthropic")).toBe("sk-env");
    await s.login("anthropic", { onAuth: () => {}, onPrompt: async () => "" });
    expect(await s.apiKeyFor("anthropic")).toBe("anthropic-access");
    expect(await s.apiKeyFor("anthropic", { preferApiKeys: true })).toBe("sk-env");
  });

  test("unknown provider returns undefined", async () => {
    const { s } = store();
    expect(await s.apiKeyFor("nope")).toBeUndefined();
  });

  test("detects stored and environment credentials without refresh or exchange", () => {
    let networkCalls = 0;
    const { s, env } = store({
      getOAuthApiKey: async () => { networkCalls++; return null; },
      refreshOAuthToken: async (_provider, credential) => { networkCalls++; return credential; },
    });
    env.openai = "sk-env";
    s.setApiKey("anthropic", "sk-stored");
    expect(s.source("anthropic")).toBe("api_key");
    expect(s.source("openai")).toBe("env");
    expect(s.source("openai-codex")).toBe("none");
    expect(s.configuredProviders(["anthropic", "openai-codex", "openai"])).toEqual(["anthropic", "openai"]);
    expect(networkCalls).toBe(0);
  });

  test("stores an aliased device login under its model provider", async () => {
    const { s } = store({
      getDefinition: () => ({
        storeCredentialsAs: "openai-codex",
        login: async () => ({ refresh: "r", access: "device-access", expires: Date.now() + 3600_000 }),
      }),
    });
    await s.login("openai-codex-device", { onAuth: () => {}, onPrompt: async () => "" });
    expect(s.get("openai-codex")).toMatchObject({ type: "oauth", access: "device-access" });
    expect(s.get("openai-codex-device")).toBeUndefined();
  });

  test("an abort racing provider completion never stores credentials", async () => {
    let finish!: (credential: { refresh: string; access: string; expires: number }) => void;
    const provider = new Promise<{ refresh: string; access: string; expires: number }>((resolve) => { finish = resolve; });
    const { s } = store({ getDefinition: () => ({ login: () => provider }) });
    const controller = new AbortController();
    const login = s.login("anthropic", { signal: controller.signal, onAuth: () => {}, onPrompt: async () => "" });
    controller.abort();
    await expect(login).rejects.toThrow("Login cancelled");
    finish({ refresh: "late-refresh", access: "late-access", expires: Date.now() + 60_000 });
    await Promise.resolve();
    expect(s.providers()).toEqual([]);
    expect(existsSync(s.path)).toBe(false);
  });

  test("a pre-aborted login never starts the provider", async () => {
    let starts = 0;
    const { s } = store({ getDefinition: () => ({ login: async () => { starts++; return "unused"; } }) });
    const controller = new AbortController(); controller.abort();
    await expect(s.login("anthropic", { signal: controller.signal, onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow("Login cancelled");
    expect(starts).toBe(0);
    expect(s.providers()).toEqual([]);
  });

  test("an expired credential is refreshed through refreshOAuthToken and the refresh is persisted", async () => {
    const { s, refreshCalls } = store();
    await s.login("anthropic", { onAuth: () => {}, onPrompt: async () => "" });
    const before = s.get("anthropic");
    if (before?.type !== "oauth") throw new Error("expected an oauth credential");
    s.set({ ...before, expires: Date.now() - 1_000 }); // already expired
    refreshCalls.length = 0;

    expect(await s.apiKeyFor("anthropic")).toBe("anthropic-access-refreshed");
    expect(refreshCalls).toEqual(["anthropic"]);

    const again = new AuthStore(s.path, {
      getOAuthApiKey: async (p, c) => ({ newCredentials: c[p]!, apiKey: c[p]!.access }),
      getEnvApiKey: () => undefined,
      getDefinition: () => undefined,
      refreshOAuthToken: async (_p, c) => c,
    });
    const reopened = again.get("anthropic");
    expect(reopened?.type).toBe("oauth");
    if (reopened?.type === "oauth") {
      expect(reopened.access).toBe("anthropic-access-refreshed");
      expect(reopened.expires).toBeGreaterThan(Date.now());
    }
  });

  test("a credential within 60s of expiry is refreshed", async () => {
    const { s, refreshCalls } = store();
    await s.login("anthropic", { onAuth: () => {}, onPrompt: async () => "" });
    const before = s.get("anthropic");
    if (before?.type !== "oauth") throw new Error("expected an oauth credential");
    s.set({ ...before, expires: Date.now() + 30_000 }); // inside the 60s refresh buffer
    refreshCalls.length = 0;

    expect(await s.apiKeyFor("anthropic")).toBe("anthropic-access-refreshed");
    expect(refreshCalls).toEqual(["anthropic"]);
  });

  test("coalesces concurrent refreshes and preserves stable OAuth identity metadata", async () => {
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { s } = store({
      refreshOAuthToken: async () => {
        refreshes++; await gate;
        return { refresh: "new-refresh", access: "new-access", expires: Date.now() + 3600_000 };
      },
      getOAuthApiKey: async (_provider, credentials) => ({ newCredentials: credentials.anthropic!, apiKey: credentials.anthropic!.access }),
    });
    s.set({
      type: "oauth", provider: "anthropic", refresh: "old", access: "old", expires: 0,
      email: "person@example.com", orgId: "org-1", orgName: "Studio", authorizedAt: 123,
    });
    const calls = [s.apiKeyFor("anthropic"), s.apiKeyFor("anthropic"), s.apiKeyFor("anthropic"), s.apiKeyFor("anthropic")];
    expect(refreshes).toBe(1);
    release();
    expect(await Promise.all(calls)).toEqual(["new-access", "new-access", "new-access", "new-access"]);
    expect(s.get("anthropic")).toMatchObject({ email: "person@example.com", orgId: "org-1", orgName: "Studio", authorizedAt: 123 });
  });

  test("a credential far from expiry is not refreshed", async () => {
    const { s, refreshCalls } = store();
    await s.login("anthropic", { onAuth: () => {}, onPrompt: async () => "" }); // expires in 1h
    refreshCalls.length = 0;

    expect(await s.apiKeyFor("anthropic")).toBe("anthropic-access");
    expect(refreshCalls).toEqual([]);
  });

  test("a failing refresh does not throw from apiKeyFor, falls back to env, and leaves the credential in place", async () => {
    const { s, env } = store({ refreshOAuthToken: async () => { throw new Error("network down"); } });
    await s.login("anthropic", { onAuth: () => {}, onPrompt: async () => "" });
    const before = s.get("anthropic");
    if (before?.type !== "oauth") throw new Error("expected an oauth credential");
    s.set({ ...before, expires: Date.now() - 1_000 }); // expired, refresh will fail

    expect(await s.apiKeyFor("anthropic")).toBeUndefined();
    env.anthropic = "sk-env-fallback";
    expect(await s.apiKeyFor("anthropic")).toBe("sk-env-fallback");

    const untouched = s.get("anthropic");
    expect(untouched?.type).toBe("oauth");
    if (untouched?.type === "oauth") expect(untouched.access).toBe(before.access);
  });
});
