import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { main } from "../../src/cli/main";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { acquireRunLock } from "../../src/core/lock";
import { RunRecord } from "../../src/core/record";
import { createRun, readStatus, runPaths, writeStatus } from "../../src/core/run";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { parseBrief } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { loadSeeds } from "../../src/evals/seeds";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery";
const BRIEF = `# Brief\n\n## Problem\np\n\n## Constraints\n- c\n\n## Search success\n- s\n\n## Non-goals\n- n\n\n## Shape\nproduct\n\n## Axes\n${AXES}\n\n## Discovery questions\n- Q1?\n- Q2?\n`;
const LANDSCAPE = "# Landscape\n\n## Obvious list\n- o\n\n## Atoms\n- a (common)\n\n## Tensions\n- t\n\n## Distant domains\n- d\n";

/** A brain that writes whichever phase output its pinned contract names, then says it is done. */
function brainWriter(extra: Record<string, unknown> = {}) {
  return createMockModel({
    id: "brain",
    handler: async (ctx: { systemPrompt?: string[] }) => {
      const target = /Output file: (\S+)/.exec((ctx.systemPrompt ?? []).join("\n"))?.[1] ?? "";
      if (target.endsWith("brief.md") && !existsSync(target)) return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: BRIEF } }] };
      if (target.endsWith("landscape.md") && !existsSync(target)) return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: LANDSCAPE } }] };
      return { content: ["done"] };
    },
    ...extra,
  } as never);
}

function deps(brainModel = brainWriter()) {
  const scoutModel = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding (https://x)"] }) } as never);
  return { streamFn: streamMock as never, brainModel: brainModel as never, scoutModel: scoutModel as never, apiKeyFor: async () => "k" };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { write: (s: string) => out.push(s), error: (s: string) => err.push(s) } };
}

describe("kiln run", () => {
  test("rejects an unknown through value before creating a run", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); const a = io();
    expect(await main(["run", "new", "seed", "--home", home, "--through", "nonsense"], a.io, {})).toBe(2);
    expect(readdirSync(join(home, "runs"))).toEqual([]);
    expect(a.err.join("")).toContain("unknown --through value");
  });

  test("prints the projected ideate table and can decline before any paid round", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const run = createRun(home, "seed", { id: "projection" }); writeFileSync(run.brief, BRIEF); writeFileSync(run.landscape, LANDSCAPE);
    const parsed = parseBrief(BRIEF); writeStatus(run, { phase: "ideate", shape: parsed.shape, shapeHash: shapeHash(parsed) });
    const model = createMockModel({ id: "unused", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, responses: [{ content: ["unused"] }] as never });
    const roles = ["brain", "scout", "judge", "generator", "prober", "arbiter", "builder", "auditor", "critic", "reflector"];
    const a = io();
    expect(await main(["run", "resume", run.id, "--home", home, "--through", "ideate"], { ...a.io, ask: async () => "no" }, { models: Object.fromEntries(roles.map((role) => [role, model])) as never, apiKeyFor: async () => "k" })).toBe(0);
    expect(a.out.join("")).toContain("estimated cost");
    expect(a.out.join("")).toContain("ideate cancelled");
    expect(new RunRecord(run.record).read().some((event) => event.t === "phase.start" && event.phase === "ideate")).toBe(false);
    expect(readStatus(run).state).toBe("running");
  });

  test("resume routes a rounds stop to checkpoint and an empty budget stop back to the mechanical precheck", async () => {
    const model = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
    const roleNames = ["brain", "scout", "judge", "generator", "prober", "arbiter", "builder", "auditor", "critic", "reflector"];
    const injected = { streamFn: streamMock as never, models: Object.fromEntries(roleNames.map((role) => [role, model])) as never, apiKeyFor: async () => "k", fetchUsage: async () => ({ used: 0, limit: 1 }) };

    const checkpointHome = mkdtempSync(join(tmpdir(), "kiln-")); initHome(checkpointHome);
    const checkpointRun = createRun(checkpointHome, "seed", { id: "rounds-stop" });
    writeFileSync(checkpointRun.frontier, JSON.stringify({ version: 1, mode: "loop", round: 1, rawFront: ["r1-i1-1"], shown: ["r1-i1-1"], eligible: ["r1-i1-1"], ideas: [{ id: "r1-i1-1", backfill: false, cell: "c" }], ladders: { value: ["r1-i1-1"], feasibility: ["r1-i1-1"] }, searchHealth: 1, searchHealthFloor: 0.8, noveltyEnforced: true }));
    writeFileSync(join(checkpointRun.renderedDir, "r1-i1-1-r1.md"), "# one\n");
    writeStatus(checkpointRun, { phase: "ideate", state: "stopped", cursor: { round: 1, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
    const checkpointIo = io();
    const held = acquireRunLock(checkpointRun);
    expect(await main(["run", "resume", checkpointRun.id, "--home", checkpointHome, "--autonomous", "--json"], checkpointIo.io, { apiKeyFor: async () => undefined })).toBe(2);
    expect(readStatus(checkpointRun).chosenIdeaId).toBeUndefined();
    expect(await main(["run", "resume", checkpointRun.id, "--home", checkpointHome, "--autonomous", "--force", "--json"], checkpointIo.io, { apiKeyFor: async () => undefined })).toBe(0);
    held.release();
    expect(readStatus(checkpointRun)).toMatchObject({ phase: "form", state: "running", chosenIdeaId: "r1-i1-1" });

    const budgetHome = mkdtempSync(join(tmpdir(), "kiln-")); initHome(budgetHome); const cfg = defaultConfig(); cfg.budgets.usd = 0; saveConfig(budgetHome, cfg);
    const budgetRun = createRun(budgetHome, "seed", { id: "budget-stop" }); writeFileSync(budgetRun.brief, BRIEF); writeFileSync(budgetRun.landscape, LANDSCAPE);
    const parsedBudget = parseBrief(BRIEF); writeStatus(budgetRun, { phase: "ideate", state: "stopped", shape: parsedBudget.shape, shapeHash: shapeHash(parsedBudget), cursor: { round: 1, step: "round.start" }, outcome: { kind: "stopped", stopKind: "budget", frontierEmpty: true } });
    const budgetIo = io();
    expect(await main(["run", "resume", budgetRun.id, "--home", budgetHome, "--yes", "--json"], budgetIo.io, injected)).toBe(0);
    expect(readStatus(budgetRun)).toMatchObject({ state: "stopped", outcome: { kind: "stopped", stopKind: "budget", frontierEmpty: true } });
    expect(new RunRecord(budgetRun.record).read().filter((event) => event.t === "model.call")).toHaveLength(0);
  });

  test("a paused run waits for wakeAt and resumes after it elapses", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home); const cfg = defaultConfig(); cfg.budgets.usd = 0; saveConfig(home, cfg);
    const run = createRun(home, "seed", { id: "paused" }); writeFileSync(run.brief, BRIEF); writeFileSync(run.landscape, LANDSCAPE);
    writeFileSync(run.metrics, JSON.stringify({ cost: { build: { usdPerSuccess: 1.25 } } }));
    const parsed = parseBrief(BRIEF); writeStatus(run, { phase: "ideate", state: "paused", shape: parsed.shape, shapeHash: shapeHash(parsed), wakeAt: "2999-01-01T00:00:00.000Z", pausedReason: "usage" });
    const waiting = io();
    expect(await main(["run", "resume", run.id, "--home", home, "--json"], waiting.io, { apiKeyFor: async () => undefined })).toBe(0);
    expect(JSON.parse(waiting.out.join("")).cost.build.usdPerSuccess).toBe(1.25);
    expect(readStatus(run).state).toBe("paused");

    writeStatus(run, { wakeAt: "2000-01-01T00:00:00.000Z" });
    const model = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
    const roles = ["brain", "scout", "judge", "generator", "prober", "arbiter", "builder", "auditor", "critic", "reflector"];
    const resumed = io();
    expect(await main(["run", "resume", run.id, "--home", home, "--yes", "--json"], resumed.io, { streamFn: streamMock as never, models: Object.fromEntries(roles.map((role) => [role, model])) as never, apiKeyFor: async () => "k", fetchUsage: async () => ({ used: 0, limit: 1 }) })).toBe(0);
    expect(readStatus(run)).toMatchObject({ state: "stopped", outcome: { kind: "stopped", stopKind: "budget" } });
  });

  test("--through frame stops after the brief and leaves the run resumable", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const a = io();
    expect(await main(["run", "new", "seed text", "--home", home, "--through", "frame", "--json"], a.io, deps())).toBe(0);
    const summary = JSON.parse(a.out.join(""));
    expect(summary.status.phase).toBe("discover");
    expect(summary.status.state).toBe("running");
    expect(existsSync(join(summary.dir, "brief.md"))).toBe(true);
    expect(existsSync(join(summary.dir, "landscape.md"))).toBe(false);
    expect(typeof summary.status.usdSpent).toBe("number");
  });

  test("resume finishes discover on a run stopped after frame", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const a = io();
    await main(["run", "new", "seed text", "--home", home, "--through", "frame", "--json"], a.io, deps());
    const id = JSON.parse(a.out.join("")).id as string;

    const b = io();
    expect(await main(["run", "resume", id, "--home", home, "--through", "discover", "--json"], b.io, deps())).toBe(0);
    const resumed = JSON.parse(b.out.join(""));
    expect(resumed.id).toBe(id);
    expect(resumed.status.phase).toBe("ideate");
    expect(readFileSync(join(resumed.dir, "landscape.md"), "utf8")).toBe(LANDSCAPE);
  });

  test("resume on an unknown id exits 2", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const a = io();
    expect(await main(["run", "resume", "nope", "--home", home], a.io, deps())).toBe(2);
    expect(a.err.join("")).toMatch(/unknown run/);
  });

  test("list shows every run as a table and as json", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const a = io();
    await main(["run", "new", "seed one", "--home", home, "--through", "frame", "--json"], a.io, deps());
    const id = JSON.parse(a.out.join("")).id as string;

    const t = io();
    expect(await main(["run", "list", "--home", home], t.io, deps())).toBe(0);
    expect(t.out.join("")).toMatch(/^id\s+phase\s+state\s+cost\s+created/);
    expect(t.out.join("")).toContain(id);

    const j = io();
    expect(await main(["run", "list", "--home", home, "--json"], j.io, deps())).toBe(0);
    const rows = JSON.parse(j.out.join(""));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].phase).toBe("discover");
    expect(typeof rows[0].costUsd).toBe("number");
  });

  test("show prints files, cost, and the tail of the record", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const a = io();
    await main(["run", "new", "seed one", "--home", home, "--through", "discover", "--json"], a.io, deps());
    const id = JSON.parse(a.out.join("")).id as string;

    const t = io();
    expect(await main(["run", "show", id, "--home", home], t.io, deps())).toBe(0);
    const text = t.out.join("");
    expect(text).toContain(`run ${id}: ideate running`);
    expect(text).toContain("brief.md");
    expect(text).toContain("landscape.md");
    expect(text).toContain("discovery/");

    const j = io();
    expect(await main(["run", "show", id, "--home", home, "--json"], j.io, deps())).toBe(0);
    const v = JSON.parse(j.out.join(""));
    expect(v.files).toContain("landscape.md");
    expect(v.lastEvents.length).toBeGreaterThan(0);
    expect(v.lastEvents.at(-1).t).toBe("phase.end");

    const bad = io();
    expect(await main(["run", "show", "nope", "--home", home], bad.io, deps())).toBe(2);
    expect(bad.err.join("")).toMatch(/unknown run/);
  });

  test("usdSpent is written on an honest-exit terminal path too", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const exiting = createMockModel({
      id: "brain",
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      handler: async () => ({ content: [{ type: "toolCall", name: "exit", arguments: { kind: "underspecified", reasons: ["no domain"] } }], usage: { input: 1_000_000 } }),
    } as never);
    const a = io();
    expect(await main(["run", "new", "vague", "--home", home, "--json"], a.io, deps(exiting))).toBe(0);
    const summary = JSON.parse(a.out.join(""));
    expect(summary.status.state).toBe("done");
    expect(summary.status.outcome.kind).toBe("honest_exit");
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(summary.status.usdSpent).toBe(summary.costUsd);
  });

  test("an exception inside a phase is recorded, marks the run failed, and exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const a = io();
    await main(["run", "new", "seed text", "--home", home, "--through", "frame", "--json"], a.io, deps());
    const first = JSON.parse(a.out.join(""));

    // A corrupted run directory: `discovery/` is a plain file, so writing a findings file inside
    // it throws out of the phase rather than returning a classified result.
    rmSync(join(first.dir, "discovery"), { recursive: true });
    writeFileSync(join(first.dir, "discovery"), "not a directory\n");
    const b = io();
    expect(await main(["run", "resume", first.id, "--home", home, "--json"], b.io, deps())).toBe(1);
    expect(b.err.join("")).toMatch(/discovery/);

    const status = JSON.parse(readFileSync(join(first.dir, "status.json"), "utf8"));
    expect(status.state).toBe("failed");
    expect(status.outcome.kind).toBe("failure");
    expect(typeof status.usdSpent).toBe("number");
    const events = readFileSync(join(first.dir, "record.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.t === "failure" && typeof e.class === "string")).toBe(true);
  });

  test("resume dispatches running form, build, and reflect without resolving earlier seats", async () => {
    const model = createMockModel({ id: "seat", responses: [{ content: ["unused"] }] as never });

    const formHome = mkdtempSync(join(tmpdir(), "kiln-")); initHome(formHome);
    const formRun = createRun(formHome, "seed", { id: "form" }); writeStatus(formRun, { phase: "form", chosenIdeaId: "idea-a" });
    let formed = 0;
    expect(await main(["run", "resume", formRun.id, "--home", formHome, "--through", "form", "--json"], io().io, {
      models: { brain: model as never }, apiKeyFor: async () => "key",
      runForm: async (d) => { formed++; writeStatus(d.run, { phase: "build" }); return { outcome: "ok" }; },
    })).toBe(0);
    expect(formed).toBe(1);

    const buildHome = mkdtempSync(join(tmpdir(), "kiln-")); initHome(buildHome);
    const buildRun = createRun(buildHome, "seed", { id: "build" }); writeStatus(buildRun, { phase: "build" });
    let built = 0;
    expect(await main(["run", "resume", buildRun.id, "--home", buildHome, "--through", "build", "--yes", "--json"], io().io, {
      models: { builder: model as never }, apiKeyFor: async () => "key",
      runBuild: async (d) => { built++; writeStatus(d.run, { phase: "reflect" }); return { outcome: "ok" }; },
    })).toBe(0);
    expect(built).toBe(1); expect(readStatus(buildRun).phase).toBe("reflect");

    const reflectHome = mkdtempSync(join(tmpdir(), "kiln-")); initHome(reflectHome);
    const reflectRun = createRun(reflectHome, "seed", { id: "reflect" }); writeStatus(reflectRun, { phase: "reflect" });
    let reflected = 0;
    expect(await main(["run", "resume", reflectRun.id, "--home", reflectHome, "--json"], io().io, {
      models: { reflector: model as never }, apiKeyFor: async () => "key",
      runReflect: async (d) => { reflected++; writeStatus(d.run, { state: "done", outcome: { kind: "success" } }); return { outcome: "ok" }; },
    })).toBe(0);
    expect(reflected).toBe(1);
  });

  test.each(["frame", "discover"] as const)("a user-cancelled %s run clears its pause before early-phase dispatch", async (phase) => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const run = createRun(home, "seed", { id: `cancelled-${phase}` });
    writeStatus(run, { phase, state: "paused", pausedReason: "user_cancelled", cursor: { step: "user_cancelled" } });
    const model = createMockModel({ id: phase, responses: [{ content: ["unused"] }] as never });
    let calls = 0;
    const runner = async () => {
      calls++;
      expect(readStatus(run)).toMatchObject({ phase, state: "running" });
      expect(readStatus(run).pausedReason).toBeUndefined();
      writeStatus(run, { phase: phase === "frame" ? "discover" : "ideate", state: "running" });
      return { outcome: "ok" } as const;
    };
    const code = await main(["run", "resume", run.id, "--home", home, "--through", phase, "--json"], io().io, {
      models: { brain: model as never, scout: model as never }, apiKeyFor: async () => "key",
      ...(phase === "frame" ? { runFrame: runner } : { runDiscover: runner }),
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
  });

  test("durable stopped, complete, and integrity states route before any model discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home); const cfg = defaultConfig(); saveConfig(home, cfg);
    const stopped = createRun(home, "seed", { id: "stopped" });
    writeStatus(stopped, { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget", budgetTargetUsd: cfg.budgets.usd } });
    let keyCalls = 0; const a = io();
    expect(await main(["run", "resume", stopped.id, "--home", home, "--through", "reflect", "--json"], a.io, { apiKeyFor: async () => { keyCalls++; return "key"; } })).toBe(0);
    expect(keyCalls).toBe(0); expect(JSON.parse(a.out.join("")).status.state).toBe("stopped");

    const done = createRun(home, "seed", { id: "done" }); writeStatus(done, { state: "done", outcome: { kind: "success" } });
    const doneIo = io(); expect(await main(["run", "resume", done.id, "--home", home], doneIo.io, {})).toBe(2); expect(doneIo.err.join("")).toContain("run is complete");
    const failed = createRun(home, "seed", { id: "failed" }); writeStatus(failed, { phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "integrity", message: "bad" } });
    const failedIo = io(); expect(await main(["run", "resume", failed.id, "--home", home], failedIo.io, {})).toBe(2); expect(failedIo.err.join("")).toContain("project relock");
  });

  test("cancellation stays control flow instead of becoming a failed run", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const run = createRun(home, "seed", { id: "cancel" }); const control = new RunControl();
    const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never });
    const promise = withRunControl(control, () => main(["run", "resume", run.id, "--home", home, "--through", "frame", "--json"], io().io, {
      models: { brain: model as never }, apiKeyFor: async () => "key",
      runFrame: async () => { control.cancel("stop"); return { outcome: "ok" }; },
    }));
    await expect(promise).rejects.toBeInstanceOf(RunCancelledError);
    expect(readStatus(run)).toMatchObject({ state: "paused", pausedReason: "user_cancelled" });
    expect(new RunRecord(run.record).read().some((event) => event.t === "failure")).toBe(false);
  });

  test("run new resolves seed-id and ordinary argv identity before creating the run", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const dev = loadSeeds(home, "dev")[0]!;
    const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never });
    const finishFrame = async (d: any) => { writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" } as const; };

    const registered = io();
    expect(await main(["run", "new", "--seed-id", dev.id, "--home", home, "--through", "frame", "--json"], registered.io, {
      models: { brain: model as never }, apiKeyFor: async () => "key", runFrame: finishFrame,
    })).toBe(0);
    const registeredSummary = JSON.parse(registered.out.join(""));
    expect(registeredSummary.status.seed).toEqual({ id: dev.id, split: "dev", sha256: dev.sha256 });
    expect(readFileSync(join(registeredSummary.dir, "seed.md"), "utf8")).toBe(dev.text);

    const ordinary = io();
    expect(await main(["run", "new", "an ordinary unregistered user request", "--home", home, "--through", "frame", "--json"], ordinary.io, {
      models: { brain: model as never }, apiKeyFor: async () => "key", runFrame: finishFrame,
    })).toBe(0);
    expect(JSON.parse(ordinary.out.join("")).status.seed).toBeUndefined();
  });

  test("held-out seed-id, seed-file, and pasted text refuse before createRun without an active eval", async () => {
    for (const source of ["id", "file", "pasted"] as const) {
      const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
      const heldout = loadSeeds(home, "heldout")[0]!; const a = io();
      const argv = source === "id" ? ["run", "new", "--seed-id", heldout.id]
        : source === "file" ? ["run", "new", "--seed-file", heldout.path]
          : ["run", "new", heldout.text];
      expect(await main([...argv, "--home", home, "--through", "frame", "--json"], a.io, {})).toBe(1);
      expect(a.err.join("")).toContain(heldout.id);
      expect(readdirSync(join(home, "runs"))).toEqual([]);
    }
  });

  test("an in-progress eval admits a held-out seed and stamps its authoritative identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home); const heldout = loadSeeds(home, "heldout")[0]!;
    mkdirSync(join(home, "evolution", "work", "eval-1"), { recursive: true });
    mkdirSync(join(home, "evolution", "reports", "eval-1"), { recursive: true });
    writeFileSync(join(home, "evolution", "reports", "eval-1", "eval.json"), '{"evalId":"eval-1","verdict":"incomplete"}\n');
    const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never }); const a = io();
    expect(await main(["run", "new", "--seed-id", heldout.id, "--eval", "eval-1", "--home", home, "--through", "frame", "--json"], a.io, {
      models: { brain: model as never }, apiKeyFor: async () => "key",
      runFrame: async (d) => { writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
    })).toBe(0);
    const summary = JSON.parse(a.out.join(""));
    expect(summary.status.seed).toEqual({ id: heldout.id, split: "heldout", sha256: heldout.sha256 });
    expect(summary.dir).toContain(join("evolution", "work", "eval-1", "manual", "runs"));
    expect(readdirSync(join(home, "runs"))).toEqual([]);
  });

  test("eval manifest drift is noted on new and resume without blocking either command", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const heldout = loadSeeds(home, "heldout")[0]!; writeFileSync(heldout.path, `${heldout.text.trimEnd()} changed\n`);
    const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never }); const a = io();
    expect(await main(["run", "new", "ordinary request", "--home", home, "--through", "frame", "--json"], a.io, {
      models: { brain: model as never }, apiKeyFor: async () => "key",
      runFrame: async (d) => { writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
    })).toBe(0);
    const summary = JSON.parse(a.out.join("")); const run = runPaths(home, summary.id);
    expect(new RunRecord(run.record).read().filter((event) => event.t === "note" && event.text.includes("eval manifest drift"))).toHaveLength(1);
    writeStatus(run, { state: "paused", pausedReason: "usage", wakeAt: "2999-01-01T00:00:00.000Z" });
    const resumed = io(); expect(await main(["run", "resume", run.id, "--home", home, "--json"], resumed.io, {})).toBe(0);
    expect(new RunRecord(run.record).read().filter((event) => event.t === "note" && event.text.includes("eval manifest drift"))).toHaveLength(2);
  });

  test("seed-id corpus drift stays a soft run note and no longer claims the stale identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const dev = loadSeeds(home, "dev")[0]!; writeFileSync(dev.path, `${dev.text.trimEnd()} changed\n`);
    const model = createMockModel({ id: "brain", responses: [{ content: ["unused"] }] as never }); const a = io();
    expect(await main(["run", "new", "--seed-id", dev.id, "--home", home, "--through", "frame", "--json"], a.io, {
      models: { brain: model as never }, apiKeyFor: async () => "key",
      runFrame: async (d) => { writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
    })).toBe(0);
    const summary = JSON.parse(a.out.join(""));
    expect(summary.status.seed).toBeUndefined();
    expect(new RunRecord(join(summary.dir, "record.jsonl")).read()).toContainEqual(expect.objectContaining({ t: "note", text: expect.stringContaining(`changed:${dev.file}`) }));
  });
});
