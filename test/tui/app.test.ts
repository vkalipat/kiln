import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { startTui } from "../../src/tui/app";
import type {
  TuiCheckpointAnswer,
  TuiConfigEffort,
  TuiControllerPort,
  TuiEvent,
  TuiEventListener,
  TuiSendResult,
  TuiSnapshot,
} from "../../src/tui/contracts";
import { FakeTerminal } from "./fake-terminal";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const settle = async () => { await tick(); await tick(); await tick(); await tick(); };
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

class MockController implements TuiControllerPort {
  snapshot: TuiSnapshot = {
    phase: "frame",
    state: "idle",
    costUsd: 0,
    directory: "~/kiln",
    branch: "main",
    effort: "medium",
    transcript: [],
  };
  readonly starts: Array<{ seed?: string; runId?: string }> = [];
  readonly sends: string[] = [];
  readonly efforts: TuiConfigEffort[] = [];
  readonly answers: TuiCheckpointAnswer[] = [];
  readonly commands: Array<{ id: string; args: readonly string[] }> = [];
  sendGate?: Promise<void>;
  startError?: Error;
  answerError?: Error;
  commandError?: Error;
  cancelGate?: Promise<void>;
  startGate?: Promise<void>;
  sendResult: TuiSendResult = { status: "queued", sendId: "send-1" };
  cancelCount = 0;
  #listeners = new Set<TuiEventListener>();

  get listenerCount(): number { return this.#listeners.size; }
  getSnapshot(): Readonly<TuiSnapshot> { return this.snapshot; }
  subscribe(listener: TuiEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async start(input: { seed?: string; runId?: string }): Promise<void> {
    this.starts.push(input);
    if (this.startError) throw this.startError;
    await this.startGate;
  }
  async resume(runId: string): Promise<void> { this.starts.push({ runId }); }
  async cancel(): Promise<void> {
    this.cancelCount += 1;
    await this.cancelGate;
    this.snapshot = { ...this.snapshot, state: "paused", activity: "State saved" };
    this.emit({ type: "cancelled", phase: this.snapshot.phase });
    this.emit({ type: "snapshot", snapshot: this.snapshot });
  }
  async send(text: string): Promise<TuiSendResult> { this.sends.push(text); await this.sendGate; return this.sendResult; }
  async setEffort(effort: TuiConfigEffort): Promise<void> {
    this.efforts.push(effort);
    this.snapshot = { ...this.snapshot, effort: effort === "xhigh" ? "ultra" : effort };
    this.emit({ type: "snapshot", snapshot: this.snapshot });
  }
  async answerCheckpoint(answer: TuiCheckpointAnswer): Promise<void> {
    this.answers.push(answer);
    if (this.answerError) throw this.answerError;
    if (answer.kind !== "bws") this.snapshot = { ...this.snapshot, checkpoint: undefined };
  }
  async execute(commandId: string, args: readonly string[] = []): Promise<void> {
    this.commands.push({ id: commandId, args });
    if (this.commandError) throw this.commandError;
  }

  emit(event: TuiEvent): void { for (const listener of [...this.#listeners]) listener(event); }

  setSnapshot(patch: Partial<TuiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit({ type: "snapshot", snapshot: this.snapshot });
  }
}

describe("kiln TUI app", () => {
  test("drives a frame through streaming, cancellation, checkpoint, resize, and safe exit", async () => {
    const controller = new MockController();
    const terminal = new FakeTerminal(64, 18);
    let tickerTimers = 0;
    const lifecycle = startTui(controller, {
      terminal,
      env: { NO_ANIMATION: "1" },
      tickerOptions: {
        setIntervalFn: () => { tickerTimers += 1; return {} as ReturnType<typeof setInterval>; },
      },
    });

    expect(controller.starts).toEqual([]);
    expect(plain(lifecycle.app.render(64).join("\n"))).toContain("Welcome to Kiln");
    expect(terminal.writes.join("")).toContain("\x1b[?1049h");
    expect(tickerTimers).toBe(0);

    terminal.emitInput("compare pottery kilns");
    terminal.emitInput("\r");
    await tick();
    expect(controller.starts).toEqual([{ seed: "compare pottery kilns" }]);

    controller.setSnapshot({ runId: "run-1", state: "running", phase: "frame", activity: "Thinking" });
    controller.emit({ type: "text", entry: { id: "brain-1", kind: "brain", text: "Looking", streaming: true } });
    controller.emit({ type: "text", entry: { id: "brain-1", kind: "brain", text: "Looking at evidence", streaming: true } });
    controller.emit({ type: "tool", entry: { id: "tool-1", kind: "tool", status: "running", verb: "Read", args: "market.md" } });
    controller.emit({ type: "tool", entry: { id: "tool-1", kind: "tool", status: "done", verb: "Read", args: "market.md" } });
    controller.emit({ type: "text", entry: { id: "thinking-1", kind: "thinking", text: "private reasoning" } });
    lifecycle.tui.renderNow();
    const streamed = plain(lifecycle.app.render(64).join("\n"));
    expect(streamed).toContain("Looking at evidence");
    expect(streamed).toContain("✓ Read market.md");
    expect(streamed.match(/Looking at evidence/g)).toHaveLength(1);
    expect(streamed).not.toContain("private reasoning");
    terminal.emitInput("\x1bt");
    expect(plain(lifecycle.app.render(64).join("\n"))).toContain("private reasoning");

    let releaseSteering!: () => void;
    controller.sendGate = new Promise<void>((resolve) => { releaseSteering = resolve; });
    terminal.emitInput("steer toward local materials");
    terminal.emitInput("\r");
    await tick();
    expect(controller.sends).toEqual(["steer toward local materials"]);
    expect(plain(lifecycle.app.render(64).join("\n"))).toContain("steering: steer toward local materials");
    releaseSteering();
    await settle();
    expect(plain(lifecycle.app.render(64).join("\n"))).toContain("steering: steer toward local materials");
    controller.emit({ type: "steering_delivered", sendId: "send-1", text: "steer toward local materials", sourceIds: ["brain:frame"] });
    expect(plain(lifecycle.app.render(64).join("\n"))).not.toContain("steering: steer toward local materials");

    terminal.emitInput("\x1b[27;3;116~");
    terminal.emitInput("\x1b");
    await tick();
    expect(controller.cancelCount).toBe(1);
    expect(lifecycle.app.snapshot.state).toBe("paused");

    const checkpoint = {
      round: 1,
      ideas: ["a", "b", "c", "d"].map((id) => ({ id, title: `Idea ${id}` })),
      groups: [["a", "b", "c", "d"]],
      groupIndex: 0,
      valueLadder: ["a", "b", "c", "d"],
      feasibilityLadder: ["d", "c", "b", "a"],
    };
    controller.setSnapshot({ state: "stopped", checkpoint });
    expect(lifecycle.app.modalKind).toBe("checkpoint");
    terminal.emitInput("\x13");
    expect(lifecycle.app.modalKind).toBe("effort");
    terminal.emitInput("\x1b[C");
    terminal.emitInput("\r");
    await settle();
    expect(lifecycle.app.modalKind).toBe("checkpoint");
    expect(controller.efforts).toEqual(["high"]);
    terminal.emitInput("\r");
    terminal.emitInput("\r");
    await tick();
    expect(controller.answers[0]).toEqual({ kind: "bws", groupIndex: 0, best: "a", worst: "b" });
    terminal.emitInput("\r");
    terminal.emitInput("\r");
    await settle();
    expect(controller.answers[1]).toEqual({ kind: "pick", id: "a" });
    expect(lifecycle.app.modalKind).toBeUndefined();

    terminal.resize(31, 12);
    const resized = lifecycle.app.render(terminal.columns);
    expect(resized).toHaveLength(terminal.rows);
    expect(resized.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);

    terminal.emitInput("\x03");
    await lifecycle.done;
    expect(terminal.stops).toBe(1);
    expect(terminal.writes.join("")).toContain("\x1b[?1049l");
    expect(terminal.progress.at(-1)).toBe(false);
    expect(controller.listenerCount).toBe(0);
  });

  test("supports help, palette, multiline input, and a run-id launch seam", async () => {
    const controller = new MockController();
    const terminal = new FakeTerminal();
    const lifecycle = startTui(controller, { terminal, runId: "run-existing", animations: false, showHardwareCursor: true });
    await tick();
    expect(controller.starts).toEqual([{ runId: "run-existing" }]);

    terminal.emitInput("?");
    expect(lifecycle.app.modalKind).toBe("help");
    terminal.emitInput("?");
    expect(lifecycle.app.modalKind).toBeUndefined();
    terminal.emitInput("\x0f");
    expect(lifecycle.app.modalKind).toBe("palette");
    terminal.emitInput("\x0f");
    expect(lifecycle.app.modalKind).toBeUndefined();
    terminal.emitInput("\x1b[200~");
    terminal.emitInput("?");
    terminal.emitInput("/");
    terminal.emitInput("\x1b[201~");
    expect(lifecycle.app.modalKind).toBeUndefined();
    expect(lifecycle.app.prompt.getText()).toBe("?/");
    expect(lifecycle.app.prompt.editor.getUseTerminalCursor()).toBe(false);
    lifecycle.app.prompt.setText("");
    terminal.emitInput("abc");
    terminal.emitInput("\x1b[H");
    terminal.emitInput("X");
    expect(lifecycle.app.prompt.getText()).toBe("Xabc");
    lifecycle.app.prompt.setText("");

    terminal.emitInput("first line");
    terminal.emitInput("\x1b[13;2u");
    terminal.emitInput("second line");
    expect(lifecycle.app.prompt.getText()).toBe("first line\nsecond line");

    controller.setSnapshot({ runId: "run-existing", state: "running" });
    terminal.emitInput("\x03");
    await lifecycle.done;
    expect(controller.cancelCount).toBe(1);
  });

  test("restores the alternate buffer and disposes when controller startup fails", async () => {
    const controller = new MockController();
    controller.startError = new Error("frame failed");
    const terminal = new FakeTerminal();
    const lifecycle = startTui(controller, { terminal, seed: "broken seed", animations: false });
    await expect(lifecycle.done).rejects.toThrow("frame failed");
    expect(terminal.stops).toBe(1);
    expect(terminal.writes.join("")).toContain("\x1b[?1049l");
    expect(terminal.progress.at(-1)).toBe(false);
  });

  test("finishes lifecycle cleanup on terminal disconnect", async () => {
    const controller = new MockController();
    const terminal = new FakeTerminal();
    let scheduled = 0;
    let cleared = 0;
    const timer = {} as ReturnType<typeof setInterval>;
    const lifecycle = startTui(controller, {
      terminal,
      animations: true,
      tickerOptions: {
        setIntervalFn: () => { scheduled += 1; return timer; },
        clearIntervalFn: (value) => { expect(value).toBe(timer); cleared += 1; },
      },
    });
    expect(scheduled).toBe(1);
    terminal.disconnect();
    await lifecycle.done;
    expect(terminal.stops).toBe(1);
    expect(terminal.writes.join("")).toContain("\x1b[?1049l");
    expect(cleared).toBe(1);
    expect(controller.listenerCount).toBe(0);
  });

  test("prevents a deferred seed from starting after immediate stop", async () => {
    const controller = new MockController();
    const lifecycle = startTui(controller, { terminal: new FakeTerminal(), seed: "late seed", animations: false });
    await lifecycle.stop();
    await settle();
    expect(controller.starts).toEqual([]);
  });

  test("preserves a second draft while the first seed is being admitted", async () => {
    const controller = new MockController();
    let releaseStart!: () => void;
    controller.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const terminal = new FakeTerminal();
    const lifecycle = startTui(controller, { terminal, animations: false });
    terminal.emitInput("first seed");
    terminal.emitInput("\r");
    await tick();
    terminal.emitInput("second draft");
    terminal.emitInput("\r");
    expect(lifecycle.app.prompt.getText()).toBe("second draft");
    releaseStart();
    await settle();
    await lifecycle.stop();
  });

  test("keeps checkpoint validation errors inside the modal", async () => {
    const controller = new MockController();
    controller.setSnapshot({ runId: "run-1", state: "running" });
    controller.answerError = new Error("stale checkpoint answer");
    const terminal = new FakeTerminal();
    const lifecycle = startTui(controller, { terminal, animations: false });
    controller.emit({ type: "checkpoint", checkpoint: {
      round: 1,
      ideas: ["a", "b", "c", "d"].map((id) => ({ id })),
      groups: [["a", "b", "c", "d"]], groupIndex: 0,
      valueLadder: [], feasibilityLadder: [],
    } });
    terminal.emitInput("\r");
    terminal.emitInput("\r");
    await settle();
    expect(lifecycle.app.modalKind).toBe("checkpoint");
    expect(plain(lifecycle.app.render(80).join("\n"))).not.toContain("stale checkpoint answer");
    lifecycle.tui.renderNow();
    const modal = plain(lifecycle.tui.getDebugPaint()?.lines.join("\n") ?? "");
    expect(modal).toContain("stale checkpoint answer");
    expect(modal).toContain("choose BEST");
    expect(terminal.stops).toBe(0);
    await lifecycle.stop();
  });

  test("binds palette arguments without making command errors fatal", async () => {
    const controller = new MockController();
    controller.setSnapshot({ runId: "run-1", state: "paused" });
    const terminal = new FakeTerminal(48, 10);
    const lifecycle = startTui(controller, { terminal, animations: false });
    lifecycle.app.prompt.setText("idea-a");
    terminal.emitInput("\x0f");
    terminal.emitInput("ideas pick");
    terminal.emitInput("\r");
    await settle();
    expect(controller.commands).toEqual([{ id: "ideas: pick", args: ["run-1", "idea-a"] }]);

    controller.commandError = new Error("command needs configuration");
    lifecycle.app.prompt.setText("");
    terminal.emitInput("\x0f");
    terminal.emitInput("model roles");
    terminal.emitInput("\r");
    await settle();
    expect(lifecycle.app.snapshot.activity).toContain("command needs configuration");
    expect(terminal.stops).toBe(0);
    lifecycle.tui.renderNow();
    expect(lifecycle.tui.getDebugPaint()?.lines).toHaveLength(terminal.rows);
    await lifecycle.stop();
  });

  test("navigates long transcripts with global paging keys", async () => {
    const controller = new MockController();
    controller.setSnapshot({
      runId: "run-1",
      transcript: Array.from({ length: 20 }, (_, index) => ({ id: `b-${index}`, kind: "brain" as const, text: `line ${index}` })),
    });
    const terminal = new FakeTerminal(40, 12);
    const lifecycle = startTui(controller, { terminal, animations: false });
    lifecycle.app.render(40);
    expect(lifecycle.app.transcript.scrollState().follow).toBe(true);
    terminal.emitInput("\x1b[5~");
    lifecycle.app.render(40);
    expect(lifecycle.app.transcript.scrollState().follow).toBe(false);
    terminal.emitInput("\x1b[F");
    expect(lifecycle.app.transcript.scrollState().follow).toBe(true);
    await lifecycle.stop();
  });

  test("preserves inactive prompts and fences deferred controls during shutdown", async () => {
    const controller = new MockController();
    controller.setSnapshot({ runId: "run-1", state: "paused" });
    const terminal = new FakeTerminal();
    const lifecycle = startTui(controller, { terminal, animations: false });
    terminal.emitInput("keep this draft");
    terminal.emitInput("\r");
    expect(lifecycle.app.prompt.getText()).toBe("keep this draft");
    expect(controller.sends).toEqual([]);

    lifecycle.app.prompt.setText("");
    terminal.emitInput("\x0f");
    terminal.emitInput("auth login openai");
    terminal.emitInput("\r");
    const stopped = lifecycle.stop();
    await stopped;
    await settle();
    expect(controller.commands).toEqual([]);
  });

  test("handles synchronous disconnect and restores the terminal before slow cancellation", async () => {
    const disconnected = new FakeTerminal();
    disconnected.disconnectOnStart = true;
    const early = startTui(new MockController(), { terminal: disconnected, animations: true });
    await early.done;
    expect(disconnected.stops).toBe(1);

    const controller = new MockController();
    controller.setSnapshot({ runId: "run-1", state: "running" });
    let releaseCancel!: () => void;
    controller.cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const terminal = new FakeTerminal();
    const lifecycle = startTui(controller, { terminal, animations: false });
    terminal.emitInput("\x1b");
    terminal.emitInput("\x03");
    expect(terminal.stops).toBe(1);
    await tick();
    expect(controller.cancelCount).toBe(1);
    releaseCancel();
    await lifecycle.done;
  });

  test("routes a shortcut batched after bracketed paste end", async () => {
    const terminal = new FakeTerminal();
    const lifecycle = startTui(new MockController(), { terminal, animations: false });
    terminal.emitInput("\x1b[200~");
    terminal.emitInput("pasted");
    terminal.emitInput("\x1b[201~\x03");
    await lifecycle.done;
    expect(terminal.stops).toBe(1);
  });

  test("gates a first seed on onboarding, then resumes it after connection", async () => {
    const controller = new MockController();
    controller.snapshot = { ...controller.snapshot, auth: { required: true, configured: [] } };
    const terminal = new FakeTerminal(72, 18);
    const lifecycle = startTui(controller, { terminal, animations: false });
    await settle();
    expect(lifecycle.app.modalKind).toBe("onboarding");
    terminal.emitInput("\x1b");
    expect(controller.commands).toEqual([]);
    terminal.emitInput("build a ceramic inventory app");
    terminal.emitInput("\r");
    expect(controller.starts).toEqual([]);
    expect(lifecycle.app.modalKind).toBe("onboarding");
    terminal.emitInput("\r");
    await settle();
    expect(controller.commands[0]).toEqual({ id: "auth: login anthropic", args: ["--method", "oauth"] });
    controller.setSnapshot({ auth: { required: false, configured: ["anthropic"] } });
    await settle();
    expect(controller.starts).toEqual([{ seed: "build a ceramic inventory app" }]);
    expect(lifecycle.app.prompt.getText()).toBe("");
    await lifecycle.stop();
  });

  test("defers an explicit run resume until a provider is connected", async () => {
    const controller = new MockController();
    controller.snapshot = { ...controller.snapshot, auth: { required: true, configured: [] } };
    const terminal = new FakeTerminal(64, 16);
    const lifecycle = startTui(controller, { terminal, runId: "run-7", animations: false });
    await settle();
    expect(controller.starts).toEqual([]);
    terminal.emitInput("\r"); await settle();
    controller.setSnapshot({ auth: { required: false, configured: ["anthropic"] } });
    await settle();
    expect(controller.starts).toEqual([{ runId: "run-7" }]);
    await lifecycle.stop();
  });

  test("preserves a seed passed through the public launch seam during onboarding", async () => {
    const controller = new MockController();
    controller.snapshot = { ...controller.snapshot, auth: { required: true, configured: [] } };
    const lifecycle = startTui(controller, { terminal: new FakeTerminal(64, 16), animations: false });
    lifecycle.app.launch({ seed: "deferred launch seed" });
    controller.setSnapshot({ auth: { required: false, configured: ["anthropic"] } });
    await settle();
    expect(controller.starts).toEqual([{ seed: "deferred launch seed" }]);
    await lifecycle.stop();
  });

  test("routes slash login and masks requested credentials", async () => {
    const controller = new MockController();
    const terminal = new FakeTerminal(72, 18);
    const lifecycle = startTui(controller, { terminal, animations: false });
    terminal.emitInput("/login openai key"); terminal.emitInput("\r");
    await settle();
    expect(controller.commands[0]).toEqual({ id: "auth: login openai", args: ["--method", "api-key"] });
    controller.emit({ type: "input_requested", prompt: "API key", secret: true });
    terminal.emitInput("sk-never-render-this");
    expect(plain(lifecycle.app.render(72).join("\n"))).not.toContain("sk-never-render-this");
    terminal.emitInput("\r");
    await settle();
    expect(controller.sends).toContain("sk-never-render-this");
    await lifecycle.stop();
  });

  test("blocks slash login while preserving an active run", async () => {
    const controller = new MockController();
    controller.snapshot = { ...controller.snapshot, runId: "run-1", state: "running", auth: { required: false, configured: ["anthropic"] } };
    const terminal = new FakeTerminal(72, 18);
    const lifecycle = startTui(controller, { terminal, animations: false });
    terminal.emitInput("/login openai"); terminal.emitInput("\r");
    await settle();
    expect(controller.commands).toEqual([]);
    expect(lifecycle.app.snapshot).toMatchObject({ state: "running", activity: "Pause the active run before changing providers" });
    expect(controller.cancelCount).toBe(0);
    await lifecycle.stop();
  });
});
