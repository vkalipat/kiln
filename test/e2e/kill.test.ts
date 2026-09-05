import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealGitRunner } from "../../src/build/git";
import { foldState } from "../../src/build/state";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { hashInput, RunRecord } from "../../src/core/record";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { type FeaturesFile } from "../../src/formation/features";
import { freeze } from "../../src/formation/freeze";
import { projectPaths, writeProjectMarker } from "../../src/formation/paths";
import { parseBrief } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import type { PhaseDeps } from "../../src/phases/frame";
import { processGroupAlive, signalProcessGroup, waitForExit, waitForMarker, waitForProcessGroupExit } from "./helpers/process-group";

const HERE = dirname(fileURLToPath(import.meta.url));
const KILL_MAIN = join(HERE, "helpers", "kill-main.ts");
const BRIEF = `# Brief

## Problem
Prove crash-safe feature delivery.

## Constraints
- local execution

## Search success
- deterministic recovery

## Non-goals
- hosted deployment

## Shape
product

## Axes
- recovery: restart | resume

## Discovery questions
- Are committed features replayed?
`;
const SPEC = `# Spec

## First milestone
Two durable files, each delivered by its own checked feature.
`;
const FEATURES: FeaturesFile = {
  version: 1,
  init: { needs: [] },
  features: [
    { id: "f01", title: "First durable feature", description: "Create the first marker file.", acceptance: { type: "file", path: "f01.txt", contains: "f01 completed" } },
    { id: "f02", title: "Second durable feature", description: "Create the second marker file.", acceptance: { type: "file", path: "f02.txt", contains: "f02 completed" } },
  ],
};

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.pid && processGroupAlive(child.pid)) {
      try { signalProcessGroup(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ home: string; markerPath: string; run: ReturnType<typeof createRun> }> {
  const root = mkdtempSync(join(tmpdir(), "kiln-kill-e2e-"));
  roots.push(root);
  const home = join(root, "home");
  initHome(home);
  const cfg = defaultConfig();
  cfg.autonomous = true;
  cfg.build.minFeatures = 2;
  cfg.build.maxFeatures = 2;
  cfg.build.expectedCheckSeconds = 0.01;
  cfg.build.expectedInitSeconds = 0.01;
  saveConfig(home, cfg);

  const run = createRun(home, "kill and resume");
  const record = new RunRecord(run.record);
  const project = projectPaths(run.project);
  mkdirSync(project.dir, { recursive: true });
  writeFileSync(run.brief, BRIEF);
  writeFileSync(project.spec, SPEC);
  writeFileSync(project.initSh, "#!/bin/sh\nexit 0\n");
  writeProjectMarker(project.dir, { runId: run.id, ideaId: "kill-e2e", kilnVersion: "0.1.0", createdAt: new Date().toISOString() });
  const specHash = hashInput(SPEC);
  await freeze({ run, record } as PhaseDeps, FEATURES, specHash, new RealGitRunner());
  const brief = parseBrief(BRIEF);
  writeStatus(run, {
    phase: "build",
    state: "running",
    outcome: undefined,
    projectDir: project.dir,
    chosenIdeaId: "kill-e2e",
    shape: brief.shape,
    shapeHash: shapeHash(brief),
    specHash,
  });
  return { home, markerPath: join(root, "markers.log"), run };
}

function spawnWorker(home: string, runId: string, markerPath: string, mode: "kill" | "resume") {
  const child = spawn(process.execPath, [KILL_MAIN, home, runId, markerPath, mode], {
    cwd: join(HERE, "..", ".."),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

const posixTest = process.platform === "win32" ? test.skip : test;

describe("kiln project build process-group recovery", () => {
  posixTest("[slow, POSIX] a detached CLI group receives TERM and is gone after KILL", async () => {
    const { home, markerPath, run } = await fixture();
    const first = spawnWorker(home, run.id, markerPath, "kill");
    if (!first.child.pid) throw new Error("detached kill worker has no pid");
    await waitForMarker(markerPath, "builder:f02:start");

    signalProcessGroup(first.child.pid, "SIGTERM");
    await waitForMarker(markerPath, "signal:SIGTERM");
    expect(processGroupAlive(first.child.pid)).toBe(true);
    signalProcessGroup(first.child.pid, "SIGKILL");
    const killed = await waitForExit(first.child);
    expect(killed.code).not.toBe(0);
    await waitForProcessGroupExit(first.child.pid);
    expect(processGroupAlive(first.child.pid)).toBe(false);
    children.delete(first.child);
  }, 20_000);

  posixTest("[slow, POSIX] kills a detached CLI group and resumes without replaying a checked feature", async () => {
    const { home, markerPath, run } = await fixture();
    const first = spawnWorker(home, run.id, markerPath, "kill");
    if (!first.child.pid) throw new Error("detached kill worker has no pid");

    await waitForMarker(markerPath, "builder:f02:start");
    const beforeKill = new RunRecord(run.record).read();
    expect(beforeKill.filter((event) => event.t === "commit" && event.featureId === "f01")).toHaveLength(1);
    expect(readFileSync(projectPaths(run.project).progress, "utf8")).toContain("## f01 attempt 1");
    expect(foldState(run).f01).toMatchObject({ state: "passed", passes: true, attempts: 1 });

    signalProcessGroup(first.child.pid, "SIGTERM");
    await waitForMarker(markerPath, "signal:SIGTERM");
    signalProcessGroup(first.child.pid, "SIGKILL");
    const killed = await waitForExit(first.child);
    expect(killed.code).not.toBe(0);
    await waitForProcessGroupExit(first.child.pid);
    children.delete(first.child);

    const resumed = spawnWorker(home, run.id, markerPath, "resume");
    const resumedExit = await waitForExit(resumed.child);
    children.delete(resumed.child);
    expect({ exit: resumedExit, stderr: resumed.output().stderr }).toEqual({ exit: { code: 0, signal: null }, stderr: "" });

    const summary = JSON.parse(resumed.output().stdout);
    expect(summary).toMatchObject({
      id: run.id,
      outcome: { outcome: "ok" },
      status: { phase: "reflect", state: "done", outcome: { kind: "success" }, cursor: { step: "reflected" } },
    });
    expect(readStatus(run)).toMatchObject({ phase: "reflect", state: "done", outcome: { kind: "success" } });
    expect(foldState(run)).toMatchObject({
      f01: { state: "passed", passes: true, attempts: 1 },
      f02: { state: "passed", passes: true, attempts: 1 },
    });

    const markers = readFileSync(markerPath, "utf8").trim().split("\n");
    expect(markers.filter((marker) => marker === "builder:f01:start")).toHaveLength(1);
    expect(markers.filter((marker) => marker === "builder:f02:start")).toHaveLength(2);
    const events = new RunRecord(run.record).read();
    expect(events.filter((event) => event.t === "builder.session" && event.featureId === "f01")).toHaveLength(1);
    expect(events.filter((event) => event.t === "check" && event.phase === "acceptance" && event.featureId === "f01")).toHaveLength(1);
    expect(events.filter((event) => event.t === "commit" && event.featureId === "f01")).toHaveLength(1);
    expect(events.filter((event) => event.t === "commit" && event.featureId === "f02")).toHaveLength(1);
    expect(readFileSync(projectPaths(run.project).progress, "utf8").match(/^## f01 attempt 1 /gm)).toHaveLength(1);
    expect(readFileSync(join(projectPaths(run.project).repo, "f01.txt"), "utf8")).toBe("f01 completed\n");
    expect(readFileSync(join(projectPaths(run.project).repo, "f02.txt"), "utf8")).toBe("f02 completed\n");
  }, 30_000);
});
