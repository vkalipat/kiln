import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { AgentRegistry, AuthStorage, ModelRegistry, SessionManager, Settings, createAgentSession,
  type AgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult, type ExtensionContext, type MessageEndEvent } from "@oh-my-pi/pi-coding-agent";
import { getBundledModel, type Model } from "@oh-my-pi/pi-catalog";
import type { AgentBeforeModelCall, StreamFn } from "@oh-my-pi/pi-agent-core";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { AuthStore } from "../providers/auth";
import { clampEffort, parseModelRef } from "../providers/models";

export interface OmpSubagentSpawnEvent {
  agent: string;
  invocationKind: "task" | "eval";
  modelRole?: string;
  patterns: string[];
  spawnKey?: string;
  taskName?: string;
  taskText?: string;
  effort?: string;
}

export interface OmpSubagentSpawnResult {
  /** One exact admitted selector; retry chains are deliberately unsupported. */
  model?: string;
  block?: boolean;
  reason?: string;
  note?: string;
}

export interface OmpSessionOptions {
  cwd: string;
  stateDir: string;
  modelRef: string;
  /** Prepared, admitted native role selectors supplied by the operator router. */
  modelRoles?: Record<string, string>;
  effort: string;
  auth: Pick<AuthStore, "apiKeyFor" | "configuredProviders">;
  connectedProviders: readonly string[];
  resumeFile?: string;
  additionalDirectories?: string[];
  allowTaskIsolation?: boolean;
  spawns?: string;
  customTools?: CreateAgentSessionOptions["customTools"];
  extensions?: CreateAgentSessionOptions["extensions"];
  contextFiles?: CreateAgentSessionOptions["contextFiles"];
  systemPrompt?: CreateAgentSessionOptions["systemPrompt"];
  appendSystemPrompt?: string;
  signal?: AbortSignal;
  /** Rebound native extension hooks run in root and spawned sessions. */
  onBeforeModelCall?: (context: ExtensionContext, request: Parameters<AgentBeforeModelCall>[0], signal?: AbortSignal) => boolean | void | Promise<boolean | void>;
  onModelMessage?: (event: MessageEndEvent, context: ExtensionContext) => void | Promise<void>;
  beforeSubagentSpawn?: (event: OmpSubagentSpawnEvent, context: ExtensionContext) => OmpSubagentSpawnResult | void | Promise<OmpSubagentSpawnResult | void>;
  /** Recover a reserved assignment only when synchronous native task failed without a running child. */
  onTaskDispatchFailure?: (names: string[], context: ExtensionContext) => void | Promise<void>;
  onBeforeCompact?: (context: ExtensionContext) => boolean | void | Promise<boolean | void>;
  onExtensionError?: (message: string) => void;
  /** Test/embedding seams: supplied model and stream must still use the explicit selector. */
  model?: Model;
  /** Root-only test stream. Production tree metering uses the inherited extension hooks. */
  streamFn?: StreamFn;
  factory?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

export interface OmpSessionHandle {
  session: AgentSession;
  sessionId: string;
  sessionFile: string;
  connectedProviders: readonly string[];
  sdk: CreateAgentSessionResult;
  awaitSettled(): Promise<void>;
  dispose(): Promise<void>;
}

type OperatorKeyResolver = (provider: string, sessionId?: string, signal?: AbortSignal) => Promise<string | undefined>;
type KeyRequest = { signal?: AbortSignal };

/**
 * AuthStorage 18.1 flat API and 18.4 KeysApi share the same host-owned resolver.
 * Availability is metadata only; discovery never receives a bearer. This adapter
 * never installs runtime keys, OAuth rows, or fabricated stored credential IDs.
 */
export function installOperatorAuthStorage(storage: unknown, providers: readonly string[], resolve: OperatorKeyResolver): "flat" | "namespaced" {
  if (!storage || typeof storage !== "object") throw new Error("Unsupported native auth storage");
  const target = storage as Record<string, unknown>;
  const admitted = new Set(providers);
  const get = (provider: string, sessionId?: string, request?: KeyRequest) => {
    if (!admitted.has(provider) || !sessionId) return Promise.resolve(undefined);
    request?.signal?.throwIfAborted();
    return resolve(provider, sessionId, request?.signal);
  };
  const getWithCredential = async (provider: string, sessionId?: string, request?: KeyRequest) => {
    const apiKey = await get(provider, sessionId, request);
    request?.signal?.throwIfAborted();
    return apiKey === undefined ? undefined : { apiKey };
  };
  const keys = target.keys;
  if (keys !== undefined) {
    if (!keys || typeof keys !== "object") throw new Error("Unsupported native auth keys namespace");
    const port = keys as Record<string, unknown>;
    for (const method of ["get", "getWithCredential", "peek", "source", "keyless"]) {
      if (typeof port[method] !== "function") throw new Error(`Native auth keys is missing ${method}`);
    }
    port.get = get;
    port.getWithCredential = getWithCredential;
    port.peek = async () => undefined;
    port.source = (provider: string) => admitted.has(provider) ? { kind: "runtime", concrete: true } : undefined;
    port.keyless = () => false;
    if (typeof target.getApiKey === "function") target.getApiKey = get;
    return "namespaced";
  }
  for (const method of ["hasAuth", "hasResolvableAuth", "hasConcreteAuth", "getApiKey", "peekApiKey"]) {
    if (typeof target[method] !== "function") throw new Error(`Native auth storage is missing ${method}`);
  }
  target.hasAuth = target.hasResolvableAuth = target.hasConcreteAuth = (provider: string) => admitted.has(provider);
  target.getApiKey = get;
  target.peekApiKey = async () => undefined;
  return "flat";
}

let active = false;
/** Switch the calling native session without weakening credential ownership for auxiliary work. */
export async function switchOmpSessionModel(ctx: ExtensionContext, model: Model, effort?: string): Promise<void> {
  const id = ctx.sessionManager.getSessionId();
  const session = AgentRegistry.global().list().find((ref) => ref.session?.sessionManager.getSessionId() === id)?.session;
  if (!session) throw new Error("Calling native session is not live");
  if (!await ctx.modelRegistry.getApiKey(model, id)) throw new Error("No owned credentials for selected model");
  await session.setModel(model);
  if (effort !== undefined) session.setThinkingLevel(clampEffort(model, effort) as CreateAgentSessionOptions["thinkingLevel"]);
}

/** Native agents share a process-global registry: admit one operator tree per process. */
export async function createOmpSession(options: OmpSessionOptions): Promise<OmpSessionHandle> {
  if (active) throw new Error("An operator session is already active in this process; dispose it before opening another");
  active = true;
  try {
    const handle = await buildOmpSession(options);
    const dispose = handle.dispose;
    let released = false;
    handle.dispose = async () => { try { await dispose(); } finally { if (!released) { released = true; active = false; } } };
    return handle;
  } catch (error) { active = false; throw error; }
}

/** Embeds the native coding session, not a second agent loop. Credentials stay in Kiln's resolver. */
async function buildOmpSession(options: OmpSessionOptions): Promise<OmpSessionHandle> {
  options.signal?.throwIfAborted();
  const cwd = realpathSync(options.cwd);
  // Native task discovery permits local definitions to shadow the bundled generic worker.
  // Without explicit persona opt-in, fail clearly rather than silently changing its behavior.
  if (!options.spawns) {
    const agentDirs = [join(homedir(), ".omp", "agent", "agents")];
    for (let dir = cwd; ; dir = dirname(dir)) {
      agentDirs.push(join(dir, ".omp", "agents"));
      if (dirname(dir) === dir) break;
    }
    if (agentDirs.some((dir) => existsSync(join(dir, "task.md")))) throw new Error("A local task persona shadows OMP's generic worker; explicitly select allowed spawns before starting");
  }
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(options.stateDir);
  const { provider, modelId } = parseModelRef(options.modelRef);
  const model = options.model ?? getBundledModel(provider as never, modelId);
  if (!model || model.provider !== provider || model.id !== modelId) throw new Error(`Unknown or mismatched explicit model: ${options.modelRef}`);
  const connectedProviders = options.auth.configuredProviders(options.connectedProviders);
  if (!connectedProviders.includes(provider)) throw new Error(`No connected credentials for ${provider}`);
  const settings = Settings.isolated({
    "task.isolation.enabled": options.allowTaskIsolation === true,
    "worktree.cleanSource": false, "autolearn.enabled": false, "title.refreshOnReplan": false,
    "advisor.enabled": false, "memory.backend": "off",
    // Auxiliary tiny-model calls bypass normal AgentSession dispatch metering.
    "edit.autoRepair.enabled": false, "features.unexpectedStopDetection": "mechanical", "speech.enhanced": false,
    defaultThinkingLevel: clampEffort(model, options.effort) ?? "high",
    modelRoles: options.modelRoles ?? {}, "task.enableEffort": true, "task.prewalk": false,
    ...(options.beforeSubagentSpawn ? { "task.speculativeLaunch": false } : {}),
    personality: "none", includeWorkspaceTree: false,
  });
  const authStorage = await AuthStorage.create(":memory:");
  const resolveKey = async (name: string, sessionId?: string, signal?: AbortSignal) => {
    // Auxiliary label/discovery requests have no owning native session. Do not grant them
    // credentials outside the root/child dispatch guards and accounting hooks.
    if (!connectedProviders.includes(name) || !sessionId || !AgentRegistry.global().list().some((ref) => ref.session?.sessionManager.getSessionId() === sessionId)) return undefined;
    const scoped = options.signal && signal ? AbortSignal.any([options.signal, signal]) : options.signal ?? signal;
    scoped?.throwIfAborted();
    const key = await raceWithSignal(options.auth.apiKeyFor(name), scoped);
    scoped?.throwIfAborted();
    // A session that disappeared while host OAuth refreshed no longer owns dispatch.
    return AgentRegistry.global().list().some((ref) => ref.session?.sessionManager.getSessionId() === sessionId) ? key : undefined;
  };
  // Native root/child/compaction resolvers all use this same store. Do not import Kiln's OAuth
  // rows into another database or snapshot access tokens that would later become stale.
  try { installOperatorAuthStorage(authStorage, connectedProviders, resolveKey); }
  catch (error) { authStorage.close(); throw error; }
  let registry: ModelRegistry;
  try {
    registry = new ModelRegistry(authStorage, join(stateDir, "models.yml"), {
      ignoreLocalModelConfig: true, settings, cacheDbPath: join(stateDir, "model-cache.db"),
      ...(options.streamFn ? { fetch: async () => { throw new Error("Provider discovery disabled for injected stream"); } } : {}),
    });
  } catch (error) { authStorage.close(); throw error; }
  registry.getApiKey = (model, sessionId, request) => resolveKey(model.provider, sessionId, request?.signal);
  registry.getApiKeyForProvider = (provider, sessionId, request) => resolveKey(provider, sessionId, request?.signal);
  // 18.4 retries can resolve credentials through this richer facade directly.
  if ("getApiKeyWithCredentialForProvider" in registry) {
    if (typeof registry.getApiKeyWithCredentialForProvider !== "function") { authStorage.close(); throw new Error("Unsupported native credential resolver"); }
    registry.getApiKeyWithCredentialForProvider = async (provider: string, sessionId?: string, request?: KeyRequest) => {
      const apiKey = await resolveKey(provider, sessionId, request?.signal);
      options.signal?.throwIfAborted();
      request?.signal?.throwIfAborted();
      return apiKey === undefined ? undefined : { apiKey };
    };
  }
  const hooks: NonNullable<CreateAgentSessionOptions["extensions"]>[number] = (extension) => {
    // Each rebound extension owns one parent session's pending dispatches.
    // Match identities, never consume a global next-worker queue.
    const dispatchedTasks = new Map<string, { name: string; spawnKey?: string }>();
    const pendingTasks = new Map<string, { name: string; taskText?: string; effort?: string }>();
    extension.on("tool_execution_start", (event) => {
      if (!options.beforeSubagentSpawn || event.toolName !== "task" || !event.args || typeof event.args !== "object") return;
      const input = event.args as Record<string, unknown>;
      const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
      tasks.forEach((raw, index) => {
        if (!raw || typeof raw !== "object") return;
        const task = raw as Record<string, unknown>;
        if (typeof task.name !== "string") return;
        pendingTasks.set(`${event.toolCallId}:${index}`, {
          name: task.name,
          taskText: typeof task.task === "string" ? task.task : undefined,
          effort: typeof task.effort === "string" ? task.effort : typeof input.effort === "string" ? input.effort : undefined,
        });
      });
    });
    extension.on("tool_execution_end", async (event, ctx) => {
      const prefix = `${event.toolCallId}:`;
      for (const id of pendingTasks.keys()) if (id.startsWith(prefix)) pendingTasks.delete(id);
      const dispatched = [...dispatchedTasks.entries()].filter(([id]) => id.startsWith(prefix));
      for (const [id] of dispatched) dispatchedTasks.delete(id);
      if (!options.onTaskDispatchFailure || !dispatched.length) return;
      const result = event.result as { details?: { async?: unknown; results?: { index?: number; exitCode?: number; error?: unknown; aborted?: boolean }[] } } | undefined;
      // Background jobs settle after the tool returns; never release their reservations here.
      if (result?.details?.async || !Array.isArray(result?.details?.results)) return;
      const results = result.details.results;
      const failed = dispatched.filter(([id, task]) => {
        const index = Number(id.slice(prefix.length));
        const child = results.find(item => item.index === index || (item.index === undefined && dispatched.length === 1));
        if (child && child.exitCode === 0 && !child.error && !child.aborted) return false;
        // The tool has settled, but a still-running native session always prevents retry.
        return !AgentRegistry.global().list().some(ref => ref.session && ref.status === "running" &&
          (ref.id === task.spawnKey || ref.id === task.name || ref.id.endsWith(`.${task.name}`) || ref.id.startsWith(`${task.name}-`)));
      }).map(([, task]) => task.name);
      if (failed.length) await options.onTaskDispatchFailure(failed, ctx);
    });
    extension.on("before_subagent_spawn", async (event, ctx) => {
      if (!options.beforeSubagentSpawn) return;
      const key = event.spawnKey;
      // Native allocated IDs add a parent prefix and a numeric collision suffix.
      const localKey = key?.split(".").at(-1);
      const matches = [...pendingTasks.entries()].filter(([id, task]) => {
        if (id === key || task.name === key || task.name === localKey) return true;
        const suffix = localKey?.startsWith(`${task.name}-`) ? localKey.slice(task.name.length + 1) : "";
        return /^[2-9]\d*$|^1\d+$/.test(suffix ?? "");
      });
      if (matches.length > 1) return { block: true, reason: "Ambiguous native task assignment identity." };
      const match = matches[0];
      if (match) pendingTasks.delete(match[0]);
      try {
        options.signal?.throwIfAborted();
        const result = await options.beforeSubagentSpawn({ ...event,
          ...(match ? { taskName: match[1].name, taskText: match[1].taskText, effort: match[1].effort } : {}),
        }, ctx);
        if (match && result?.model && !result.block) dispatchedTasks.set(match[0], { name: match[1].name, spawnKey: key });
        return result;
      } catch {
        return { block: true, reason: "Kiln subagent dispatch guard failed." };
      }
    });
    let abortListener: (() => void) | undefined;
    let removeGate: (() => void) | undefined;
    extension.on("session_start", async (_event, ctx) => {
      if (!extension.getSessionName()) await extension.setSessionName("Kiln worker");
      const native = AgentRegistry.global().list().find((ref) => ref.session?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId())?.session;
      if (!native) throw new Error("Native session is missing from the operator registry");
      removeGate?.();
      removeGate = native.agent.addBeforeModelCall(async (_context, signal) => {
        try {
          if (options.signal?.aborted || signal?.aborted || await options.onBeforeModelCall?.(ctx, _context, signal) === false) return { stop: true, reason: "kiln operator dispatch stopped" };
        } catch { return { stop: true, reason: "kiln operator dispatch guard failed" }; }
        return undefined;
      });
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      abortListener = () => ctx.abort();
      options.signal?.addEventListener("abort", abortListener, { once: true });
      if (options.signal?.aborted) ctx.abort();
    });
    extension.on("session_shutdown", () => { removeGate?.(); if (abortListener) options.signal?.removeEventListener("abort", abortListener); });
    extension.on("message_end", (event, ctx) => options.onModelMessage?.(event, ctx));
    extension.on("session_before_compact", async (_event, ctx) => {
      try { if (options.signal?.aborted || await options.onBeforeCompact?.(ctx) === false) return { cancel: true }; }
      catch { return { cancel: true }; }
    });
    extension.on("tool_call", (event) => {
      const input = event.input as Record<string, unknown>;
      const isolated = input.isolated === true || (Array.isArray(input.tasks) && input.tasks.some((task) => task && typeof task === "object" && task.isolated === true));
      if (!options.allowTaskIsolation && event.toolName === "task" && isolated) {
        return { block: true, reason: "Task isolation was not authorized for this operator session." };
      }
    });
  };
  let session: AgentSession | undefined;
  let manager: SessionManager | undefined;
  try {
    const sessionsDir = join(stateDir, "sessions");
    if (options.resumeFile) {
      const file = realpathSync(options.resumeFile);
      const rel = relative(stateDir, file);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Resume file must belong to the operator state directory");
      manager = await SessionManager.open(file, sessionsDir, undefined, { initialCwd: cwd, suppressBreadcrumb: true });
      if (realpathSync(manager.getCwd()) !== cwd) throw new Error("Resume working directory differs from the requested scope");
    } else manager = SessionManager.create(cwd, sessionsDir);
    await manager.ensureOnDisk();
    if (!manager.getSessionName()) await manager.setSessionName("Kiln", "user");
    const sdk = await (options.factory ?? createAgentSession)({
      cwd, agentDir: stateDir, sessionManager: manager, authStorage, modelRegistry: registry, settings,
      model, thinkingLevel: clampEffort(model, options.effort) as CreateAgentSessionOptions["thinkingLevel"], rebindModelAfterDiscovery: false,
      agentRegistry: AgentRegistry.global(),
      additionalDirectories: options.additionalDirectories?.map((path) => realpathSync(resolve(cwd, path))),
      spawns: options.spawns ?? "task", customTools: options.customTools, extensions: [hooks, ...(options.extensions ?? [])],
      systemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt, contextFiles: options.contextFiles,
      skills: [], rules: [], promptTemplates: [], slashCommands: [],
      disableExtensionDiscovery: true, preloadedExtensionPaths: [], preloadedCustomToolPaths: [],
      enableMCP: false, enableLsp: false, enableIrc: true, skipPythonPreflight: true,
      // Amp-style UI attaches after construction; defer online discovery until explicitly started.
      hasUI: true, interactivePrompts: false, autoApprove: false,
    });
    session = sdk.session;
    // SDK embedding owns root initialization; native task executor emits this for each child.
    const startupErrors: string[] = [];
    let initializing = true;
    const reportError = (message: string) => { if (initializing) startupErrors.push(message); else options.onExtensionError?.(message); };
    await initializeExtensions(session, { mode: "tui",
      reportSendError: (_action, error) => reportError(error.message),
      reportRuntimeError: (error) => reportError(error.error),
    });
    initializing = false;
    if (startupErrors.length) throw new Error(`Operator extension startup failed: ${startupErrors.join("; ")}`);
    if (!options.spawns) {
      const discovered = await discoverAgents(cwd, homedir(), { mode: "explicit-only", explicit: [], configured: [], configuredLevel: "user" });
      if (discovered.agents.find((agent) => agent.name === "task")?.source !== "bundled") {
        throw new Error("A discovered persona shadows OMP's generic task worker; explicitly select allowed spawns before starting");
      }
    }
    if (options.streamFn) session.agent.streamFn = options.streamFn;
    let disposed: Promise<void> | undefined;
    return { session, sdk, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, connectedProviders,
      awaitSettled: async () => {
        await sdk.session.waitForIdle();
        while (sdk.session.hasPendingAsyncWork()) await sdk.session.settleAsyncWork();
        await sdk.session.waitForIdle();
      },
      dispose: () => disposed ??= (async () => { try { await sdk.session.dispose(); } finally { authStorage.close(); } })(),
    };
  } catch (error) {
    try { if (session) await session.dispose(); else await manager?.close(); } finally { authStorage.close(); }
    throw error;
  }
}
