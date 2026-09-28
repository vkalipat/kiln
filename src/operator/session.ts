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

/** Native task/hub share a process-global registry: admit one operator tree per process. */
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
    personality: "none", includeWorkspaceTree: false,
  });
  const authStorage = await AuthStorage.create(":memory:");
  const resolveKey = async (name: string, sessionId?: string, signal?: AbortSignal) => {
    // Auxiliary label/discovery requests have no owning native session. Do not grant them
    // credentials outside the root/child dispatch guards and accounting hooks.
    if (!connectedProviders.includes(name) || !sessionId || !AgentRegistry.global().list().some((ref) => ref.session?.sessionManager.getSessionId() === sessionId)) return undefined;
    signal?.throwIfAborted();
    return raceWithSignal(options.auth.apiKeyFor(name), signal);
  };
  // Native root/child/compaction resolvers all use this same store. Do not import Kiln's OAuth
  // rows into another database or snapshot access tokens that would later become stale.
  authStorage.hasAuth = (name) => connectedProviders.includes(name);
  authStorage.getApiKey = (name, sessionId, request) => resolveKey(name, sessionId, request?.signal);
  let registry: ModelRegistry;
  try {
    registry = new ModelRegistry(authStorage, join(stateDir, "models.yml"), {
      ignoreLocalModelConfig: true, settings, cacheDbPath: join(stateDir, "model-cache.db"),
      ...(options.streamFn ? { fetch: async () => { throw new Error("Provider discovery disabled for injected stream"); } } : {}),
    });
  } catch (error) { authStorage.close(); throw error; }
  registry.getApiKey = (model, sessionId, request) => resolveKey(model.provider, sessionId, request?.signal);
  registry.getApiKeyForProvider = (provider, sessionId, request) => resolveKey(provider, sessionId, request?.signal);
  const hooks: NonNullable<CreateAgentSessionOptions["extensions"]>[number] = (extension) => {
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
