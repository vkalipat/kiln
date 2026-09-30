import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OPERATOR = resolve(import.meta.dir, "../../plugins/kiln/scripts/kiln_operator.py");
const homes: string[] = [];

afterEach(async () => {
  await Bun.sleep(400);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kiln-plugin-operator-")); homes.push(home);
  const fake = join(home, "fake-kiln.py");
  writeFileSync(fake, `#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
def value(flag): return args[args.index(flag) + 1]
home = pathlib.Path(value("--home")); calls = home / "fake-calls.jsonl"
calls.parent.mkdir(parents=True, exist_ok=True)
with calls.open("a") as out: out.write(json.dumps(args) + "\\n")
run_id = value("--id") if "--id" in args else args[2]
status_path = home / "runs" / run_id / "status.json"
if args[:2] == ["run", "new"]:
    status_path.parent.mkdir(parents=True, exist_ok=True)
    through=value("--through")
    status_path.write_text(json.dumps({"id":run_id,"phase":"reflect" if through == "reflect" else "form","state":"done" if through == "reflect" else "running","usdSpent":1.25,"createdAt":"x","updatedAt":"x"}))
    print("start-log")
    if os.environ.get("FAKE_LARGE_LOG") == "1": print("x" * 1100000)
    print("tail-one"); print("tail-two")
    gate=os.environ.get("FAKE_START_GATE")
    if gate:
        pathlib.Path(gate + ".entered").write_text("true")
        while pathlib.Path(gate).exists(): time.sleep(0.01)
    time.sleep(float(os.environ.get("FAKE_SLEEP", "0")))
elif args[:2] == ["run", "show"]:
    if not status_path.exists(): print("unknown run", file=sys.stderr); sys.exit(2)
    print(json.dumps({"id":run_id,"dir":str(status_path.parent),"status":json.loads(status_path.read_text()),"costUsd":1.25}))
elif args[:2] == ["build", "pause"]:
    gate=os.environ.get("FAKE_PAUSE_GATE")
    if gate:
        pathlib.Path(gate + ".entered").write_text("true")
        while pathlib.Path(gate).exists(): time.sleep(0.01)
    state=json.loads(status_path.read_text()); state.update({"state":"paused","pausedReason":"user_cancelled"}); status_path.write_text(json.dumps(state))
    print(json.dumps({"id":run_id,"state":"pause_requested"}))
elif args[:2] == ["run", "resume"]:
    state=json.loads(status_path.read_text()); through=value("--through")
    state.update({"phase":"reflect" if through == "reflect" else "form","state":"done" if through == "reflect" else "running"}); status_path.write_text(json.dumps(state))
    print("resume-log"); time.sleep(float(os.environ.get("FAKE_SLEEP", "0")))
else:
    print("unexpected invocation", file=sys.stderr); sys.exit(9)
`);
  chmodSync(fake, 0o700);
  const seed = join(home, "input.md"); writeFileSync(seed, "sensitive seed text\n");
  return { home, fake, seed };
}

function invoke(f: ReturnType<typeof fixture>, argv: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["python3", OPERATOR, ...argv, "--home", f.home, "--kiln-bin", f.fake],
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

async function waitFor(path: string, predicate: (value: any) => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = JSON.parse(readFileSync(path, "utf8")); if (predicate(value)) return value; } catch {}
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("Kiln coding-agent operator", () => {
  test("recovers a start process that crashed after reserving its job directory", async () => {
    const f = fixture();
    mkdirSync(join(f.home, "operator/crash-before-intent"), { recursive: true });

    const recovered = invoke(f, ["start", "--seed-file", f.seed, "--request-id", "crash-before-intent", "--confirm-spend"]);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.out)).toMatchObject({ requestId: "crash-before-intent", idempotent: false });
    await waitFor(join(f.home, "operator/crash-before-intent/job.json"), (value) => value.state === "exited");
  });

  test("ignores a crash-stale legacy resume lock", async () => {
    const f = fixture();
    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "stale", "--confirm-spend"]).code).toBe(0);
    const job = join(f.home, "operator/stale");
    await waitFor(join(job, "job.json"), (value) => value.state === "exited");
    mkdirSync(join(job, ".resume.lock"));
    writeFileSync(join(job, ".control.lock"), "stale crash residue");

    const resumed = invoke(f, ["resume", "--request-id", "stale", "--confirm-spend"]);
    expect(resumed.code).toBe(0);
    await waitFor(join(job, "job.json"), (value) => value.state === "exited" && value.attempts.length === 2);
  });

  test("rejects symlinked job directories and metadata path substitution", async () => {
    const f = fixture();
    const operatorRoot = join(f.home, "operator");
    const outside = mkdtempSync(join(tmpdir(), "kiln-plugin-outside-")); homes.push(outside);
    mkdirSync(operatorRoot, { recursive: true });
    symlinkSync(outside, join(operatorRoot, "redirect"));
    const linked = invoke(f, ["status", "--request-id", "redirect"]);
    expect(linked.code).toBe(2);
    expect(linked.err).toContain("symbolic link");

    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "identity", "--confirm-spend"]).code).toBe(0);
    const metadataPath = join(operatorRoot, "identity/job.json");
    const metadata = await waitFor(metadataPath, (value) => value.state === "exited");
    metadata.home = outside;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const substituted = invoke(f, ["status", "--request-id", "identity"]);
    expect(substituted.code).toBe(2);
    expect(substituted.err).toContain("metadata home mismatch");
  });

  test("serializes pause against resume", async () => {
    const f = fixture();
    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "pause-race", "--confirm-spend"]).code).toBe(0);
    const metadata = join(f.home, "operator/pause-race/job.json");
    await waitFor(metadata, (value) => value.state === "exited");
    const gate = join(f.home, "pause-gate"); writeFileSync(gate, "hold");
    const pause = Bun.spawn({
      cmd: ["python3", OPERATOR, "pause", "--request-id", "pause-race", "--home", f.home, "--kiln-bin", f.fake],
      env: { ...process.env, FAKE_PAUSE_GATE: gate }, stdout: "pipe", stderr: "pipe",
    });
    await waitFor(`${gate}.entered`, () => true);
    const resume = invoke(f, ["resume", "--request-id", "pause-race", "--confirm-spend"]);
    expect(resume.code).toBe(2);
    expect(resume.err).toContain("another control operation");
    unlinkSync(gate);
    expect(await pause.exited).toBe(0);
  });

  test("concurrent resume requests dispatch only one worker", async () => {
    const f = fixture();
    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "parallel", "--confirm-spend"]).code).toBe(0);
    const metadata = join(f.home, "operator/parallel/job.json");
    await waitFor(metadata, (value) => value.state === "exited");
    const command = ["python3", OPERATOR, "resume", "--request-id", "parallel", "--confirm-spend", "--home", f.home, "--kiln-bin", f.fake];
    const children = [0, 1].map(() => Bun.spawn({ cmd: command, env: { ...process.env, FAKE_SLEEP: "0.5" }, stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes.sort()).toEqual([0, 2]);
    await waitFor(metadata, (value) => value.state === "exited" && value.attempts.length === 2);
    const calls = readFileSync(join(f.home, "fake-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === "run" && args[1] === "resume")).toHaveLength(1);
  });

  test("concurrent identical starts reserve one durable run", async () => {
    const f = fixture();
    const command = ["python3", OPERATOR, "start", "--seed-file", f.seed, "--request-id", "parallel-start",
      "--confirm-spend", "--home", f.home, "--kiln-bin", f.fake];
    const children = Array.from({ length: 6 }, () => Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const metadata = join(f.home, "operator/parallel-start/job.json");
    await waitFor(metadata, (value) => value.state === "exited");
    const calls = readFileSync(join(f.home, "fake-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === "run" && args[1] === "new")).toHaveLength(1);
  });

  test("recovers an available run after detached worker metadata is left running", async () => {
    const f = fixture();
    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "worker-crash", "--confirm-spend"]).code).toBe(0);
    const metadataPath = join(f.home, "operator/worker-crash/job.json");
    const metadata = await waitFor(metadataPath, (value) => value.state === "exited");
    metadata.state = "running";
    metadata.workerPid = -1;
    metadata.attempts[0].state = "running";
    metadata.attempts[0].childPid = -1;
    writeFileSync(metadataPath, JSON.stringify(metadata));

    const resumed = invoke(f, ["resume", "--request-id", "worker-crash", "--confirm-spend"]);
    expect(resumed.code).toBe(0);
    await waitFor(metadataPath, (value) => value.state === "exited" && value.attempts.length === 2);
    const calls = readFileSync(join(f.home, "fake-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === "run" && args[1] === "resume")).toHaveLength(1);
  });
  test("requires spend confirmation and rejects traversal request IDs", () => {
    const f = fixture();
    const unconfirmed = invoke(f, ["start", "--seed-file", f.seed, "--request-id", "safe"]);
    expect(unconfirmed.code).toBe(2); expect(unconfirmed.err).toContain("--confirm-spend");
    const traversal = invoke(f, ["start", "--seed-file", f.seed, "--request-id", "../escape", "--confirm-spend"]);
    expect(traversal.code).toBe(2); expect(traversal.err).toContain("request id");
    const linkedSeed = join(f.home, "linked-seed.md"); symlinkSync(f.seed, linkedSeed);
    const symlinked = invoke(f, ["start", "--seed-file", linkedSeed, "--request-id", "linked", "--confirm-spend"]);
    expect(symlinked.code).toBe(2); expect(symlinked.err).toContain("symbolic link");
  });

  test("starts once, returns before worker completion, and rejects changed inputs for the request", async () => {
    const f = fixture();
    const gate = join(f.home, "start-gate"); writeFileSync(gate, "hold");
    try {
      // Keep the worker blocked until the command returns, independent of host startup speed.
      const first = invoke(f, ["start", "--seed-file", f.seed, "--request-id", "same", "--confirm-spend"], { FAKE_START_GATE: gate });
      expect(first.code).toBe(0);
      await waitFor(`${gate}.entered`, () => true);
      const one = JSON.parse(first.out); expect(one).toMatchObject({ requestId: "same", runId: "operator-same", idempotent: false });
      const repeated = invoke(f, ["start", "--seed-file", f.seed, "--request-id", "same", "--confirm-spend"]);
      expect(repeated.code).toBe(0); expect(JSON.parse(repeated.out)).toMatchObject({ runId: "operator-same", idempotent: true });

      writeFileSync(f.seed, "changed\n");
      const changed = invoke(f, ["start", "--seed-file", f.seed, "--request-id", "same", "--confirm-spend"]);
      expect(changed.code).toBe(2); expect(changed.err).toContain("different seed or start options");
      const job = JSON.parse(readFileSync(join(f.home, "operator/same/job.json"), "utf8"));
      expect(job.state).toBe("running");
      expect(JSON.stringify(job)).not.toContain("sensitive seed text");
      expect(statSync(join(f.home, "operator/same")).mode & 0o777).toBe(0o700);
      expect(statSync(join(f.home, "operator/same/seed.md")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(gate, { force: true });
      await waitFor(join(f.home, "operator/same/job.json"), (value) => value.state === "exited");
    }
    const calls = readFileSync(join(f.home, "fake-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === "run" && args[1] === "new")).toHaveLength(1);
  }, 20_000);

  test("reports process and durable run status separately and tails the end of large logs", async () => {
    const f = fixture();
    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "observe", "--confirm-spend"], { FAKE_LARGE_LOG: "1" }).code).toBe(0);
    await waitFor(join(f.home, "operator/observe/job.json"), (value) => value.state === "exited");
    const report = invoke(f, ["status", "--request-id", "observe"]); expect(report.code).toBe(0);
    expect(JSON.parse(report.out)).toMatchObject({
      state: "exited", process: { workerAlive: false, kilnAlive: false, exitCode: 0 },
      run: { available: true, phase: "form", state: "running", usdSpent: 1.25 },
      endpoint: { requested: "checkpoint", reached: true, disposition: "awaiting_delivery" },
    });
    const log = invoke(f, ["logs", "--request-id", "observe", "--lines", "2"]); expect(log.code).toBe(0);
    expect(JSON.parse(log.out).lines).toEqual(["tail-one", "tail-two"]);
  });

  test("reports a completed delivery only when the reflect endpoint is terminal", async () => {
    const f = fixture();
    expect(invoke(f, ["start", "--seed-file", f.seed, "--request-id", "deliver", "--through", "reflect", "--confirm-spend"]).code).toBe(0);
    await waitFor(join(f.home, "operator/deliver/job.json"), (value) => value.state === "exited");
    const report = JSON.parse(invoke(f, ["status", "--request-id", "deliver"]).out);
    expect(report).toMatchObject({
      process: { exitCode: 0, workerAlive: false, kilnAlive: false },
      run: { phase: "reflect", state: "done" },
      endpoint: { requested: "reflect", reached: true, disposition: "completed" },
    });
  });

  test("pauses through Kiln and serializes confirmed resume attempts", async () => {
    const f = fixture();
    invoke(f, ["start", "--seed-file", f.seed, "--request-id", "control", "--confirm-spend"]);
    await waitFor(join(f.home, "operator/control/job.json"), (value) => value.state === "exited");
    const paused = invoke(f, ["pause", "--request-id", "control"]); expect(paused.code).toBe(0);
    expect(JSON.parse(paused.out).pause.state).toBe("pause_requested");
    const denied = invoke(f, ["resume", "--request-id", "control", "--through", "reflect"]);
    expect(denied.code).toBe(2); expect(denied.err).toContain("--confirm-spend");
    const resumed = invoke(f, ["resume", "--request-id", "control", "--through", "reflect", "--confirm-spend"], { FAKE_SLEEP: "0.5" });
    expect(resumed.code).toBe(0); expect(JSON.parse(resumed.out)).toMatchObject({ resumed: true, launchThrough: "reflect" });
    const duplicate = invoke(f, ["resume", "--request-id", "control", "--through", "reflect", "--confirm-spend"]);
    expect(duplicate.code).toBe(2); expect(duplicate.err).toContain("prior operator attempt is still running");
    await waitFor(join(f.home, "operator/control/job.json"), (value) => value.state === "exited" && value.attempts.length === 2);
    const report = JSON.parse(invoke(f, ["status", "--request-id", "control"]).out);
    expect(report.run).toMatchObject({ available: true, phase: "reflect", state: "done" });
    expect(report.process).toMatchObject({ workerAlive: false, kilnAlive: false, exitCode: 0 });
  });
});
