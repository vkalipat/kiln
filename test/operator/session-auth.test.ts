import { expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { installOperatorAuthStorage } from "../../src/operator/session";

test("installed native storage uses host resolution only for admitted owned requests", async () => {
  const storage = await AuthStorage.create(":memory:");
  const calls: string[] = [];
  try {
    const installed = installOperatorAuthStorage(storage, ["allowed"], async (provider, owner) => {
      calls.push(`${provider}:${owner}`); return owner === "root" || owner === "child" ? "host-runtime-key" : undefined;
    });
    const flat = storage as unknown as { hasAuth(p: string): boolean; hasResolvableAuth(p: string): boolean; hasConcreteAuth(p: string): boolean;
      getApiKey(p: string, owner?: string): Promise<string | undefined>; peekApiKey(p: string): Promise<string | undefined>; getAll(): unknown };
    const modern = storage as unknown as ReturnType<typeof namespacedStorage> & { credentials: { all(): unknown } };
    const auth = installed === "flat" ? flat : {
      hasAuth: (p: string) => modern.keys.source(p) !== undefined,
      hasResolvableAuth: (p: string) => modern.keys.source(p, { env: "aliases" }) !== undefined,
      hasConcreteAuth: (p: string) => modern.keys.source(p)?.concrete === true,
      getApiKey: modern.keys.get.bind(modern.keys), peekApiKey: modern.keys.peek.bind(modern.keys), getAll: () => modern.credentials.all(),
    };
    expect(auth.hasAuth("allowed")).toBe(true);
    expect(auth.hasResolvableAuth("disallowed")).toBe(false);
    expect(auth.hasConcreteAuth("allowed")).toBe(true);
    expect(await auth.getApiKey("allowed")).toBeUndefined();
    expect(await auth.peekApiKey("allowed")).toBeUndefined();
    expect(await auth.getApiKey("disallowed", "root")).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await auth.getApiKey("allowed", "root")).toBe("host-runtime-key");
    expect(await auth.getApiKey("allowed", "child")).toBe("host-runtime-key");
    expect(await auth.getApiKey("allowed", "not-live")).toBeUndefined();
    expect(auth.getAll()).toEqual({});
  } finally { storage.close(); }
});

/** 18.4.2 KeysApi signatures copied from the inspected official package, no fallback stubs used by adapter. */
function namespacedStorage() {
  const forbidden = () => { throw new Error("Native bearer cascade must not run"); };
  const keys = {
    get: async (_provider: string, _owner?: string, _request?: { signal?: AbortSignal }): Promise<string | undefined> => forbidden(),
    getWithCredential: async (_provider: string, _owner?: string, _request?: { signal?: AbortSignal }): Promise<{ apiKey: string; credentialId?: number } | undefined> => forbidden(),
    peek: async (_provider: string): Promise<string | undefined> => forbidden(),
    source: (_provider: string, _options?: { env?: string }): { kind: string; concrete: boolean } | undefined => forbidden(),
    keyless: (_provider: string): boolean => forbidden(),
  };
  const storage = { get keys() { return keys; }, getApiKey: keys.get,
    credentials: { put: forbidden }, oauth: { login: forbidden } };
  return storage;
}

test("namespaced key API and deprecated facade preserve owner guards and never invent credential rows", async () => {
  const storage = namespacedStorage(), calls: string[] = [];
  expect(installOperatorAuthStorage(storage, ["allowed"], async (_provider, owner) => {
    calls.push(owner!); return owner === "root" || owner === "child" ? "live-host-key" : undefined;
  })).toBe("namespaced");
  expect(storage.keys.source("allowed", { env: "aliases" })).toEqual({ kind: "runtime", concrete: true });
  expect(storage.keys.source("other")).toBeUndefined(); expect(storage.keys.keyless("other")).toBe(false);
  expect(await storage.keys.peek("allowed")).toBeUndefined();
  expect(await storage.keys.get("allowed")).toBeUndefined();
  expect(await storage.keys.getWithCredential("allowed")).toBeUndefined();
  expect(await storage.keys.get("other", "root")).toBeUndefined();
  expect(calls).toHaveLength(0);
  expect(await storage.keys.get("allowed", "root")).toBe("live-host-key");
  expect(await storage.keys.getWithCredential("allowed", "child")).toEqual({ apiKey: "live-host-key" });
  expect(await storage.getApiKey("allowed", "root")).toBe("live-host-key");
  expect(await storage.keys.getWithCredential("allowed", "not-live")).toBeUndefined();
  const aborted = new AbortController(); aborted.abort();
  expect(() => storage.keys.get("allowed", "root", { signal: aborted.signal })).toThrow();
  expect(calls).toHaveLength(4);
});

test("unsupported storage shapes fail closed rather than creating unused shadow methods", () => {
  const resolve = async () => "must not escape";
  expect(() => installOperatorAuthStorage({}, ["allowed"], resolve)).toThrow("missing");
  expect(() => installOperatorAuthStorage({ keys: { get() {} } }, ["allowed"], resolve)).toThrow("missing");
  expect(() => installOperatorAuthStorage({ keys: null }, ["allowed"], resolve)).toThrow("namespace");
});

test("credential facade rechecks cancellation after the owned resolver returns", async () => {
  const storage = namespacedStorage(), cancellation = new AbortController();
  installOperatorAuthStorage(storage, ["allowed"], () => {
    queueMicrotask(() => cancellation.abort(new Error("facade cancelled")));
    return Promise.resolve("synthetic-key");
  });
  await expect(storage.keys.getWithCredential("allowed", "root", { signal: cancellation.signal })).rejects.toThrow("facade cancelled");
});
