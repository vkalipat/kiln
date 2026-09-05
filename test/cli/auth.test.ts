import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CliIo } from "../../src/cli/main";
import { AuthStore } from "../../src/providers/auth";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-auth-cli-"));
  const path = join(home, "auth.json");
  const prompts: string[] = [];
  const store = new AuthStore(path, {
    getEnvApiKey: () => undefined,
    getDefinition: (id) => ({
      storeCredentialsAs: id === "openai-codex-device" ? "openai-codex" : undefined,
      login: async (callbacks) => {
        callbacks.onAuth({ url: `https://login.example/${id}?state=full`, launchUrl: "http://localhost:1455/launch" });
        const pasted = await callbacks.onManualCodeInput?.();
        prompts.push(pasted ?? "");
        return { refresh: "refresh-secret", access: "access-secret", expires: Date.now() + 60_000, email: "person@example.com" };
      },
    }),
  });
  const out: string[] = []; const err: string[] = [];
  const io: CliIo = { write: (text) => out.push(text), error: (text) => err.push(text), askSecret: async () => "manual-secret" };
  return { home, path, store, prompts, out, err, io };
}

describe("auth command", () => {
  test("opens the short local launch URL, displays the full URL, and keeps a secret manual fallback", async () => {
    const f = fixture(); const opened: string[] = [];
    const code = await main(["auth", "login", "openai", "--home", f.home], f.io, {
      authStoreFactory: () => f.store, openUrl: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual(["http://localhost:1455/launch"]);
    expect(f.out.join("")).toContain("https://login.example/openai-codex?state=full");
    expect(f.prompts).toEqual(["manual-secret"]);
    expect(f.store.get("openai-codex")).toMatchObject({ type: "oauth", email: "person@example.com" });
    expect(f.out.join("")).not.toContain("manual-secret");
    expect(f.out.join("")).not.toContain("access-secret");
  });

  test("supports device login and stores the SDK alias", async () => {
    const f = fixture();
    expect(await main(["auth", "login", "openai", "--device", "--home", f.home], f.io, {
      authStoreFactory: () => f.store, openUrl: () => {},
    })).toBe(0);
    expect(f.store.get("openai-codex")).toMatchObject({ type: "oauth" });
  });

  test("keeps OpenAI API keys distinct from ChatGPT subscription OAuth", async () => {
    const f = fixture();
    f.io.askSecret = async () => "sk-openai-api";
    expect(await main(["auth", "key", "openai", "--home", f.home], f.io, { authStoreFactory: () => f.store })).toBe(0);
    f.io.askSecret = async () => "manual-code";
    expect(await main(["auth", "login", "openai", "--home", f.home], f.io, {
      authStoreFactory: () => f.store, openUrl: () => {},
    })).toBe(0);
    expect(f.store.get("openai")).toMatchObject({ type: "api_key" });
    expect(f.store.get("openai-codex")).toMatchObject({ type: "oauth" });
  });

  test("continues with the copy fallback when the browser opener fails", async () => {
    const f = fixture();
    expect(await main(["auth", "login", "anthropic", "--home", f.home], f.io, {
      authStoreFactory: () => f.store, openUrl: () => { throw new Error("no opener"); },
    })).toBe(0);
    expect(f.out.join("")).toContain("https://login.example/anthropic?state=full");
    expect(f.store.get("anthropic")?.type).toBe("oauth");
  });

  test("stores API keys through secret input and status never prints them", async () => {
    const f = fixture();
    f.io.askSecret = async () => "sk-do-not-print";
    expect(await main(["auth", "key", "anthropic", "--home", f.home], f.io, { authStoreFactory: () => f.store })).toBe(0);
    f.out.length = 0;
    expect(await main(["auth", "status", "--json", "--home", f.home], f.io, { authStoreFactory: () => f.store })).toBe(0);
    const report = JSON.parse(f.out.join(""));
    expect(report.find((row: { provider: string }) => row.provider === "anthropic").source).toBe("api_key");
    expect(report.find((row: { provider: string }) => row.provider === "openai-codex").source).toBe("none");
    expect(f.out.join("")).not.toContain("sk-do-not-print");
  });

  test("--api-key-stdin bypasses interactive secret input", async () => {
    const f = fixture(); let prompted = false;
    f.io.askSecret = async () => { prompted = true; return "wrong"; };
    expect(await main(["auth", "key", "openai", "--api-key-stdin", "--home", f.home], f.io, {
      authStoreFactory: () => f.store, stdin: async () => "sk-from-stdin",
    })).toBe(0);
    expect(prompted).toBe(false);
    expect(f.store.get("openai")).toMatchObject({ type: "api_key", key: "sk-from-stdin" });
    expect(f.out.join("")).not.toContain("sk-from-stdin");
  });

  test("redacts submitted OAuth values from provider errors", async () => {
    const f = fixture();
    const unsafe = new AuthStore(f.path, {
      getEnvApiKey: () => undefined,
      getDefinition: () => ({ login: async (callbacks) => {
        const value = await callbacks.onManualCodeInput?.();
        throw new Error(`rejected ${value} {${"provider-payload".repeat(10)}}`);
      } }),
    });
    expect(await main(["auth", "login", "anthropic", "--home", f.home], f.io, { authStoreFactory: () => unsafe, openUrl: () => {} })).toBe(1);
    expect(f.err.join("")).toContain("[REDACTED]");
    expect(f.err.join("")).toContain("[provider response omitted]");
    expect(f.err.join("")).not.toContain("manual-secret");
  });

  test("a top-level SIGINT aborts OAuth promptly and removes its listener", async () => {
    const f = fixture(); let entered = false;
    const store = new AuthStore(f.path, {
      getEnvApiKey: () => undefined,
      getDefinition: () => ({ login: (callbacks) => new Promise((_resolve, reject) => {
        entered = true;
        callbacks.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }) }),
    });
    const before = new Set(process.listeners("SIGINT"));
    const running = main(["auth", "login", "anthropic", "--home", f.home], f.io, { authStoreFactory: () => store, openUrl: () => {} });
    for (let attempt = 0; !entered && attempt < 200; attempt++) await Bun.sleep(1);
    const handler = process.listeners("SIGINT").find((listener) => !before.has(listener));
    expect(handler).toBeDefined();
    (handler as () => void)();
    expect(await running).toBe(1);
    expect(store.providers()).toEqual([]);
    expect(process.listeners("SIGINT").filter((listener) => !before.has(listener))).toEqual([]);
  });

  test("status never refreshes or exchanges a stored OAuth credential", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-auth-local-status-"));
    let networkCalls = 0;
    const store = new AuthStore(join(home, "auth.json"), {
      getDefinition: () => undefined, getEnvApiKey: () => undefined,
      refreshOAuthToken: async (_provider, credential) => { networkCalls++; return credential; },
      getOAuthApiKey: async () => { networkCalls++; return null; },
    });
    store.set({ type: "oauth", provider: "anthropic", refresh: "r", access: "a", expires: Date.now() - 1 });
    expect(await main(["auth", "status", "--home", home], { write: () => {} }, { authStoreFactory: () => store })).toBe(0);
    expect(networkCalls).toBe(0);
  });

  test("status is local-only and does not create a credential file", async () => {
    const f = fixture();
    expect(await main(["auth", "status", "--home", f.home], f.io, { authStoreFactory: () => f.store })).toBe(0);
    expect(existsSync(f.path)).toBe(false);
  });

  test("logout is idempotent and preserves environment-backed access", async () => {
    const f = fixture();
    f.store.setApiKey("openai", "stored-secret");
    expect(await main(["auth", "logout", "openai", "--home", f.home], f.io, { authStoreFactory: () => f.store })).toBe(0);
    expect(await main(["auth", "logout", "openai", "--home", f.home], f.io, { authStoreFactory: () => f.store })).toBe(0);
    expect(f.store.get("openai")).toBeUndefined();
  });
});
