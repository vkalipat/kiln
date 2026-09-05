import { AsyncLocalStorage } from "node:async_hooks";
import type { Phase, Role } from "./config";

interface RunEventBase {
  sourceId: string;
  role: Role;
  phase: Phase;
}

export type RunControlEvent =
  | (RunEventBase & { type: "text"; text: string })
  | (RunEventBase & { type: "tool_start"; toolCallId: string; name: string; args: unknown })
  | (RunEventBase & { type: "tool_end"; toolCallId: string; name: string; ok: boolean; text?: string });

export type RunControlListener = (event: RunControlEvent) => void;

/** Cancellation is control flow, not a successful or provider-error brain result. */
export class RunCancelledError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "run cancelled");
    this.name = "RunCancelledError";
    this.reason = reason;
  }
}

export function throwIfRunCancelled(signal = currentRunControl()?.signal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof RunCancelledError) throw signal.reason;
  throw new RunCancelledError(signal.reason);
}

/** Preserves a direct cancellation error as well as cancellation signalled through ambient control. */
export function rethrowIfRunCancelled(error: unknown, signal = currentRunControl()?.signal): void {
  if (error instanceof RunCancelledError) throw error;
  throwIfRunCancelled(signal);
}

export interface RunSourceRegistration {
  readonly sourceId: string;
  text(text: string): void;
  toolStart(toolCallId: string, name: string, args: unknown): void;
  toolEnd(toolCallId: string, name: string, ok: boolean, text?: string): void;
  dispose(): void;
}

interface RunSource {
  role: Role;
  phase: Phase;
  steer?: (text: string) => void;
}

const storage = new AsyncLocalStorage<RunControl>();
const STEERABLE_ROLES = new Set<Role>(["brain", "builder"]);

/** A UI-neutral cancellation, observation, and live-steering boundary for one run. */
export class RunControl {
  readonly #abort = new AbortController();
  readonly #listeners = new Set<RunControlListener>();
  readonly #sources = new Map<string, RunSource>();
  #nextSource = 0;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  subscribe(listener: RunControlListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  cancel(reason?: unknown): void {
    if (!this.signal.aborted) this.#abort.abort(reason instanceof RunCancelledError ? reason : new RunCancelledError(reason));
  }

  /** Steers every eligible active producer, or one explicitly correlated source. */
  steer(text: string, sourceId?: string): readonly string[] {
    if (this.signal.aborted) return [];
    const steered: string[] = [];
    for (const [id, source] of this.#sources) {
      if (sourceId !== undefined && id !== sourceId) continue;
      if (!source.steer) continue;
      source.steer(text);
      steered.push(id);
    }
    return steered;
  }

  /** @internal Used by execution adapters; UI clients should subscribe/cancel/steer. */
  registerSource(source: RunSource): RunSourceRegistration {
    const sourceId = `${source.phase}:${source.role}:${++this.#nextSource}`;
    this.#sources.set(sourceId, STEERABLE_ROLES.has(source.role) ? source : { ...source, steer: undefined });
    let active = true;
    const emit = (event: RunControlEvent) => {
      if (!active) return;
      for (const listener of [...this.#listeners]) listener(event);
    };
    const base = { sourceId, role: source.role, phase: source.phase };
    return {
      sourceId,
      text: (text) => emit({ ...base, type: "text", text }),
      toolStart: (toolCallId, name, args) => emit({ ...base, type: "tool_start", toolCallId, name, args }),
      toolEnd: (toolCallId, name, ok, text) => emit({ ...base, type: "tool_end", toolCallId, name, ok, ...(text === undefined ? {} : { text }) }),
      dispose: () => {
        if (!active) return;
        active = false;
        this.#sources.delete(sourceId);
      },
    };
  }
}

/** Runs a complete async call tree under one control without plumbing it through every phase. */
export function withRunControl<T>(control: RunControl, fn: () => T): T {
  return storage.run(control, fn);
}

export function currentRunControl(): RunControl | undefined {
  return storage.getStore();
}
