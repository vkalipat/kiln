import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { CliDeps, CliIo } from "../../src/cli/main";
import { loadConfig, ROLES } from "../../src/core/config";
import { writeAtomic } from "../../src/core/paths";
import { RunRecord } from "../../src/core/record";
import { currentRunControl } from "../../src/core/run-control";
import { createRun, readStatus, runPaths, writeStatus } from "../../src/core/run";
import { RunController, type RunControllerOptions, type TuiCli } from "../../src/tui/controller";
import { checkpointAnswerText } from "../../src/tui/controller-checkpoint";
import type { TuiEvent, TuiToolEntry } from "../../src/tui/contracts";
import { loadWorkflowPlan, workflowInterpretation } from "../../src/workflow/plan";

function home(): string {
  return mkdtempSync(join(tmpdir(), "kiln-tui-controller-"));
}

const invocationRuns = new WeakMap<string[], string>();

function withNewRun(root: string, delegate: TuiCli): TuiCli {
  return async (argv, io, deps) => {
    if (argv[0] === "run" && argv[1] === "new") {
      const seedPath = argv[argv.indexOf("--seed-file") + 1]!;
      const seed = readFileSync(seedPath, "utf8");
      const run = createRun(root, seed);
      new RunRecord(run.record).append({ t: "run.created", seed });
      invocationRuns.set(argv, run.id);
      deps.onRun?.(run);
    }
    return delegate(argv, io, deps);
  };
}

function testController(options: RunControllerOptions & { home: string }): RunController {
  return new RunController(options.cli ? { ...options, cli: withNewRun(options.home, options.cli) } : options);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function until(predicate: () => boolean, message = "condition was not reached"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

function runId(argv: readonly string[]): string {
  const id = invocationRuns.get(argv as string[]) ?? argv[2];
  if (!id) throw new Error("missing run id");
  return id;
}

describe("RunController lifecycle", () => {
  test("attaches a completed run for inspection without trying to resume it", async () => {
    const root = home();
    const run = createRun(root, "already complete", { id: "completed-run" });
    writeStatus(run, { phase: "reflect", state: "done", outcome: { kind: "success" } });
    const calls: string[][] = [];
    const controller = testController({ home: root, cli: async (argv) => { calls.push(argv); throw new Error("must not resume"); } });

    await controller.resume(run.id);

    expect(calls).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({ runId: run.id, phase: "reflect", state: "done" });
  });

  test("a new-seed admission failure before onRun cannot corrupt the previously inspected run", async () => {
    const root = home();
    const prior = createRun(root, "prior", { id: "prior-complete" });
    writeStatus(prior, { phase: "reflect", state: "done", outcome: { kind: "success" } });
    const controller = new RunController({ home: root, cli: async () => { throw new Error("routing admission failed"); } });
    await controller.resume(prior.id);

    await expect(controller.start({ seed: "new seed" })).rejects.toThrow("routing admission failed");

    expect(readStatus(prior)).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(controller.getSnapshot()).toMatchObject({ runId: prior.id, phase: "reflect", state: "done" });
  });

  test("delegates new-seed intake to the CLI without exposing the seed in argv", async () => {
    const root = home();
    const calls: string[][] = [];
    let intakePath = "";
    const cli: TuiCli = async (argv) => {
      calls.push(argv);
      intakePath = argv[argv.indexOf("--seed-file") + 1]!;
      const run = runPaths(root, runId(argv));
      expect(new RunRecord(run.record).read()[0]).toMatchObject({ t: "run.created", seed: "build a small kiln" });
      writeStatus(run, { phase: "reflect", state: "done", outcome: { kind: "success" } });
      return 0;
    };
    const controller = testController({ home: root, cli, branch: "main" });

    await controller.start({ seed: "build a small kiln" });

    const snapshot = controller.getSnapshot();
    expect(calls[0]?.slice(0, 3)).toEqual(["run", "new", "--seed-file"]);
    expect(calls[0]?.slice(-2)).toEqual(["--home", root]);
    expect(existsSync(intakePath)).toBe(false);
    expect(readStatus(runPaths(root, snapshot.runId!))).toMatchObject({ phase: "reflect", state: "done" });
    expect(snapshot).toMatchObject({ phase: "reflect", state: "done", branch: "main" });
  });

  test("lets a delivery seed's stored workflow run frame through reflect autonomously", async () => {
    const root = home();
    const phases: string[] = [];
    const model = { provider: "fixture", id: "model" } as Model;
    const models = Object.fromEntries(ROLES.map((role) => [role, model])) as NonNullable<CliDeps["models"]>;
    const advance = (phase: string, next: Parameters<typeof writeStatus>[1], d: { run: ReturnType<typeof runPaths> }) => {
      phases.push(phase);
      writeStatus(d.run, next);
      return Promise.resolve({ outcome: "ok" as const });
    };
    const controller = testController({
      home: root,
      cliDeps: {
        models,
        runFrame: (d) => advance("frame", { phase: "discover", state: "running" }, d),
        runDiscover: (d) => advance("discover", { phase: "ideate", state: "running" }, d),
        runIdeate: async (d) => {
          phases.push("ideate");
          writeStatus(d.run, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
          return { outcome: "stopped", stopKind: "rounds" };
        },
        runCheckpoint: (d) => advance("checkpoint", { phase: "form", state: "running", chosenIdeaId: "idea-a", outcome: undefined }, d),
        runForm: (d) => advance("form", { phase: "build", state: "running" }, d),
        runBuild: (d) => advance("build", { phase: "reflect", state: "running" }, d),
        runReflect: async (d) => {
          phases.push("reflect");
          writeStatus(d.run, { phase: "reflect", state: "done", outcome: { kind: "success" } });
          return { outcome: "ok" };
        },
      },
    });

    await controller.start({ seed: "Build and ship the real main path" });

    expect(phases).toEqual(["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"]);
    expect(controller.getSnapshot()).toMatchObject({ phase: "reflect", state: "done" });
  });

  test("a fresh TUI seed uses the same adaptive planner as CLI run new", async () => {
    const root = home();
    let observedRoutingMode = "";
    const controller = new RunController({
      home: root,
      cliDeps: {
        apiKeyFor: async (provider) => provider === "anthropic" ? "test-only-key" : undefined,
        runFrame: async (deps) => {
          observedRoutingMode = deps.cfg.routing?.mode ?? "";
          writeStatus(deps.run, { phase: "reflect", state: "done", outcome: { kind: "success" } });
          return { outcome: "ok" };
        },
      },
    });

    await controller.start({ seed: "Explore resilient neighborhood cooling businesses" });

    const snapshot = controller.getSnapshot();
    expect(observedRoutingMode).toBe("adaptive");
    expect(loadConfig(root)).toMatchObject({ routing: { mode: "adaptive" }, autonomous: true });
    expect(JSON.parse(readFileSync(join(runPaths(root, snapshot.runId!).dir, "routing.json"), "utf8"))).toMatchObject({
      version: 1,
      report: { status: "ready" },
    });
    expect(snapshot).toMatchObject({ phase: "reflect", state: "done" });
    const interpretation = workflowInterpretation(loadWorkflowPlan(runPaths(root, snapshot.runId!))!);
    expect(snapshot.transcript.filter((entry) => entry.kind === "brain" && entry.text === interpretation)).toHaveLength(1);
  });

  test("refuses overlapping starts without creating a second run", async () => {
    const root = home();
    const release = deferred();
    let entered = false;
    const controller = testController({ home: root, cli: async () => { entered = true; await release.promise; return 0; } });
    const first = controller.start({ seed: "first" });
    await until(() => entered);

    await expect(controller.start({ seed: "second" })).rejects.toThrow("already active");
    release.resolve();
    await first;
    expect(new RunRecord(runPaths(root, controller.getSnapshot().runId!).record).read().filter((event) => event.t === "run.created")).toHaveLength(1);
  });

  test("restores bounded journal excerpts and explicitly disclaims full replay", async () => {
    const root = home();
    const run = createRun(root, "restart seed", { id: "restart-run" });
    const record = new RunRecord(run.record);
    record.append({ t: "run.created", seed: "restart seed" });
    record.append({ t: "tool.call", name: "search", args: { q: "kiln" }, ok: true, durationMs: 1, excerpt: "three durable hits" });
    const controller = testController({ home: root, cli: async () => 0 });

    await controller.resume(run.id);

    const transcript = controller.getSnapshot().transcript;
    expect(transcript[0]).toMatchObject({ kind: "brain", text: expect.stringContaining("not a full transcript replay") });
    expect(transcript).toContainEqual(expect.objectContaining({ kind: "tool", verb: "search", body: "three durable hits" }));
  });

  test("restarts a user-cancelled frame from its durable boundary", async () => {
    const root = home();
    const run = createRun(root, "resume cancelled", { id: "cancelled-frame" });
    writeStatus(run, { state: "paused", pausedReason: "user_cancelled", cursor: { step: "user_cancelled" } });
    const model = { provider: "fixture", id: "brain" } as Model;
    let resumed = false;
    const controller = testController({
      home: root,
      cliDeps: {
        models: { brain: model },
        runFrame: async (d) => {
          resumed = true;
          expect(readStatus(d.run).state).toBe("running");
          expect(readStatus(d.run).pausedReason).toBeUndefined();
          writeStatus(d.run, { state: "done", outcome: { kind: "honest_exit", exitKind: "underspecified", reasons: ["fixture"] } });
          return { outcome: "honest_exit", kind: "underspecified", reasons: ["fixture"] };
        },
      },
    });

    await controller.resume(run.id);

    expect(resumed).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: "frame", state: "done" });
  });
});

describe("RunController observation and steering", () => {
  test("preserves steering queued while adaptive new-run planning is still attaching", async () => {
    const root = home();
    const planning = deferred();
    const attach = deferred();
    const steered: string[] = [];
    const cli: TuiCli = async (argv, _io, deps) => {
      planning.resolve();
      await attach.promise;
      const seedPath = argv[argv.indexOf("--seed-file") + 1]!;
      const seed = readFileSync(seedPath, "utf8");
      const run = createRun(root, seed);
      new RunRecord(run.record).append({ t: "run.created", seed });
      deps.onRun?.(run);
      const source = currentRunControl()!.registerSource({ role: "brain", phase: "frame", steer: (text) => steered.push(text) });
      source.text("attached");
      source.dispose();
      writeStatus(run, { phase: "reflect", state: "done", outcome: { kind: "success" } });
      return 0;
    };
    const controller = new RunController({ home: root, cli });
    const running = controller.start({ seed: "plan before attaching" });
    await planning.promise;
    expect(await controller.send("retain this steering")).toMatchObject({ status: "queued" });
    attach.resolve();
    await running;

    expect(steered).toEqual(["retain this steering"]);
  });

  test("correlates identical tool ids by source and coalesces streaming text", async () => {
    const root = home();
    const cli: TuiCli = async (argv) => {
      const control = currentRunControl()!;
      new RunRecord(runPaths(root, runId(argv)).record).append({
        t: "model.call", role: "brain", provider: "fixture", model: "model", inputHash: "hash",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 1.25, stopReason: "stop", excerpt: "one stream",
      });
      const left = control.registerSource({ role: "brain", phase: "frame" });
      const right = control.registerSource({ role: "builder", phase: "build" });
      left.text("one "); left.text("stream");
      left.toolStart("same", "bash", { command: "left" });
      right.toolStart("same", "bash", { command: "right" });
      right.toolEnd("same", "bash", false, "right failed");
      left.toolEnd("same", "bash", true, "left passed");
      left.dispose(); right.dispose();
      writeStatus(runPaths(root, runId(argv)), { phase: "reflect", state: "done", outcome: { kind: "success" } });
      return 0;
    };
    const controller = testController({ home: root, cli });

    await controller.start({ seed: "observe" });

    const text = controller.getSnapshot().transcript.find((entry) => entry.kind === "brain" && entry.text.includes("one"));
    const tools = controller.getSnapshot().transcript.filter((entry): entry is TuiToolEntry => entry.kind === "tool" && entry.verb === "bash");
    expect(text).toMatchObject({ text: "one stream", streaming: false });
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(2);
    expect(controller.getSnapshot().costUsd).toBe(1.25);
    expect(tools.map((tool) => [tool.args, tool.status, tool.body])).toEqual([
      ['{"command":"left"}', "done", "left passed"],
      ['{"command":"right"}', "error", "right failed"],
    ]);
  });

  test("queues steering until a steerable source becomes active", async () => {
    const root = home();
    const entered = deferred();
    const register = deferred();
    const scoutObserved = deferred();
    const allowSteerable = deferred();
    const steered: string[] = [];
    const cli: TuiCli = async () => {
      entered.resolve();
      await register.promise;
      const scout = currentRunControl()!.registerSource({ role: "scout", phase: "discover", steer: (text) => steered.push(`scout:${text}`) });
      scout.text("scout result");
      scout.dispose();
      scoutObserved.resolve();
      await allowSteerable.promise;
      const source = currentRunControl()!.registerSource({ role: "brain", phase: "discover", steer: (text) => steered.push(text) });
      source.text("ready");
      source.dispose();
      return 0;
    };
    const controller = testController({ home: root, cli });
    const deliveries: TuiEvent[] = [];
    controller.subscribe((event) => { if (event.type === "steering_delivered") deliveries.push(event); });
    const running = controller.start({ seed: "queue" });
    await entered.promise;

    const first = await controller.send("look for ceramic prior art");
    const second = await controller.send("look for ceramic prior art");
    expect(first).toEqual({ status: "queued", sendId: "send:1" });
    expect(second).toEqual({ status: "queued", sendId: "send:2" });
    expect(steered).toEqual([]);
    register.resolve();
    await scoutObserved.promise;
    expect(deliveries).toEqual([]);
    expect(steered).toEqual([]);
    allowSteerable.resolve();
    await running;
    expect(steered).toEqual(["look for ceramic prior art", "look for ceramic prior art"]);
    expect(deliveries).toEqual([
      expect.objectContaining({ type: "steering_delivered", sendId: "send:1", text: "look for ceramic prior art", sourceIds: ["discover:brain:2"] }),
      expect.objectContaining({ type: "steering_delivered", sendId: "send:2", text: "look for ceramic prior art", sourceIds: ["discover:brain:2"] }),
    ]);
  });

  test("reports direct steering delivery without queuing an event", async () => {
    const root = home();
    const ready = deferred();
    const release = deferred();
    const steered: string[] = [];
    const controller = testController({
      home: root,
      cli: async () => {
        const source = currentRunControl()!.registerSource({ role: "brain", phase: "frame", steer: (text) => steered.push(text) });
        ready.resolve();
        await release.promise;
        source.dispose();
        return 0;
      },
    });
    const events: TuiEvent[] = [];
    controller.subscribe((event) => { if (event.type === "steering_delivered") events.push(event); });
    const running = controller.start({ seed: "direct" });
    await ready.promise;
    expect(await controller.send("steer now")).toEqual({ status: "delivered", sourceIds: ["frame:brain:1"] });
    expect(steered).toEqual(["steer now"]);
    expect(events).toEqual([]);
    release.resolve();
    await running;
  });

  test("isolates faulty subscribers", async () => {
    const root = home();
    const controller = testController({ home: root, cli: async () => 0 });
    const events: TuiEvent[] = [];
    controller.subscribe(() => { throw new Error("renderer broke"); });
    controller.subscribe((event) => events.push(event));
    await controller.start({ seed: "listeners" });
    expect(events.some((event) => event.type === "snapshot")).toBe(true);
  });

  test("uses send as the answer to a generic CLI question", async () => {
    const root = home();
    let answer = "";
    const controller = testController({
      home: root,
      cli: async (_argv, io) => { answer = await io.ask!("Name the output directory: "); return 0; },
    });
    const running = controller.start({ seed: "ask" });
    await until(() => controller.getSnapshot().transcript.some((entry) => entry.kind === "brain" && entry.text.includes("output directory")));
    expect(await controller.send("./prototype")).toEqual({ status: "answered" });
    await running;
    expect(answer).toBe("./prototype");
  });
});

describe("RunController checkpoint, effort, and palette", () => {
  test("bridges checkpoint events to the CLI's exact answer syntax", async () => {
    const root = home();
    const run = createRun(root, "checkpoint", { id: "checkpoint-run" });
    new RunRecord(run.record).append({ t: "run.created", seed: "checkpoint" });
    const ids = ["a", "b", "c", "d"];
    writeAtomic(run.frontier, `${JSON.stringify({
      version: 1, mode: "loop", round: 2, rawFront: ids, shown: ids, eligible: ids,
      ideas: ids.map((id, index) => ({ id, backfill: false, cell: `cell-${index}`, value: { mean: 4 - index, lo: 0, hi: 1 }, feasibility: { mean: index, lo: 0, hi: 1 } })),
      ladders: { value: ids, feasibility: [...ids].reverse() }, searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true,
    })}\n`);
    writeStatus(run, { phase: "ideate", state: "stopped", cursor: { round: 2, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
    const answers: string[] = [];
    const cli: TuiCli = async (_argv, io) => {
      answers.push(await io.ask!("Group 1: a, b, c, d\nEnter best <id> worst <id>: "));
      answers.push(await io.ask!("Choose: pick <id> | reject <id> <reason> | another <steering>: "));
      writeStatus(run, { phase: "form", state: "running", chosenIdeaId: "a", outcome: undefined });
      return 0;
    };
    const controller = testController({ home: root, cli });
    const checkpoints: TuiEvent[] = [];
    controller.subscribe((event) => { if (event.type === "checkpoint") checkpoints.push(event); });
    const running = controller.resume(run.id);
    await until(() => controller.getSnapshot().checkpoint?.groupIndex === 0);

    await expect(controller.answerCheckpoint({ kind: "bws", groupIndex: 1, best: "a", worst: "d" })).rejects.toThrow("waiting for group 1");
    await controller.answerCheckpoint({ kind: "bws", groupIndex: 0, best: "a", worst: "d" });
    await until(() => controller.getSnapshot().checkpoint?.groupIndex === 4);
    await controller.answerCheckpoint({ kind: "pick", id: "a" });
    await running;

    expect(answers).toEqual(["best a worst d", "pick a"]);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]).toMatchObject({ type: "checkpoint", checkpoint: { valueLadder: ids, groupIndex: 4 } });
    expect(controller.getSnapshot().checkpoint).toBeUndefined();
    expect(checkpointAnswerText({ kind: "reject", id: "b", reason: "too costly" })).toBe("reject b too costly");
    expect(checkpointAnswerText({ kind: "another_round", steering: "focus on heat" })).toBe("another focus on heat");
  });

  test("queues effort for future new runs without claiming to mutate frozen live routing", async () => {
    const root = home();
    const ready = deferred();
    const release = deferred();
    const steering: string[] = [];
    const cli: TuiCli = async () => {
      const source = currentRunControl()!.registerSource({ role: "brain", phase: "frame", steer: (text) => steering.push(text) });
      ready.resolve();
      await release.promise;
      source.dispose();
      return 0;
    };
    const controller = testController({ home: root, cli });
    const running = controller.start({ seed: "effort" });
    await ready.promise;

    await controller.setEffort("xhigh");
    expect(controller.getSnapshot().effort).toBe("medium");
    expect(controller.getSnapshot().activity).toContain("future new runs");
    expect(loadConfig(root).effort).toBe("medium");
    expect(steering).toEqual([]);
    release.resolve();
    await running;
    expect(loadConfig(root).effort).toBe("xhigh");
    expect(controller.getSnapshot().effort).toBe("ultra");
    expect(new Set(Object.values(loadConfig(root).effortByRole ?? {}))).toEqual(new Set(["xhigh"]));
  });

  test("dispatches exact palette routes through the injected CLI and surfaces output", async () => {
    const root = home();
    const calls: string[][] = [];
    const cli: TuiCli = async (argv, io: CliIo) => { calls.push(argv); io.write("record output\n"); return 0; };
    const controller = testController({ home: root, cli });

    await controller.execute("run: show record", ["run-7"]);
    await controller.execute("build: start", ["run-7", "--yes"]);
    await expect(controller.execute("missing: command")).rejects.toThrow("unknown palette command");

    expect(calls).toEqual([
      ["run", "record", "run-7", "--home", root],
      ["build", "start", "run-7", "--yes", "--home", root],
    ]);
    expect(controller.getSnapshot().transcript).toContainEqual(expect.objectContaining({ kind: "brain", text: "record output" }));
  });

  test("runs mode toggle through main and refreshes the displayed effort", async () => {
    const root = home();
    const controller = testController({ home: root });
    expect(controller.getSnapshot().effort).toBe("medium");
    await controller.execute("mode: toggle");
    expect(loadConfig(root).effort).toBe("high");
    expect(controller.getSnapshot().effort).toBe("high");
  });

  test("routes secret CLI questions without recording the answer", async () => {
    const root = home();
    const ready = deferred();
    const cli: TuiCli = async (_argv, io) => {
      ready.resolve();
      expect(await io.askSecret?.("API key: ")).toBe("sk-private-value");
      return 0;
    };
    const controller = testController({ home: root, cli });
    const events: TuiEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const running = controller.execute("auth: login anthropic");
    await ready.promise;
    await until(() => events.some((event) => event.type === "input_requested"));
    expect(await controller.send("sk-private-value")).toEqual({ status: "answered" });
    await running;
    expect(JSON.stringify(controller.getSnapshot().transcript)).not.toContain("sk-private-value");
    expect(events).toContainEqual({ type: "input_requested", prompt: "API key: ", secret: true });
    expect(events.some((event) => event.type === "input_cleared")).toBe(true);
  });

  test("redacts a submitted credential from provider output and thrown errors", async () => {
    const root = home();
    const ready = deferred();
    const secret = "sk-provider-echoed-secret";
    const cli: TuiCli = async (_argv, io) => {
      ready.resolve();
      const value = await io.askSecret?.("API key: ");
      io.write(`provider rejected ${value}\n`);
      io.error?.(`denied ${value}\n`);
      throw new Error(`authentication failed for ${value}`);
    };
    const controller = testController({ home: root, cli });
    const events: TuiEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const running = controller.execute("auth: login anthropic");
    await ready.promise;
    await until(() => events.some((event) => event.type === "input_requested"));
    await controller.send(secret);
    let failure = "";
    try { await running; } catch (error) { failure = String(error); }

    expect(failure).toContain("[REDACTED]");
    expect(failure).not.toContain(secret);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
