import { TUI, type Component, type OverlayFocusOwner, type OverlayHandle, type Terminal } from "@oh-my-pi/pi-tui";
import { CheckpointModal } from "./checkpoint";
import { AuthInput } from "./auth-input";
import { authShortcut } from "./auth-shortcut";
import type { TuiCheckpointAnswer, TuiCheckpointSnapshot, TuiControllerPort, TuiEvent, TuiSendResult, TuiSnapshot, TuiTranscriptEntry } from "./contracts";
import { EffortDial, nextEffort } from "./dial";
import { ShortcutHelp } from "./help";
import { matchAppInput } from "./input";
import { renderAppLayout } from "./layout";
import { CENTERED_OVERLAY } from "./overlay";
import { ProviderOnboarding } from "./onboarding";
import { CommandPalette, type PaletteCommand } from "./palette";
import { paletteInvocation } from "./palette-input";
import { PromptBox, type QueuedPrompt } from "./promptbox";
import { TuiTicker } from "./ticker";
import { TranscriptView } from "./transcript";
type ModalKind = "palette" | "effort" | "checkpoint" | "help" | "onboarding" | "auth-input";
interface ActiveModal { readonly kind: ModalKind; readonly component: Component; readonly handle: OverlayHandle }
interface PendingPrompt extends QueuedPrompt { readonly id: number; readonly seed: boolean; sendId?: string }
export interface KilnTuiAppOptions {
  readonly controller: TuiControllerPort; readonly tui: TUI; readonly terminal: Terminal; readonly ticker: TuiTicker;
  readonly onQuit: () => void; readonly onFatal: (error: unknown) => void;
}
const MODAL_OVERLAY = { ...CENTERED_OVERLAY, maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false } as const;

/** Full-screen application component; persistence and phase execution stay in the controller. */
export class KilnTuiApp implements Component, OverlayFocusOwner {
  readonly prompt: PromptBox; readonly transcript: TranscriptView;
  readonly debugKind = "KilnTuiApp";
  #snapshot: TuiSnapshot;
  #entries: readonly TuiTranscriptEntry[];
  #modals: ActiveModal[] = [];
  #pending: PendingPrompt[] = [];
  #deliveredSendIds = new Set<string>();
  #nextPendingId = 0;
  #unsubscribe?: () => void;
  #disposed = false; #cancelling = false;
  #cancelTask?: Promise<void>;
  #shuttingDown = false; #pasteActive = false; #lastRows = -1;
  #deferredSeed?: string; #deferredRunId?: string;
  constructor(private readonly options: KilnTuiAppOptions) {
    this.#snapshot = { ...options.controller.getSnapshot() }; this.#entries = [...this.#snapshot.transcript];
    this.transcript = new TranscriptView(this.#entries, { ticker: options.ticker }); this.prompt = new PromptBox({ status: this.#promptStatus(), ticker: options.ticker });
    this.prompt.onSubmit = (text) => { this.submit(text); };
  }

  get snapshot(): Readonly<TuiSnapshot> { return this.#snapshot; } get modalKind(): ModalKind | undefined { return this.#modals.at(-1)?.kind; }
  get focused(): boolean { return this.prompt.focused; }
  set focused(value: boolean) { this.prompt.focused = value; }
  get debugChildren(): readonly Component[] { return [this.transcript, this.prompt]; }
  setUseTerminalCursor(_value: boolean): void { this.prompt.editor.setUseTerminalCursor(false); }
  ownsOverlayFocusTarget(component: Component): boolean { return component === this.prompt || component === this.prompt.editor; }

  mount(): void {
    if (this.#disposed || this.#unsubscribe) return;
    this.#unsubscribe = this.options.controller.subscribe((event) => this.#onEvent(event));
    this.#applySnapshot(this.options.controller.getSnapshot());
    if (this.#snapshot.auth?.required) queueMicrotask(() => !this.#disposed && this.#openOnboarding());
  }

  launch(input: { seed?: string; runId?: string }): void { if (this.#snapshot.auth?.required) {
    this.#deferredSeed = input.seed; this.#deferredRunId = input.runId; this.#openOnboarding(); return; }
    void this.#run(Promise.resolve().then(() => this.#shuttingDown ? undefined : this.options.controller.start(input))); }

  submit(text: string): void {
    const value = text.trim();
    if (!value || this.#disposed || this.#shuttingDown) return;
    const shortcut = authShortcut(value);
    if (shortcut) {
      this.prompt.setText("");
      if (shortcut.kind === "onboarding") this.#openOnboarding();
      else if (shortcut.kind === "error") this.#notice(shortcut.message);
      else if (this.#snapshot.state === "running") this.#notice("Pause the active run before changing providers");
      else if (this.options.controller.execute) void this.#runCommand(this.options.controller.execute(shortcut.id, shortcut.args));
      return;
    }
    const seed = !this.#snapshot.runId;
    if (seed && this.#snapshot.auth?.required) {
      this.#deferredSeed = value;
      this.prompt.setText(value);
      this.#notice("Connect a provider to start");
      this.#openOnboarding();
      return;
    }
    if (!seed && this.#snapshot.state !== "running") {
      this.prompt.setText(text);
      this.#notice(`Run is ${this.#snapshot.state}; resume it before sending`);
      return;
    }
    if (seed && this.#pending.some((item) => item.seed)) return;
    const item: PendingPrompt = {
      id: ++this.#nextPendingId,
      text: value,
      steering: !seed && this.#snapshot.state === "running",
      seed,
    };
    this.#pending.push(item); this.#syncSubmitState(); this.#syncQueue();
    const work = Promise.resolve().then(async () => {
      if (this.#shuttingDown) return;
      return seed ? this.options.controller.start({ seed: value }) : this.options.controller.send(value);
    });
    void this.#settlePrompt(item.id, work);
  }

  handleInput(data: string): void { (this.#pasteActive ? this.prompt.editor : this.prompt).handleInput(data); }

  handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (!this.#modals.length && (this.#pasteActive || data.includes("\x1b[200~"))) {
      const end = data.indexOf("\x1b[201~");
      if (end < 0) { this.#pasteActive = true; return undefined; }
      this.prompt.editor.handleInput(data.slice(0, end + 6));
      this.#pasteActive = false;
      const tail = data.slice(end + 6);
      if (tail) {
        const routed = this.handleGlobalInput(tail);
        if (!routed?.consume) this.handleInput(tail);
      }
      return { consume: true };
    }
    const action = matchAppInput(data, {
      promptEmpty: this.prompt.getText().length === 0,
      modalOpen: this.#modals.length > 0,
    });
    if (!action) return undefined;
    if (action === "quit") this.options.onQuit();
    else if (action === "palette") this.#openPalette();
    else if (action === "effort") this.#openEffort();
    else if (action === "details") {
      this.transcript.toggleAll();
      this.options.tui.requestComponentRender(this);
    } else if (action === "cancel") this.#cancelCurrent();
    else if (action === "help") this.#openHelp();
    else if (action === "scroll-up") this.transcript.scrollBy(-Math.max(1, this.options.terminal.rows - 6));
    else if (action === "scroll-down") this.transcript.scrollBy(Math.max(1, this.options.terminal.rows - 6));
    else if (action === "scroll-top") this.transcript.scrollBy(-Number.MAX_SAFE_INTEGER);
    else if (action === "scroll-end") this.transcript.scrollToEnd();
    this.options.tui.requestComponentRender(this);
    return { consume: true };
  }

  beginShutdown(): void { this.#shuttingDown = true; } cancelForShutdown(): Promise<void> { return this.#cancelTask ?? this.options.controller.cancel(); }

  render(width: number): readonly string[] {
    const rows = Math.max(1, this.options.terminal.rows);
    if (rows !== this.#lastRows) {
      this.#lastRows = rows;
      this.prompt.setMaxBodyRows(Math.max(3, Math.floor(rows / 3)));
    }
    for (const modal of this.#modals) {
      if (modal.component instanceof CommandPalette) modal.component.list.setMaxVisible(Math.max(1, Math.min(10, rows - 4)));
    }
    return renderAppLayout({ width, height: rows, snapshot: this.#snapshot, transcript: this.transcript, prompt: this.prompt });
  }

  invalidate(): void { this.transcript.invalidate(); this.prompt.invalidate(); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#unsubscribe?.(); this.#unsubscribe = undefined;
    while (this.#modals.length > 0) this.#closeModal();
    this.prompt.dispose();
    this.options.terminal.setProgress(false);
  }

  #onEvent(event: TuiEvent): void {
    if (this.#disposed) return;
    if (event.type === "steering_delivered") {
      const index = this.#pending.findIndex((item) => item.sendId === event.sendId);
      if (index >= 0) { this.#pending.splice(index, 1); this.#syncQueue(); }
      else this.#deliveredSendIds.add(event.sendId);
    } else if (event.type === "snapshot") this.#applySnapshot(event.snapshot);
    else if (event.type === "text" || event.type === "tool") this.#upsertEntry(event.entry);
    else if (event.type === "status") {
      this.#snapshot = {
        ...this.#snapshot,
        phase: event.phase,
        state: event.state,
        activity: event.activity,
        costUsd: event.costUsd ?? this.#snapshot.costUsd,
      };
      this.#syncStatus();
      if (["paused", "done", "failed"].includes(event.state)) this.#closeModal("checkpoint");
    } else if (event.type === "checkpoint") {
      this.#snapshot = { ...this.#snapshot, checkpoint: event.checkpoint };
      this.#openCheckpoint(event.checkpoint);
    } else if (event.type === "input_requested") {
      this.#openAuthInput(event.prompt, event.secret);
    } else if (event.type === "input_cleared") {
      this.#closeModal("auth-input");
    } else if (event.type === "cancelled") {
      this.#snapshot = { ...this.#snapshot, phase: event.phase, state: "paused", activity: "State saved" };
      this.#syncStatus();
      this.#closeModal("checkpoint");
    }
    this.options.tui.requestComponentRender(this);
  }

  #applySnapshot(snapshot: Readonly<TuiSnapshot>): void {
    const connected = this.#snapshot.auth?.required && snapshot.auth?.required === false;
    const resumeSeed = connected ? this.#deferredSeed : undefined; const resumeRunId = connected ? this.#deferredRunId : undefined;
    this.#snapshot = { ...snapshot, transcript: [...snapshot.transcript] };
    this.#entries = this.#snapshot.transcript; this.transcript.setEntries(this.#entries);
    if (snapshot.runId) {
      this.#pending = this.#pending.filter((item) => !item.seed);
      this.#syncQueue();
    }
    this.#syncStatus();
    if (snapshot.checkpoint && !["paused", "done", "failed"].includes(snapshot.state)) this.#openCheckpoint(snapshot.checkpoint);
    else this.#closeModal("checkpoint");
    if (!snapshot.auth?.required) this.#closeModal("onboarding");
    if (resumeSeed) {
      this.#deferredSeed = undefined; this.#deferredRunId = undefined;
      this.prompt.setText(""); queueMicrotask(() => !this.#disposed && this.submit(resumeSeed));
    } else if (resumeRunId) { this.#deferredRunId = undefined; queueMicrotask(() => !this.#disposed && this.launch({ runId: resumeRunId })); }
  }

  #upsertEntry(entry: TuiTranscriptEntry): void {
    const index = this.#entries.findIndex((candidate) => candidate.id === entry.id);
    this.#entries = index < 0
      ? [...this.#entries, entry]
      : this.#entries.map((candidate, candidateIndex) => candidateIndex === index ? entry : candidate);
    this.#snapshot = { ...this.#snapshot, transcript: this.#entries };
    this.transcript.setEntries(this.#entries);
  }

  #syncStatus(): void {
    this.prompt.setStatus(this.#promptStatus());
    this.#syncSubmitState();
    const title = `${this.#snapshot.state === "running" ? "∼ " : ""}kiln · ${this.#snapshot.phase}`
      .replace(/[\x00-\x1f\x7f]/g, " ");
    this.options.terminal.setTitle(title);
    this.options.terminal.setProgress(this.#snapshot.state === "running");
  }

  #promptStatus() { return {
    phase: this.#snapshot.phase, state: this.#snapshot.state, costUsd: this.#snapshot.costUsd,
    effort: this.#snapshot.effort, activity: this.#snapshot.activity,
    directory: this.#snapshot.directory, branch: this.#snapshot.branch,
  }; }
  #syncQueue(): void {
    this.prompt.setQueue(this.#pending.map(({ text, steering }) => ({ text, steering })));
    this.options.tui.requestComponentRender(this);
  }

  #syncSubmitState(): void {
    this.prompt.editor.disableSubmit = this.#pending.some((item) => item.seed)
      || Boolean(this.#snapshot.runId && this.#snapshot.state !== "running");
  }

  async #settlePrompt(id: number, work: Promise<void | TuiSendResult>): Promise<void> {
    let result: void | TuiSendResult;
    try { result = await work; }
    catch (error) { this.options.onFatal(error); result = undefined; }
    const item = this.#pending.find((candidate) => candidate.id === id);
    if (item && result?.status === "queued" && !this.#deliveredSendIds.delete(result.sendId)) item.sendId = result.sendId;
    else this.#pending = this.#pending.filter((candidate) => candidate.id !== id);
    if (item?.seed) this.#syncSubmitState();
    this.#syncQueue();
  }

  async #run(work: Promise<void>): Promise<boolean> {
    try {
      await work;
      return true;
    } catch (error) {
      this.options.onFatal(error);
      return false;
    }
  }

  #cancelCurrent(force = false): void {
    if (this.#cancelling || (!force && this.#snapshot.state !== "running")) return;
    this.#cancelling = true; this.#snapshot = { ...this.#snapshot, activity: "Saving state" }; this.#syncStatus();
    this.options.tui.requestComponentRender(this);
    const task = Promise.resolve().then(() => this.options.controller.cancel());
    this.#cancelTask = task;
    void this.#run(task).finally(() => {
      if (this.#cancelTask === task) this.#cancelTask = undefined; this.#cancelling = false;
    });
  }

  #showModal(kind: ModalKind, component: Component): void { this.#modals.push({ kind, component,
    handle: this.options.tui.showOverlay(component, MODAL_OVERLAY) }); }

  #closeModal(kind?: ModalKind): void {
    const index = kind ? this.#modals.findLastIndex((modal) => modal.kind === kind) : this.#modals.length - 1;
    if (index < 0) return;
    const [modal] = this.#modals.splice(index, 1);
    if (!modal) return;
    modal.handle.hide();
    modal.component.dispose?.();
  }

  #openPalette(): void {
    if (this.modalKind === "palette") { this.#closeModal("palette"); return; }
    const palette = new CommandPalette({
      maxVisible: Math.max(1, Math.min(10, this.options.terminal.rows - 4)),
      onCancel: () => this.#closeModal("palette"),
      onSelect: (command) => this.#executePalette(command),
    });
    this.#showModal("palette", palette);
  }

  #openOnboarding(): void {
    if (this.#modals.some((modal) => modal.kind === "onboarding")) return;
    const onboarding = new ProviderOnboarding({
      maxVisible: Math.max(1, Math.min(4, this.options.terminal.rows - 7)),
      onCancel: () => this.#closeModal("onboarding"),
      onSelect: (choice) => { this.#closeModal("onboarding"); if (this.options.controller.execute) {
        void this.#runCommand(this.options.controller.execute(choice.commandId, choice.args));
      } },
    });
    this.#showModal("onboarding", onboarding);
  }

  #openAuthInput(prompt: string, secret: boolean): void {
    this.#closeModal("auth-input");
    this.#showModal("auth-input", new AuthInput({
      prompt, secret,
      onCancel: () => { this.#closeModal("auth-input"); this.#cancelCurrent(true); },
      onSubmit: (value) => { void this.#runCommand(this.options.controller.send(value).then(() => {})); },
    }));
  }

  #executePalette(command: PaletteCommand): void {
    this.#closeModal("palette");
    if (command.id === "mode: toggle") {
      const effort = nextEffort(this.#snapshot.effort);
      this.#setEffort(effort, effort === "ultra" ? "xhigh" : effort);
    } else if (command.id === "build: pause") this.#cancelCurrent(true);
    else if (this.options.controller.execute) {
      const invocation = paletteInvocation(command.id, this.#snapshot.runId, this.prompt.getText());
      if (invocation.missing) { this.#notice(`${command.label}: ${invocation.missing}`); return; }
      void this.#runCommand(Promise.resolve().then(() => this.#shuttingDown ? undefined : this.options.controller.execute?.(command.id, invocation.args)));
    } else this.#notice(`${command.label} requires CLI integration`);
  }

  async #runCommand(work: Promise<void>): Promise<void> { try { await work; }
    catch (error) { this.#notice(`Error: ${error instanceof Error ? error.message : String(error)}`); } }
  #notice(activity: string): void { this.#snapshot = { ...this.#snapshot, activity }; this.#syncStatus(); this.options.tui.requestComponentRender(this); }

  #openEffort(): void {
    const modal = this.#modals.at(-1);
    if (modal?.kind === "effort" && modal.component instanceof EffortDial) {
      modal.component.handleInput("\x13");
      return;
    }
    const dial = new EffortDial(this.#snapshot.effort, {
      onCancel: () => this.#closeModal("effort"),
      onSelect: (effort, config) => this.#setEffort(effort, config),
    });
    this.#showModal("effort", dial);
  }

  #setEffort(effort: TuiSnapshot["effort"], config: Parameters<TuiControllerPort["setEffort"]>[0]): void {
    this.#snapshot = { ...this.#snapshot, effort };
    this.#syncStatus();
    this.#closeModal("effort");
    void this.#runCommand(Promise.resolve().then(() => this.#shuttingDown ? undefined : this.options.controller.setEffort(config)));
  }

  #openHelp(): void {
    if (this.modalKind === "help") { this.#closeModal("help"); return; }
    this.#showModal("help", new ShortcutHelp({ onClose: () => this.#closeModal("help") }));
  }

  #openCheckpoint(snapshot: TuiCheckpointSnapshot): void {
    const existing = this.#modals.find((modal) => modal.kind === "checkpoint");
    if (existing?.component instanceof CheckpointModal) {
      existing.component.setSnapshot(snapshot);
      return;
    }
    const modal = new CheckpointModal(snapshot, {
      onCancel: () => { this.#closeModal("checkpoint"); this.#cancelCurrent(true); },
      onAnswer: (answer) => this.#answerCheckpoint(answer),
    });
    this.#showModal("checkpoint", modal);
  }

  async #answerCheckpoint(answer: TuiCheckpointAnswer): Promise<void> {
    try { await this.options.controller.answerCheckpoint(answer); }
    catch (error) {
      const checkpoint = this.#snapshot.checkpoint;
      const modal = this.#modals.find((candidate) => candidate.kind === "checkpoint")?.component;
      if (checkpoint && modal instanceof CheckpointModal) {
        modal.setSnapshot(checkpoint);
        modal.error = error instanceof Error ? error.message : String(error);
        this.options.tui.requestComponentRender(modal);
      }
      return;
    }
    if (answer.kind !== "bws") {
      this.#snapshot = { ...this.#snapshot, checkpoint: undefined };
      this.#closeModal("checkpoint");
    }
  }
}

export { startKilnTui, startTui } from "./start";
export type { StartTuiOptions, TuiLifecycle } from "./start";
