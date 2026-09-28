import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CliDeps } from "../cli/main";
import { kilnHome } from "../core/paths";
import { redactValue } from "../core/secrets";
import type { OperatorEvent, OperatorRuntime, createOperatorRuntime } from "../operator/runtime";
import type { TuiCheckpointAnswer, TuiConfigEffort, TuiControllerPort, TuiEvent, TuiEventListener, TuiSendResult, TuiSnapshot } from "./contracts";
import { RunController, type TuiCli } from "./controller";
import { ControllerTranscript, type TranscriptChange } from "./controller-transcript";
import { fromConfigEffort } from "./dial";
import { localIntakeReply } from "./intake";

type RuntimeFactory = typeof createOperatorRuntime;
export interface OperatorControllerOptions {
  home?: string;
  cwd?: string;
  branch?: string;
  cli?: TuiCli;
  cliDeps?: CliDeps;
  /** Offline adapter seams; production uses the persistent operator and existing CLI auth. */
  createRuntime?: RuntimeFactory;
  legacyController?: TuiControllerPort;
}

/** Presentation adapter only: the operator owns its session, tools, task hub and persistence. */
export class OperatorController implements TuiControllerPort {
  readonly home: string;
  #cwd: string;
  get cwd(): string { return this.#cwd; }
  readonly #legacy: TuiControllerPort;
  readonly #factory: RuntimeFactory;
  readonly #listeners = new Set<TuiEventListener>();
  readonly #transcript = new ControllerTranscript();
  readonly #unsubscribeLegacy: () => void;
  #snapshot: TuiSnapshot;
  #runtime?: OperatorRuntime;
  #active?: Promise<void>;
  #legacyActive?: Promise<void>;
  #auxiliary = false;
  #inputPending = false;
  #legacyMode = false;
  #restoring = false;
  #cancelRequested = false;
  #disposed = false;
  #nextSendId = 0;
  #generation = 0;
  #pending: Array<{ sendId: string; text: string }> = [];
  #pendingEffort?: TuiConfigEffort;
  #question?: { resolve: (value: string) => void; reject: (reason: Error) => void };

  constructor(options: OperatorControllerOptions = {}) {
    this.home = options.home ?? kilnHome();
    this.#cwd = resolve(options.cwd ?? process.cwd());
    this.#legacy = options.legacyController ?? new RunController({ home: this.home, branch: options.branch, cli: options.cli, cliDeps: options.cliDeps });
    this.#factory = options.createRuntime ?? (async (input) => (await import("../operator/runtime")).createOperatorRuntime(input));
    this.#snapshot = { ...this.#legacy.getSnapshot(), mode: "operator", directory: this.cwd, transcript: [] };
    this.#unsubscribeLegacy = this.#legacy.subscribe((event) => this.#legacyEvent(event));
  }

  getSnapshot(): Readonly<TuiSnapshot> { return this.#legacyMode ? this.#legacy.getSnapshot() : this.#snapshot; }
  subscribe(listener: TuiEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  async start(input: { seed?: string; runId?: string }): Promise<void> {
    if ((input.seed === undefined) === (input.runId === undefined)) throw new Error("start requires exactly one of seed or runId");
    if (input.runId !== undefined) return this.resume(input.runId);
    if (this.#legacyMode) return this.#runLegacy(() => this.#legacy.start(input));
    this.#assertAvailable();
    const text = input.seed!;
    if (!text.trim()) throw new Error("a message is required");
    if (this.#active) { await this.send(text); return; }
    const reply = localIntakeReply(text);
    if (!this.#runtime && reply) {
      this.#change({ type: "text", entry: this.#transcript.appendUser(text) });
      this.#change({ type: "text", entry: this.#transcript.appendBrain(reply) });
      return;
    }
    this.#requireAuth();
    this.#change({ type: "text", entry: this.#transcript.appendUser(text) });
    return this.#begin(text);
  }

  async resume(runId: string): Promise<void> {
    this.#assertAvailable();
    if (this.#active) throw new Error("an operator turn is already active");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("invalid run id");
    if (!existsSync(join(this.home, "runs", runId, "operator.json"))) {
      this.#auxiliary = true;
      try { if (this.#runtime) { await this.#runtime.dispose(); this.#runtime = undefined; } }
      finally { this.#auxiliary = false; }
      this.#legacyMode = true;
      return this.#runLegacy(() => this.#legacy.resume(runId));
    }
    this.#requireAuth();
    const metadata = JSON.parse(readFileSync(join(this.home, "runs", runId, "operator.json"), "utf8"));
    if (metadata?.version !== 1 || metadata.engine !== "omp" || typeof metadata.cwd !== "string"
      || !isAbsolute(metadata.cwd) || metadata.cwd.includes("\0")) throw new Error("invalid saved operator working directory");
    const launchCwd = this.#cwd;
    this.#cwd = metadata.cwd;
    this.#legacyMode = false;
    this.#generation++;
    this.#transcript.restore([]);
    this.#cancelRequested = false;
    this.#restoring = true;
    this.#update({ state: "running", activity: "Restoring session", routing: undefined, auth: this.#legacy.getSnapshot().auth });
    const previous = this.#runtime;
    this.#runtime = undefined;
    const restoring = Promise.resolve().then(async () => {
      await previous?.dispose();
      this.#runtime = await this.#factory({ home: this.home, cwd: this.cwd, runId, onEvent: (event) => this.#operatorEvent(event), ask: (prompt) => this.#ask(prompt) });
      if (this.#cancelRequested) await this.#runtime.cancel();
    }).catch((error) => {
      this.#cwd = launchCwd;
      this.#update({ state: "failed", activity: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => {
      this.#active = undefined;
      this.#restoring = false;
      for (const change of this.#transcript.finalize(this.#cancelRequested)) this.#change(change);
      if (this.#snapshot.state !== "failed") this.#update({ state: this.#cancelRequested ? "paused" : "idle", activity: this.#cancelRequested ? "State saved" : "Session restored" });
    });
    this.#active = restoring;
    return restoring;
  }

  async send(text: string): Promise<TuiSendResult> {
    if (this.#legacyMode || (this.#auxiliary && this.#inputPending)) return this.#legacy.send(text);
    this.#assertAvailable();
    const value = text;
    if (!value.trim()) throw new Error("a message is required");
    if (this.#question) {
      const question = this.#question;
      this.#question = undefined;
      this.#change({ type: "text", entry: this.#transcript.appendUser(value) });
      this.#emit({ type: "input_cleared" });
      question.resolve(value);
      return { status: "answered" };
    }
    // A native idle event can precede the prompt promise's final persistence microtask.
    if (this.#active && (this.#restoring || this.#snapshot.state !== "running")) {
      await this.#active.catch(() => {});
      if (this.#cancelRequested) throw new Error("the operator was paused before this message was sent");
    }
    if (!this.#active) { await this.start({ seed: value }); return { status: "delivered", sourceIds: [this.#runtime?.run.id ?? "local"] }; }
    if (this.#cancelRequested) throw new Error("the operator is saving state; wait before sending");
    this.#change({ type: "text", entry: this.#transcript.appendUser(value) });
    if (this.#runtime) {
      const delivered = await this.#runtime.steer(value);
      // The persistent runtime owns queued delivery; no fixed-phase session is launched.
      return { status: "delivered", sourceIds: delivered.sourceIds };
    }
    const sendId = `operator-send:${++this.#nextSendId}`;
    this.#pending.push({ sendId, text: value });
    return { status: "queued", sendId };
  }

  async cancel(): Promise<void> {
    if (this.#legacyMode || this.#auxiliary) { await this.#legacy.cancel(); return; }
    const active = this.#active;
    if (!active) return;
    this.#cancelRequested = true;
    this.#rejectQuestion("Operator paused before the question was answered");
    this.#update({ activity: "Saving state" });
    if (this.#runtime) await this.#runtime.cancel();
    await active;
  }

  async setEffort(effort: TuiConfigEffort): Promise<void> {
    if (this.#legacyMode) return this.#legacy.setEffort(effort);
    this.#pendingEffort = effort;
    if (this.#runtime && !this.#active) await this.#runtime.setEffort(effort);
    else if (!this.#runtime && !this.#active) await this.#legacy.setEffort(effort);
    this.#update({ effort: fromConfigEffort(effort), ...(this.#active ? { activity: "Effort queued for the next turn" } : {}) });
  }

  async answerCheckpoint(answer: TuiCheckpointAnswer): Promise<void> {
    if (this.#legacyMode) return this.#legacy.answerCheckpoint(answer);
    throw new Error("there is no legacy checkpoint in this operator session");
  }

  async execute(commandId: string, args: readonly string[] = []): Promise<void> {
    if (this.#legacyMode) {
      if (commandId === "build: pause") return this.#legacy.execute?.(commandId, args);
      return this.#runLegacy(async () => { await this.#legacy.execute?.(commandId, args); });
    }
    if (commandId === "build: pause") return this.cancel();
    if (commandId === "run: resume") {
      if (args.length !== 1) throw new Error("run: resume requires one run id");
      return this.resume(args[0]!);
    }
    if (commandId === "run: new") return this.start({ seed: args.join(" ") });
    this.#assertAvailable();
    if (this.#active) throw new Error("an operator turn is already active; pause before changing settings");
    this.#auxiliary = true;
    try { await this.#legacy.execute?.(commandId, args); }
    finally {
      this.#auxiliary = false;
      const local = this.#legacy.getSnapshot();
      this.#update({ auth: local.auth, effort: local.effort });
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try { await this.cancel(); }
    finally {
      try { await this.#runtime?.dispose(); }
      finally { this.#unsubscribeLegacy(); this.#listeners.clear(); this.#disposed = true; }
    }
  }

  #begin(text: string): Promise<void> {
    this.#generation++;
    this.#cancelRequested = false;
    this.#update({ state: "running", activity: "Working" });
    const work = Promise.resolve().then(async () => {
      this.#runtime ??= await this.#factory({ home: this.home, cwd: this.cwd, seed: text, onEvent: (event) => this.#operatorEvent(event), ask: (prompt) => this.#ask(prompt) });
      this.#update({ runId: this.#runtime.run.id });
      if (this.#cancelRequested) { await this.#runtime.cancel(); return; }
      if (this.#pendingEffort) { await this.#runtime.setEffort(this.#pendingEffort); this.#pendingEffort = undefined; }
      const response = this.#runtime.prompt(text);
      const delivery = (async () => {
        for (const pending of this.#pending.splice(0)) {
          const result = await this.#runtime!.steer(pending.text);
          this.#emit({ type: "steering_delivered", ...pending, sourceIds: result.sourceIds });
        }
      })();
      // Failed steering must not detach a still-running operator turn from shutdown/drain.
      const outcomes = await Promise.allSettled([response, delivery]);
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    }).catch((error) => {
      if (this.#cancelRequested) return;
      this.#update({ state: "failed", activity: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => {
      this.#rejectQuestion("The operator turn ended before the question was answered");
      for (const change of this.#transcript.finalize(this.#cancelRequested)) this.#change(change);
      this.#pending = [];
      this.#active = undefined;
      if (this.#cancelRequested) {
        this.#update({ state: "paused", activity: "State saved" });
        this.#emit({ type: "cancelled", phase: this.#snapshot.phase });
      } else if (this.#snapshot.state === "running") this.#update({ state: "idle", activity: "Ready" });
    });
    this.#active = work;
    return work;
  }

  #operatorEvent(raw: OperatorEvent): void {
    const event = redactValue(raw);
    if (event.type === "run") { this.#update({ runId: event.run.id }); return; }
    if (event.type === "status") { this.#update({ state: event.state, activity: event.activity, costUsd: event.costUsd }); return; }
    if (event.type === "routing") {
      if (!event.handoff && event.scope === "operator") {
        this.#update({ routing: { kind: event.kind, modelRef: event.modelRef, effort: event.effort } });
      }
      const label = event.handoff ? "Reviewer recommended; handoff pending" : `${event.scope === "worker" ? "Worker" : "Operator"} route`;
      const effort = event.effort ? ` · ${event.effort}` : "";
      this.#change({ type: "text", entry: this.#transcript.appendBrain(`${label}: ${event.kind} · ${event.modelRef}${effort}\n${event.reason}`) });
      return;
    }
    if (event.type === "usage") { this.#update({ costUsd: event.costUsd }); return; }
    this.#change(this.#transcript.consume({ ...event, sourceId: `${this.#generation}:${event.sourceId}`, role: "brain", phase: this.#snapshot.phase }));
  }

  #legacyEvent(event: TuiEvent): void {
    if (this.#legacyMode) { this.#emit(event); return; }
    if (event.type === "input_requested") this.#inputPending = true;
    if (event.type === "input_cleared") this.#inputPending = false;
    if (event.type === "text" || event.type === "tool") {
      const entry = { ...event.entry, id: `aux:${event.entry.id}` };
      const entries = [...this.#transcript.entries];
      const at = entries.findIndex((item) => item.id === entry.id);
      if (at < 0) entries.push(entry); else entries[at] = entry;
      this.#transcript.restore(entries);
      this.#update({});
      this.#emit({ ...event, entry } as TuiEvent);
    } else if (event.type === "snapshot" && !this.#auxiliary) this.#update({ auth: event.snapshot.auth, effort: event.snapshot.effort });
    else if (event.type === "input_requested" || event.type === "input_cleared") this.#emit(event);
  }

  #runLegacy(invoke: () => Promise<void>): Promise<void> {
    if (this.#legacyActive) throw new Error("a legacy controller invocation is already active");
    const work = invoke();
    this.#legacyActive = work;
    return work.finally(() => { if (this.#legacyActive === work) this.#legacyActive = undefined; });
  }
  #requireAuth(): void { if (this.getSnapshot().auth?.required) throw new Error("Connect a provider to start; your prompt can be submitted after login."); }
  #ask(prompt: string): Promise<string> {
    if (this.#cancelRequested || this.#disposed) return Promise.reject(new Error("Operator is paused"));
    if (this.#question) return Promise.reject(new Error("Another operator question is already pending"));
    const answer = new Promise<string>((resolve, reject) => { this.#question = { resolve, reject }; });
    this.#change({ type: "text", entry: this.#transcript.appendBrain(prompt) });
    this.#emit({ type: "input_requested", prompt, secret: false });
    return answer;
  }
  #rejectQuestion(message: string): void {
    const question = this.#question;
    if (!question) return;
    this.#question = undefined;
    this.#emit({ type: "input_cleared" });
    question.reject(new Error(message));
  }
  #assertAvailable(): void {
    if (this.#disposed) throw new Error("operator controller is disposed");
    if (this.#auxiliary) throw new Error("a controller command is already active");
    if (this.#legacyActive) throw new Error("a legacy controller invocation is already active");
  }
  #change(change: TranscriptChange): void { this.#update({}); this.#emit(change); }
  #update(patch: Partial<TuiSnapshot>): void {
    this.#snapshot = redactValue({ ...this.#snapshot, ...patch, mode: "operator", directory: this.cwd, transcript: [...this.#transcript.entries] });
    this.#emit({ type: "snapshot", snapshot: this.#snapshot });
  }
  #emit(event: TuiEvent): void {
    const safe = redactValue(event);
    for (const listener of this.#listeners) { try { listener(safe); } catch { /* Observers cannot interrupt owned work. */ } }
  }
}
