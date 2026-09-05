import { existsSync, readFileSync } from "node:fs";
import { getEnvApiKey, getOAuthApiKey, getProviderDefinition, refreshOAuthToken } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { writeAtomic } from "../core/paths";

export type StoredCredential =
  | ({ type: "oauth"; provider: string } & OAuthCredentials)
  | { type: "api_key"; provider: string; key: string };

/** Login-flow callbacks handed to `AuthStore.login`, decoupled from the library's `OAuthLoginCallbacks` (whose `onPrompt` takes a structured `{ message }`). */
export interface LoginUi {
  onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => void;
  onPrompt: (message: string, options?: { placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  /** Loopback callback fallback. Redirect URLs and one-time codes are treated as secrets by UIs. */
  onManualCodeInput?: () => Promise<string>;
  onProgress?: (m: string) => void;
  signal?: AbortSignal;
}

export interface AuthDeps {
  getDefinition: (id: string) => {
    login: (cb: LoginCallbacks) => Promise<OAuthCredentials | string>;
    storeCredentialsAs?: string;
  } | undefined;
  getOAuthApiKey: (provider: string, creds: Record<string, OAuthCredentials>) => Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
  /** Refreshes a stored OAuth grant. pi-ai's `getOAuthApiKey` throws on an already-expired credential
   *  rather than refreshing it (refreshing is a separate concern in the library), so `apiKeyFor` calls
   *  this first whenever the stored credential is expired or within the refresh buffer of expiring. */
  refreshOAuthToken: (provider: string, credentials: OAuthCredentials) => Promise<OAuthCredentials>;
  getEnvApiKey: (provider: string) => string | undefined;
  now?: () => number;
  /** Where a non-fatal problem (an unreadable credential file) is reported. Defaults to stderr. */
  onWarn?: (msg: string) => void;
}

/** Shape `AuthStore.login` actually calls `def.login` with: identical fields to `OAuthLoginCallbacks`. */
type LoginCallbacks = OAuthLoginCallbacks;

/** Refresh proactively once a stored credential is within this many ms of `expires`, not only after it has lapsed. */
const REFRESH_BUFFER_MS = 60_000;

// `getProviderDefinition` returns the full `ProviderDefinition` union, whose `login` field is
// optional and typed against the library's own `OAuthLoginCallbacks`/`OAuthCredentials`. That type
// is structurally identical to `LoginCallbacks` here; the cast is local to this adapter so the rest
// of the file works against the narrow `AuthDeps` shape instead of the library's full provider surface.
const defaultDeps: AuthDeps = {
  getDefinition: (id) => {
    const d = getProviderDefinition(id);
    return d?.login ? {
      login: d.login as (cb: LoginCallbacks) => Promise<OAuthCredentials | string>,
      storeCredentialsAs: d.storeCredentialsAs,
    } : undefined;
  },
  // `getOAuthApiKey`/`refreshOAuthToken`'s first parameter is typed as the library's closed
  // `OAuthProvider` union; `AuthStore` deals in arbitrary provider id strings, so the cast is local
  // to these two call sites.
  getOAuthApiKey: (p, c) => getOAuthApiKey(p as Parameters<typeof getOAuthApiKey>[0], c),
  refreshOAuthToken: (p, c) => refreshOAuthToken(p as Parameters<typeof refreshOAuthToken>[0], c),
  getEnvApiKey: (p) => getEnvApiKey(p),
  onWarn: (m) => console.error(m),
};

/** `auth.json` is written with owner-only permissions and must never widen on a rewrite. */
const AUTH_FILE_MODE = 0o600;

function validCredential(provider: string, value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  if (credential.provider !== provider) return false;
  if (credential.type === "api_key") return typeof credential.key === "string" && credential.key.trim().length > 0;
  const optionalStrings = ["enterpriseUrl", "projectId", "email", "accountId", "apiEndpoint", "orgId", "orgName"];
  return credential.type === "oauth" && typeof credential.refresh === "string" && credential.refresh.length > 0
    && typeof credential.access === "string" && credential.access.length > 0
    && typeof credential.expires === "number" && Number.isFinite(credential.expires) && Math.abs(credential.expires) <= 8.64e15
    && optionalStrings.every((key) => credential[key] === undefined || typeof credential[key] === "string")
    && (credential.authorizedAt === undefined || (typeof credential.authorizedAt === "number" && Number.isFinite(credential.authorizedAt)));
}

function abortError(): Error {
  const error = new Error("Login cancelled"); error.name = "AbortError"; return error;
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    work.then((value) => { cleanup(); signal.aborted ? reject(abortError()) : resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export class AuthStore {
  private creds: Record<string, StoredCredential> = {};
  private readonly oauthResolutions = new Map<string, Promise<string | undefined>>();
  private readonly deps: AuthDeps;

  constructor(
    readonly path: string,
    deps: Partial<AuthDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
    // A half-written or hand-edited credential file must not take down every command that
    // constructs an AuthStore: warn once, start empty, and let a later `set`/`login` rewrite it.
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("credential file is not a JSON object");
        const entries = Object.entries(parsed).filter(([provider, credential]) => validCredential(provider, credential));
        this.creds = Object.fromEntries(entries);
        if (entries.length !== Object.keys(parsed).length) this.deps.onWarn?.("kiln: ignoring invalid credential entries");
      } catch (e) {
        this.creds = {};
        this.deps.onWarn?.(`kiln: ignoring unreadable credential file ${path}: ${(e as Error).message}`);
      }
    }
  }

  private save(): void {
    // The mode is applied to the temp file before the rename, so the credential is never
    // world-readable, not even for the instant between write and chmod.
    writeAtomic(this.path, `${JSON.stringify(this.creds, null, 2)}\n`, { mode: AUTH_FILE_MODE });
  }

  providers(): string[] {
    return Object.keys(this.creds).sort();
  }

  get(provider: string): StoredCredential | undefined {
    return this.creds[provider];
  }

  /** Local-only credential discovery. This never refreshes OAuth or touches the network. */
  source(provider: string): StoredCredential["type"] | "env" | "none" {
    return this.creds[provider]?.type ?? (this.deps.getEnvApiKey(provider) ? "env" : "none");
  }

  configuredProviders(providers: readonly string[]): string[] {
    return providers.filter((provider) => this.source(provider) !== "none");
  }

  set(cred: StoredCredential): void {
    this.creds[cred.provider] = cred;
    this.save();
  }

  setApiKey(provider: string, key: string): StoredCredential {
    const value = key.trim();
    if (!value) throw new Error("API key cannot be empty");
    const credential = { type: "api_key", provider, key: value } as const;
    this.set(credential);
    return credential;
  }

  remove(provider: string): void {
    delete this.creds[provider];
    this.save();
  }

  async login(provider: string, ui: LoginUi): Promise<StoredCredential> {
    const def = this.deps.getDefinition(provider);
    if (!def) throw new Error(`no login flow for provider ${provider}`);
    const now = this.deps.now ?? Date.now;
    const active = () => { if (ui.signal?.aborted) throw abortError(); };
    active();
    const result = await abortable(def.login({
      onAuth: (info) => { active(); ui.onAuth(info); },
      onPrompt: (p) => { active(); return ui.onPrompt(p.message, { placeholder: p.placeholder, allowEmpty: p.allowEmpty }); },
      onManualCodeInput: ui.onManualCodeInput ? () => { active(); return ui.onManualCodeInput!(); } : undefined,
      onProgress: (message) => { if (!ui.signal?.aborted) ui.onProgress?.(message); },
      signal: ui.signal,
    }), ui.signal);
    active();
    const storedProvider = def.storeCredentialsAs ?? provider;
    const cred: StoredCredential =
      typeof result === "string"
        ? { type: "api_key", provider: storedProvider, key: result }
        : { type: "oauth", provider: storedProvider, ...result, authorizedAt: result.authorizedAt ?? now() };
    active(); this.set(cred);
    return cred;
  }

  /**
   * Resolution order: `preferApiKeys` + env beats everything; otherwise a stored OAuth credential is
   * refreshed (if expired or within 60s of expiring) and exchanged for an API key, then a stored
   * `api_key` credential, then the env fallback. A failing refresh or exchange never throws out of
   * this method: it's caught, the stored credential is left untouched (not deleted), and resolution
   * falls through to the api_key/env paths below.
   */
  async apiKeyFor(provider: string, opts: { preferApiKeys?: boolean } = {}): Promise<string | undefined> {
    const env = this.deps.getEnvApiKey(provider);
    if (opts.preferApiKeys && env) return env;
    const stored = this.creds[provider];
    if (stored?.type === "oauth") {
      const existing = this.oauthResolutions.get(provider);
      if (existing) return (await existing) ?? env;
      const pending = this.resolveOAuth(provider, stored);
      this.oauthResolutions.set(provider, pending);
      try { return (await pending) ?? env; }
      finally { if (this.oauthResolutions.get(provider) === pending) this.oauthResolutions.delete(provider); }
    }
    if (stored?.type === "api_key") return stored.key;
    return env;
  }

  private async resolveOAuth(provider: string, stored: Extract<StoredCredential, { type: "oauth" }>): Promise<string | undefined> {
    try {
      const { type: _type, provider: _provider, ...rest } = stored;
      let oauth = rest as OAuthCredentials;
      const now = this.deps.now ?? Date.now;
      if (now() >= oauth.expires - REFRESH_BUFFER_MS) {
        oauth = { ...oauth, ...await this.deps.refreshOAuthToken(provider, oauth) };
        this.creds[provider] = { type: "oauth", provider, ...oauth }; this.save();
      }
      const result = await this.deps.getOAuthApiKey(provider, { [provider]: oauth });
      if (!result) return undefined;
      const merged = { ...oauth, ...result.newCredentials };
      this.creds[provider] = { type: "oauth", provider, ...merged }; this.save();
      return result.apiKey;
    } catch {
      // A transient refresh/exchange failure never deletes the durable credential.
      return undefined;
    }
  }
}
