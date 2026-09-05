import type { CliDeps, CliIo } from "../cli/main";
import { main } from "../cli/main";
import { loadConfig, saveConfig } from "../core/config";
import { classifyFailure } from "../core/failure";
import { initHome } from "../core/home";
import { kilnHome } from "../core/paths";
import { localAuthState } from "../onboarding/auth";
import { RunRecord } from "../core/record";
import { RunCancelledError, RunControl, throwIfRunCancelled, withRunControl, type RunControlEvent } from "../core/run-control";
import { createRun, readStatus, runExists, runPaths, writeStatus, type RunPaths, type RunStatus } from "../core/run";
import { settleCancelledRunFallback } from "./controller-cancel";
import { commandWithHome, displayCommand, paletteArgv } from "./controller-command";
import { checkpointAnswerText, describeControllerAsk, validateCheckpointAnswer, type ControllerAskDescription } from "./controller-checkpoint";
import { ControllerTranscript, restoredTranscript, type TranscriptChange } from "./controller-transcript";
import { INITIAL_TUI_SNAPSHOT, isTerminalRun } from "./controller-status";
import type { TuiCheckpointAnswer, TuiConfigEffort, TuiControllerPort, TuiEvent, TuiEventListener, TuiPhase, TuiSendResult, TuiSnapshot } from "./contracts";
import { fromConfigEffort } from "./dial";
export type TuiCli = (argv: string[], io: CliIo, deps: CliDeps) => Promise<number>;
export interface RunControllerOptions {
  home?: string; branch?: string; cli?: TuiCli; cliDeps?: CliDeps; historyLimit?: number;
}
interface PendingAsk {
  prompt: string; secret: boolean;
  description: ControllerAskDescription;
  resolve(value: string): void;
  reject(reason: unknown): void;
  detach(): void;
}
interface ActiveInvocation {
  control: RunControl; promise: Promise<void>; generation: number;
  run?: RunPaths;
  cancelRequested: boolean; preserveTerminalAtCancel: boolean;
  statusAtCancel?: RunStatus;
}
/** UI adapter over the production CLI lifecycle; core APIs remain the run-file authority. */
export class RunController implements TuiControllerPort {
  readonly home: string;
  readonly #branch?: string;
  readonly #cli: TuiCli;
  readonly #cliDeps: CliDeps;
  readonly #historyLimit: number;
  readonly #listeners = new Set<TuiEventListener>();
  readonly #transcript = new ControllerTranscript();
  #snapshot: TuiSnapshot;
  #run?: RunPaths;
  #record?: RunRecord;
  #active?: ActiveInvocation;
  #pendingAsk?: PendingAsk;
  #queuedSteering: Array<{ sendId: string; text: string }> = [];
  #nextSendId = 0;
  #pendingEffort?: TuiConfigEffort;
  #ambientEvents = 0;
  #generation = 0;

  constructor(options: RunControllerOptions = {}) {
    this.home = options.home ?? kilnHome();
    this.#branch = options.branch;
    this.#cli = options.cli ?? main;
    this.#cliDeps = options.cliDeps ?? {};
    this.#historyLimit = options.historyLimit ?? 24;
    initHome(this.home);
    const config = loadConfig(this.home);
    this.#snapshot = {
      ...INITIAL_TUI_SNAPSHOT, directory: this.home, branch: this.#branch,
      effort: fromConfigEffort(config.effort), auth: localAuthState(this.home),
    };
  }
  getSnapshot(): Readonly<TuiSnapshot> { return this.#snapshot; }
  subscribe(listener: TuiEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(input: { seed?: string; runId?: string }): Promise<void> {
    this.#assertIdle();
    if ((input.seed === undefined) === (input.runId === undefined)) throw new Error("start requires exactly one of seed or runId");
    let run: RunPaths;
    if (input.seed !== undefined) {
      if (!input.seed.trim()) throw new Error("a run seed is required");
      run = createRun(this.home, input.seed);
      new RunRecord(run.record).append({ t: "run.created", seed: input.seed });
    } else {
      if (!runExists(this.home, input.runId!)) throw new Error(`unknown run ${input.runId}`);
      run = runPaths(this.home, input.runId!);
    }
    this.#attach(run);
    await this.#begin(commandWithHome(["run", "resume", run.id, "--through", "reflect", "--yes"], this.home), false, true, run);
  }

  resume(runId: string): Promise<void> {
    return this.start({ runId });
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      const run = active.run;
      if (run && this.#run?.dir === run.dir) {
        try {
          const status = readStatus(run);
          active.preserveTerminalAtCancel = isTerminalRun(status);
          active.statusAtCancel = status;
        }
        catch { /* without a comparison snapshot, fallback persistence fails closed */ }
      }
      active.control.cancel("user_cancelled");
    }
    try {
      await active.promise;
    } catch (error) {
      if (!(error instanceof RunCancelledError)) throw error;
    }
  }

  async send(text: string): Promise<TuiSendResult> {
    const value = text.trim();
    if (!value) throw new Error("a message is required");
    const pending = this.#pendingAsk;
    if (pending) {
      if (!pending.secret) this.#emitTranscript({ type: "text", entry: this.#transcript.appendUser(value) });
      this.#settleAsk(pending, value);
      return { status: "answered" };
    }
    this.#emitTranscript({ type: "text", entry: this.#transcript.appendUser(value) });
    const active = this.#active;
    const sourceIds = active?.control.steer(value) ?? [];
    if (sourceIds.length > 0) return { status: "delivered", sourceIds };
    const sendId = `send:${++this.#nextSendId}`;
    this.#queuedSteering.push({ sendId, text: value });
    return { status: "queued", sendId };
  }

  async setEffort(effort: TuiConfigEffort): Promise<void> {
    this.#pendingEffort = effort;
    this.#snapshot = { ...this.#snapshot, effort: fromConfigEffort(effort) };
    this.#emit({ type: "snapshot", snapshot: this.#snapshot });
    const active = this.#active;
    if (active) {
      active.control.steer(`[Kiln control] Apply ${effort} reasoning effort at the next safe model boundary.`);
      return;
    }
    this.#persistEffort();
  }

  async answerCheckpoint(answer: TuiCheckpointAnswer): Promise<void> {
    const pending = this.#pendingAsk;
    if (!pending) throw new Error("there is no active checkpoint question");
    validateCheckpointAnswer(answer, pending.description);
    const text = checkpointAnswerText(answer);
    this.#emitTranscript({ type: "text", entry: this.#transcript.appendUser(text) });
    if (answer.kind !== "bws") {
      this.#snapshot = { ...this.#snapshot, checkpoint: undefined };
      this.#emit({ type: "snapshot", snapshot: this.#snapshot });
    }
    this.#settleAsk(pending, text);
  }

  async execute(commandId: string, args: readonly string[] = []): Promise<void> {
    if (commandId === "build: pause") {
      if (!this.#active) throw new Error("there is no active build to pause");
      await this.cancel();
      return;
    }
    if (commandId === "run: new") {
      await this.start({ seed: args.join(" ") });
      return;
    }
    if (commandId === "run: resume") {
      if (args.length !== 1) throw new Error("run: resume requires one run id");
      await this.resume(args[0]!);
      return;
    }
    this.#assertIdle();
    const argv = paletteArgv(commandId, args);
    if (!argv) throw new Error(`unknown palette command ${commandId}`);
    this.#emitTranscript({ type: "text", entry: this.#transcript.appendUser(`$ kiln ${displayCommand(argv)}`) });
    await this.#begin(commandWithHome(argv, this.home), true, false);
    if (commandId === "mode: toggle") {
      this.#snapshot = { ...this.#snapshot, effort: fromConfigEffort(loadConfig(this.home).effort) };
      this.#emit({ type: "snapshot", snapshot: this.#snapshot });
    }
  }

  #assertIdle(): void { if (this.#active) throw new Error("a controller invocation is already active"); }

  #attach(run: RunPaths): void {
    this.#run = run;
    this.#record = new RunRecord(run.record);
    this.#queuedSteering = [];
    this.#transcript.restore(restoredTranscript(run.id, this.#record.read(), this.#historyLimit));
    this.#refreshSnapshot();
    this.#emit({ type: "snapshot", snapshot: this.#snapshot });
  }

  #begin(argv: string[], captureOutput: boolean, lifecycle: boolean, run?: RunPaths): Promise<void> {
    const control = new RunControl();
    const active: ActiveInvocation = {
      control, promise: Promise.resolve(), generation: ++this.#generation,
      run, cancelRequested: false, preserveTerminalAtCancel: false,
    };
    this.#active = active;
    const unsubscribe = control.subscribe((event) => this.#onRunEvent(active, event));
    active.promise = this.#invoke(active, argv, captureOutput, lifecycle).finally(() => unsubscribe());
    return active.promise;
  }

  async #invoke(active: ActiveInvocation, argv: string[], captureOutput: boolean, lifecycle: boolean): Promise<void> {
    const output: string[] = [];
    const errors: string[] = [];
    const beforeAmbient = this.#ambientEvents;
    const liveOutput = captureOutput && argv[0] === "auth";
    const io: CliIo = {
      write: (text) => { if (captureOutput) { output.push(text); if (liveOutput) this.#appendCliOutput(text); } },
      error: (text) => errors.push(text),
      ask: (prompt) => this.#ask(active, prompt, false),
      askSecret: (prompt) => this.#ask(active, prompt, true),
    };
    try {
      const externalOnRun = this.#cliDeps.onRun;
      const deps: CliDeps = {
        ...this.#cliDeps,
        onRun: (run) => {
          active.run = run;
          if (this.#run?.dir !== run.dir) this.#attach(run);
          externalOnRun?.(run);
        },
      };
      const code = await withRunControl(active.control, () => this.#cli(argv, io, deps));
      throwIfRunCancelled(active.control.signal);
      if (code !== 0) throw new Error(errors.join("").trim() || `kiln command exited ${code}`);
      if (captureOutput && !liveOutput && beforeAmbient === this.#ambientEvents) this.#appendCliOutput(output.join(""));
      if (errors.length > 0) this.#appendCliOutput(errors.join(""));
      this.#finalizeTranscript(false);
      this.#refreshSnapshot();
    } catch (error) {
      if (active.control.signal.aborted || error instanceof RunCancelledError) {
        this.#finalizeTranscript(true);
        this.#persistCancellation(active);
        return;
      }
      if (lifecycle && this.#run) {
        const status = readStatus(this.#run);
        if (!isTerminalRun(status)) {
          const message = error instanceof Error ? error.message : String(error);
          const failureClass = classifyFailure({ error });
          writeStatus(this.#run, { state: "failed", outcome: { kind: "failure", failureClass, message } });
        }
      }
      this.#finalizeTranscript(false);
      this.#appendCliOutput(errors.join("") || (error instanceof Error ? error.message : String(error)));
      this.#refreshSnapshot();
      throw error;
    } finally {
      this.#rejectAsk(new Error("the CLI invocation ended before answering the prompt"));
      this.#persistEffort();
      if (this.#active === active) this.#active = undefined;
      this.#snapshot = { ...this.#snapshot, auth: localAuthState(this.home) };
      this.#refreshSnapshot();
      this.#emit({ type: "snapshot", snapshot: this.#snapshot });
    }
  }

  #onRunEvent(active: ActiveInvocation, event: RunControlEvent): void {
    if (this.#active !== active) return;
    this.#ambientEvents += 1;
    if (this.#queuedSteering.length > 0) {
      const queued = [...this.#queuedSteering];
      for (const queuedSend of queued) {
        const sourceIds = active.control.steer(queuedSend.text, event.sourceId);
        if (sourceIds.length === 0) break;
        this.#queuedSteering.shift();
        this.#emit({ type: "steering_delivered", ...queuedSend, sourceIds });
      }
    }
    const change = this.#transcript.consume(event);
    this.#refreshSnapshot(event.phase, `${event.role}: ${event.type === "text" ? "responding" : event.name}`);
    this.#emitTranscript(change);
  }

  #ask(active: ActiveInvocation, prompt: string, secret: boolean): Promise<string> {
    if (this.#pendingAsk) return Promise.reject(new Error("another CLI question is already pending"));
    throwIfRunCancelled(active.control.signal);
    const description = describeControllerAsk(this.#run, this.#record, prompt);
    this.#emitTranscript({ type: "text", entry: this.#transcript.appendBrain(prompt.trim()) });
    if (description.checkpoint) {
      this.#snapshot = { ...this.#snapshot, checkpoint: description.checkpoint };
      this.#emit({ type: "checkpoint", checkpoint: description.checkpoint });
    }
    const answer = new Promise<string>((resolve, reject) => {
      const abort = () => {
        const pending = this.#pendingAsk;
        if (pending) this.#rejectAsk(active.control.signal.reason ?? new RunCancelledError("user_cancelled"));
      };
      active.control.signal.addEventListener("abort", abort, { once: true });
      this.#pendingAsk = {
        prompt, secret,
        description,
        resolve,
        reject,
        detach: () => active.control.signal.removeEventListener("abort", abort),
      };
    });
    this.#emit({ type: "input_requested", prompt, secret });
    return answer;
  }
  #settleAsk(pending: PendingAsk, value: string): void {
    if (this.#pendingAsk !== pending) throw new Error("that question is no longer active");
    pending.detach();
    this.#pendingAsk = undefined;
    this.#emit({ type: "input_cleared" });
    pending.resolve(value);
  }
  #rejectAsk(reason: unknown): void {
    const pending = this.#pendingAsk;
    if (!pending) return;
    pending.detach();
    this.#pendingAsk = undefined;
    this.#emit({ type: "input_cleared" });
    pending.reject(reason);
  }

  #persistCancellation(active: ActiveInvocation): void {
    const run = active.run;
    if (!run) return;
    const isCurrent = () => this.#generation === active.generation
      && this.#active?.generation === active.generation
      && this.#run?.dir === run.dir;
    const persistence = settleCancelledRunFallback(run, {
      preserveTerminal: active.preserveTerminalAtCancel,
      statusAtCancel: active.statusAtCancel,
      isCurrent,
    });
    if (!isCurrent()) return;
    this.#refreshSnapshot();
    this.#snapshot = { ...this.#snapshot, checkpoint: undefined };
    if (persistence !== "written" && persistence !== "existing_pause") return;
    this.#emit({ type: "cancelled", phase: this.#snapshot.phase });
  }

  #persistEffort(): void {
    const effort = this.#pendingEffort;
    if (!effort) return;
    const latest = loadConfig(this.home);
    latest.effort = effort;
    latest.effortByRole ??= {};
    for (const role of Object.keys(latest.roles) as Array<keyof typeof latest.roles>) latest.effortByRole[role] = effort;
    saveConfig(this.home, latest);
    this.#pendingEffort = undefined;
  }

  #appendCliOutput(text: string): void {
    const value = text.trim();
    if (!value) return;
    this.#emitTranscript({ type: "text", entry: this.#transcript.appendBrain(value) });
  }

  #finalizeTranscript(interrupted: boolean): void {
    for (const change of this.#transcript.finalize(interrupted)) this.#emitTranscript(change);
  }

  #refreshSnapshot(phase?: TuiPhase, activity?: string): void {
    if (this.#run) {
      const status = readStatus(this.#run);
      this.#record = new RunRecord(this.#run.record);
      this.#snapshot = {
        ...this.#snapshot,
        runId: this.#run.id,
        phase: phase ?? status.phase,
        state: status.state,
        activity,
        costUsd: this.#record.costUsd(),
        directory: this.#run.dir,
        branch: this.#branch,
        transcript: this.#transcript.entries,
      };
      this.#emit({ type: "status", phase: this.#snapshot.phase, state: this.#snapshot.state, activity, costUsd: this.#snapshot.costUsd });
      return;
    }
    this.#snapshot = { ...this.#snapshot, activity, transcript: this.#transcript.entries };
  }

  #emitTranscript(change: TranscriptChange): void {
    this.#snapshot = { ...this.#snapshot, transcript: this.#transcript.entries };
    this.#emit(change.type === "text" ? { type: "text", entry: change.entry } : { type: "tool", entry: change.entry });
  }

  #emit(event: TuiEvent): void {
    for (const listener of [...this.#listeners]) {
      try { listener(event); }
      catch { /* a renderer listener cannot break run control */ }
    }
  }
}

export function createRunController(options: RunControllerOptions = {}): RunController {
  return new RunController(options);
}
