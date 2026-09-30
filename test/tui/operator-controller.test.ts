import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorController } from "../../src/tui/operator-controller";
import { createTuiController } from "../../src/cli/commands/tui";
import { startTui } from "../../src/tui/app";
import { runPaths } from "../../src/core/run";
import { AuthStore } from "../../src/providers/auth";
import { initHome } from "../../src/core/home";
import { createOperatorRuntime } from "../../src/operator/runtime";
import type { OmpSessionHandle } from "../../src/operator/session";
import type { OperatorEvent, OperatorRuntime } from "../../src/operator/runtime";
import type { TuiControllerPort, TuiEvent, TuiEventListener, TuiSnapshot } from "../../src/tui/contracts";
import { FakeTerminal } from "./fake-terminal";

const until = async (predicate: () => boolean) => {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await Bun.sleep(1); }
  throw new Error("condition not reached");
};

class Auxiliary implements TuiControllerPort {
  snapshot: TuiSnapshot;
  listeners = new Set<TuiEventListener>();
  resumed: string[] = [];
  secrets: string[] = [];
  constructor(required = false) {
    this.snapshot = { phase: "frame", state: "idle", costUsd: 0, directory: "aux", effort: "medium", transcript: [], auth: { required, configured: required ? [] : ["anthropic"] } };
  }
  getSnapshot() { return this.snapshot; }
  subscribe(listener: TuiEventListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: TuiEvent) { for (const listener of this.listeners) listener(event); }
  async start(input: { seed?: string; runId?: string }) { if (input.runId) await this.resume(input.runId); }
  async resume(id: string) { this.resumed.push(id); }
  async cancel() {}
  async send(text: string) { this.secrets.push(text); this.emit({ type: "input_cleared" }); return { status: "answered" as const }; }
  async setEffort() {}
  async answerCheckpoint() {}
  async execute() {
    this.snapshot = { ...this.snapshot, auth: { required: false, configured: ["anthropic"] } };
    this.emit({ type: "snapshot", snapshot: this.snapshot });
  }
}

function fixture(required = false) {
  const home = mkdtempSync(join(tmpdir(), "kiln-operator-ui-"));
  const auxiliary = new Auxiliary(required);
  const prompts: string[] = [], steering: string[] = [], efforts: string[] = [];
  let calls = 0, cancelCalls = 0, disposed = 0;
  let onEvent!: (event: OperatorEvent) => void;
  let promptWork: (() => Promise<void>) | undefined;
  let cancellation: (() => Promise<void>) | undefined;
  let factoryGate: Promise<void> | undefined;
  let ask: ((prompt: string) => Promise<string>) | undefined;
  const runtime = {
    run: runPaths(home, "operator-session"),
    prompt: async (text: string) => {
      prompts.push(text);
      onEvent({ type: "status", state: "running", activity: "Working", costUsd: 0 });
      await promptWork?.();
      onEvent({ type: "status", state: "idle", activity: "Ready", costUsd: 0.25 });
      return undefined as never;
    },
    steer: async (text: string) => { steering.push(text); return { status: "delivered" as const, sourceIds: ["operator-source"] }; },
    cancel: async () => { cancelCalls++; await cancellation?.(); },
    setEffort: async (effort: string) => { efforts.push(effort); },
    dispose: async () => { disposed++; },
  } as OperatorRuntime;
  const controller = new OperatorController({ home, cwd: "/tmp/user-project", legacyController: auxiliary, createRuntime: async (options) => {
    calls++; await factoryGate; onEvent = options.onEvent!; ask = options.ask;
    expect(options.cwd).toBe("/tmp/user-project");
    onEvent({ type: "run", run: runtime.run });
    return runtime;
  } });
  return { home, controller, auxiliary, runtime, prompts, steering, efforts, emit: (event: OperatorEvent) => onEvent(event),
    setWork: (work: () => Promise<void>) => { promptWork = work; }, setCancellation: (work: () => Promise<void>) => { cancellation = work; },
    setFactoryGate: (gate: Promise<void>) => { factoryGate = gate; }, ask: (prompt: string) => ask!(prompt),
    calls: () => calls, cancelCalls: () => cancelCalls, disposed: () => disposed };
}

describe("operator TUI adapter", () => {
  test("routing shows operator selection while reviewer and worker routes preserve it", async () => {
    const s = fixture();
    await s.controller.start({ seed: "Implement the requested feature" });
    s.emit({ type: "routing", kind: "implement", modelRef: "provider/builder", effort: "high", reason: "Implementation fit", handoff: false, scope: "operator" });
    expect(s.controller.getSnapshot().routing).toEqual({ kind: "implement", modelRef: "provider/builder", effort: "high" });
    s.emit({ type: "routing", kind: "review", modelRef: "other/reviewer", effort: "low", reason: "Independent review", handoff: true, scope: "operator" });
    s.emit({ type: "routing", kind: "research", modelRef: "provider/scout", effort: "low", reason: "Bounded lookup", handoff: false, scope: "worker" });
    expect(s.controller.getSnapshot().routing?.modelRef).toBe("provider/builder");
    const text = s.controller.getSnapshot().transcript.flatMap(entry => entry.kind === "brain" ? [entry.text] : []).join("\n");
    expect(text).toContain("Reviewer recommended; handoff pending: review · other/reviewer · low");
    expect(text).toContain("Worker route: research · provider/scout");
    await s.controller.dispose();
  });

  test("resume rejects malformed saved scope instead of substituting the launch directory", async () => {
    const s = fixture();
    const dir = join(s.home, "runs", "bad-scope"); mkdirSync(dir, { recursive: true });
    for (const cwd of [undefined, "relative/project", "\0bad"]) {
      writeFileSync(join(dir, "operator.json"), JSON.stringify({ version: 1, engine: "omp", cwd }));
      await expect(s.controller.resume("bad-scope")).rejects.toThrow("invalid saved operator working directory");
      expect(s.calls()).toBe(0);
      expect(s.controller.getSnapshot().directory).toBe("/tmp/user-project");
    }
    await s.controller.dispose();
  });
  test("real runtime interaction preserves original bytes and resumes the same durable session with a fake SDK", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-operator-runtime-ui-")); initHome(home, { plugAndPlay: true });
    const auth = new AuthStore(join(home, "auth.json"), { getEnvApiKey: () => undefined });
    auth.setApiKey("anthropic", "synthetic-runtime-key");
    const prompts: string[] = [], resumes: Array<string | undefined> = [];
    let factoryCalls = 0;
    const createRuntime: NonNullable<ConstructorParameters<typeof OperatorController>[0]>["createRuntime"] = (options) => createOperatorRuntime({ jev: { enabled: false }, ...options, auth,
      createSession: async (nativeOptions) => {
        factoryCalls++; resumes.push(nativeOptions.resumeFile);
        return {
          sessionId: "fake-native-session", sessionFile: join(home, "fake-native-session.jsonl"),
          session: { prompt: async (text: string) => { prompts.push(text); }, steer: async () => {}, abort: async () => {}, setThinkingLevel: () => {} },
          awaitSettled: async () => {}, dispose: async () => {},
        } as unknown as OmpSessionHandle;
      },
    });
    const controller = new OperatorController({ home, cwd: home, createRuntime });
    const task = "  Build a formatter.\n    preserve indentation\n\n";
    await controller.start({ seed: task });
    const id = controller.getSnapshot().runId!;
    expect(readFileSync(runPaths(home, id).seed, "utf8")).toBe(task);
    await controller.send("  explain it\n");
    expect(prompts).toEqual([task, "  explain it\n"]);
    expect(factoryCalls).toBe(1);
    await controller.dispose();
    const restored = new OperatorController({ home, cwd: tmpdir(), createRuntime });
    await restored.resume(id);
    expect(restored.getSnapshot().directory).toBe(JSON.parse(readFileSync(join(runPaths(home, id).dir, "operator.json"), "utf8")).cwd);
    expect(prompts).toHaveLength(2);
    await restored.send("continue\n");
    expect(factoryCalls).toBe(2);
    expect(resumes[1]).toBe(join(home, "fake-native-session.jsonl"));
    expect(restored.getSnapshot().runId).toBe(id);
    await restored.dispose();
  });
  test("real legacy OAuth input stays secret and never opens an operator session", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-operator-auth-"));
    const store = new AuthStore(join(home, "auth.json"), {
      getEnvApiKey: () => undefined,
      getDefinition: () => ({ login: async (callbacks) => {
        callbacks.onAuth({ url: "https://login.example/authorize" });
        expect(await callbacks.onManualCodeInput?.()).toBe("private-test-login-code");
        return { refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
      } }),
    });
    let runtimeCalls = 0;
    const controller = new OperatorController({ home, cliDeps: { authStoreFactory: () => store, openUrl: () => {} }, createRuntime: async () => { runtimeCalls++; throw new Error("must not create a runtime for auth"); } });
    const events: TuiEvent[] = []; controller.subscribe((event) => events.push(event));
    const login = controller.execute("auth: login anthropic");
    await until(() => events.some((event) => event.type === "input_requested" && event.secret));
    expect(await controller.send("private-test-login-code")).toEqual({ status: "answered" });
    await login;
    expect(controller.getSnapshot().auth?.required).toBe(false);
    expect(JSON.stringify(controller.getSnapshot().transcript)).not.toContain("private-test-login-code");
    expect(runtimeCalls).toBe(0);
    await controller.dispose();
  });
  test("messages during lazy startup reach the same operator without a second session", async () => {
    const s = fixture(); let ready!: () => void;
    s.setFactoryGate(new Promise<void>((resolve) => { ready = resolve; }));
    const events: TuiEvent[] = []; s.controller.subscribe((event) => events.push(event));
    const initial = s.controller.start({ seed: "initial task" });
    await until(() => s.calls() === 1);
    const queued = await s.controller.send("keep this constraint too");
    expect(queued.status).toBe("queued");
    ready(); await initial;
    expect(s.calls()).toBe(1);
    expect(s.steering).toEqual(["keep this constraint too"]);
    expect(events.some((event) => event.type === "steering_delivered" && event.text === "keep this constraint too")).toBe(true);
    await s.controller.dispose();
  });

  test("cancellation during lazy initialization does not start a provider turn", async () => {
    const s = fixture(); let ready!: () => void;
    s.setFactoryGate(new Promise<void>((resolve) => { ready = resolve; }));
    const initial = s.controller.start({ seed: "task" });
    await until(() => s.calls() === 1);
    const stopping = s.controller.cancel();
    ready(); await stopping; await initial;
    expect(s.prompts).toEqual([]);
    expect(s.cancelCalls()).toBe(1);
    expect(s.controller.getSnapshot().state).toBe("paused");
    await s.controller.dispose();
  });

  test("operator questions use the existing input events, and cancellation rejects a pending answer", async () => {
    const s = fixture(); const events: TuiEvent[] = [];
    s.controller.subscribe((event) => events.push(event));
    let answer: string | undefined;
    s.setWork(async () => { answer = await s.ask("Which output format?"); });
    const first = s.controller.start({ seed: "prepare a report" });
    await until(() => events.some((event) => event.type === "input_requested"));
    expect(await s.controller.send("  Markdown\n")).toEqual({ status: "answered" });
    await first;
    expect(answer).toBe("  Markdown\n");
    expect(s.steering).toEqual([]);
    events.length = 0;
    const second = s.controller.send("another report");
    await until(() => events.some((event) => event.type === "input_requested"));
    await s.controller.cancel(); await second;
    expect(events.some((event) => event.type === "input_cleared")).toBe(true);
    expect(s.controller.getSnapshot().state).toBe("paused");
    await s.controller.dispose();
  });
  test("opening and local greetings create no runtime, including before authentication", async () => {
    const s = fixture(true);
    expect(s.controller.getSnapshot()).toMatchObject({ state: "idle", mode: "operator", directory: "/tmp/user-project" });
    await s.controller.start({ seed: "hello" });
    expect(s.calls()).toBe(0);
    expect(JSON.stringify(s.controller.getSnapshot().transcript)).toContain("Hi!");
    await expect(s.controller.start({ seed: "build a timer" })).rejects.toThrow("Connect a provider");
    expect(s.calls()).toBe(0);
    await s.controller.dispose();
  });

  test("followups and active steering share one runtime; text and tool IDs retain native correlation", async () => {
    const s = fixture();
    let release!: () => void;
    s.setWork(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = s.controller.start({ seed: "work on this project" });
    await until(() => s.prompts.length === 1);
    s.emit({ type: "text", sourceId: "operator-source", text: "Hello " });
    s.emit({ type: "text", sourceId: "operator-source", text: "world" });
    for (const id of ["one", "two"]) {
      s.emit({ type: "tool_start", sourceId: "child-task", toolCallId: id, name: "read", args: { path: id } });
      s.emit({ type: "tool_end", sourceId: "child-task", toolCallId: id, name: "read", ok: true, text: "observed" });
    }
    expect(await s.controller.send("also check errors")).toEqual({ status: "delivered", sourceIds: ["operator-source"] });
    await s.controller.setEffort("high");
    expect(s.efforts).toEqual([]);
    release(); await first;
    s.setWork(async () => { s.emit({ type: "text", sourceId: "operator-source", text: "Second response" }); });
    await s.controller.send("explain the result");
    expect(s.calls()).toBe(1);
    expect(s.prompts).toEqual(["work on this project", "explain the result"]);
    expect(s.steering).toEqual(["also check errors"]);
    expect(s.efforts).toEqual(["high"]);
    const snapshot = s.controller.getSnapshot();
    expect(snapshot).toMatchObject({ state: "idle", runId: "operator-session", costUsd: 0.25 });
    expect(snapshot.transcript.filter((entry) => entry.kind === "tool")).toHaveLength(2);
    expect(snapshot.transcript.find((entry) => entry.id === "source:1:operator-source")).toMatchObject({ text: "Hello world", streaming: false });
    expect(snapshot.transcript.find((entry) => entry.id === "source:2:operator-source")).toMatchObject({ text: "Second response", streaming: false });
    await s.controller.dispose();
    expect(s.disposed()).toBe(1);
  });

  test("cancellation waits for runtime draining before exposing a saved, resumable session", async () => {
    const s = fixture();
    let endPrompt!: () => void, drained!: () => void;
    s.setWork(() => new Promise<void>((resolve) => { endPrompt = resolve; }));
    s.setCancellation(() => new Promise<void>((resolve) => { drained = () => { endPrompt(); resolve(); }; }));
    const work = s.controller.start({ seed: "long task" });
    await until(() => s.prompts.length === 1);
    let cancelled = false;
    const cancel = s.controller.cancel().then(() => { cancelled = true; });
    await until(() => s.cancelCalls() === 1);
    expect(cancelled).toBe(false);
    drained(); await cancel; await work;
    expect(s.controller.getSnapshot()).toMatchObject({ state: "paused", activity: "State saved" });
    s.setWork(async () => {});
    await s.controller.send("continue with the saved context");
    expect(s.calls()).toBe(1);
    await s.controller.dispose();
  });

  test("the unchanged onboarding UI retains a typed task and submits it once after login", async () => {
    const s = fixture(true); const terminal = new FakeTerminal();
    const tui = startTui(s.controller, { terminal, animations: false });
    terminal.emitInput("  build a timer  "); terminal.emitInput("\r");
    expect(tui.app.modalKind).toBe("onboarding");
    expect(s.calls()).toBe(0);
    expect(tui.app.prompt.getText()).toBe("  build a timer  ");
    await s.controller.execute("auth: login anthropic");
    await until(() => s.prompts.length === 1);
    expect(s.prompts).toEqual(["  build a timer  "]);
    expect(terminal.titles.at(-1)).toContain("kiln · operator");
    expect(tui.app.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain("work");
    await until(() => s.controller.getSnapshot().state === "idle");
    terminal.emitInput("explain it"); terminal.emitInput("\r");
    await until(() => s.prompts.length === 2);
    expect(s.calls()).toBe(1);
    await tui.stop(); await s.controller.dispose();
  });

  test("legacy resumes remain legacy and operator IDs select the operator adapter", async () => {
    const s = fixture();
    await s.controller.resume("historical-run");
    expect(s.auxiliary.resumed).toEqual(["historical-run"]);
    expect(s.calls()).toBe(0);
    expect(s.controller.getSnapshot().mode).toBeUndefined();
    const markerDir = join(s.home, "runs", "saved-operator"); mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "operator.json"), JSON.stringify({ version: 1, engine: "omp", cwd: "/tmp/user-project" }));
    const restored = fixture();
    mkdirSync(join(restored.home, "runs", "saved-operator"), { recursive: true });
    writeFileSync(join(restored.home, "runs", "saved-operator", "operator.json"), JSON.stringify({ version: 1, engine: "omp", cwd: "/tmp/user-project" }));
    await restored.controller.resume("saved-operator");
    expect(restored.calls()).toBe(1);
    expect(restored.prompts).toEqual([]);
    const bare = await createTuiController(s.home, {}, undefined, "/tmp/user-project");
    expect(bare.getSnapshot().mode).toBe("operator");
    const legacy = await createTuiController(s.home, {}, "historical-run", "/tmp/user-project");
    expect(legacy.getSnapshot().mode).toBeUndefined();
    await bare.dispose?.(); await s.controller.dispose(); await restored.controller.dispose();
  });
});

test("routing observation restores saved selection and reflects effort without opening a model session", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-route-observation-")); initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json")); auth.setApiKey("anthropic", "synthetic-test-key");
  const events: OperatorEvent[] = [];
  const createSession = async (): Promise<OmpSessionHandle> => { throw new Error("No session should open"); };
  const runtime = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, seed: "Inspect a local change", auth, createSession, onEvent: event => events.push(event) });
  const id = runtime.run.id;
  try {
    expect(events.find(event => event.type === "routing")).toMatchObject({ kind: "synthesize", scope: "operator", handoff: false, reason: "Initial selection" });
    await runtime.setEffort("high");
    expect(events.filter(event => event.type === "routing").at(-1)).toMatchObject({ effort: "high", reason: "Effort updated" });
  } finally { await runtime.dispose(); }
  const restored: OperatorEvent[] = [];
  const resumed = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, runId: id, auth, createSession, onEvent: event => restored.push(event) });
  try {
    expect(restored.find(event => event.type === "routing")).toMatchObject({ effort: "high", scope: "operator", handoff: false, reason: "Saved session selection" });
  } finally { await resumed.dispose(); }
});

test("compute warning and pause notices are visible without changing recorded usage or claiming completion", async () => {
  const s = fixture();
  await s.controller.start({ seed: "Inspect the local task" });
  try {
    s.emit({ type: "usage", costUsd: 1.25 });
    const state = s.controller.getSnapshot().state;
    for (const severity of ["warning", "pause"] as const) {
      const message = severity === "warning" ? "Repeated tool failure needs review." : "Paused after repeated identical failures; revise the instruction.";
      s.emit({ type: "compute_notice", notice: { kind: "repeated_failure", severity, message } });
      const snapshot = s.controller.getSnapshot();
      expect(snapshot.transcript.flatMap(entry => entry.kind === "brain" ? [entry.text] : []).join("\n")).toContain(`Compute monitor (${severity}): ${message}`);
      expect(snapshot.costUsd).toBe(1.25);
      expect(snapshot.state).toBe(state);
    }
  } finally { await s.controller.dispose(); }
});
