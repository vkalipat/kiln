import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { RunRecord } from "../../src/core/record";
import { createRun, type RunPaths } from "../../src/core/run";
import type { Dossier, Evidence } from "../../src/ideation/dossier";
import {
  MAX_TIMEOUT_SECONDS,
  checkNeeds,
  mergeProbeEvidence,
  probeDir,
  runProbe,
  runProbeBatch,
  validateSpec,
  writeProbe,
  type ProbeSpec,
} from "../../src/ideation/probe";
import type { PhaseDeps } from "../../src/phases/frame";

function setup(responses: unknown[] = [], concurrency = 1) {
  const home = mkdtempSync(join(tmpdir(), "kiln-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  const cfg = defaultConfig();
  const model = createMockModel({ id: "mock-prober", responses: responses as never });
  const deps = {
    home,
    run,
    record,
    cfg,
    models: () => ({ model: model as never, ref: "mock/mock-prober" }),
    apiKeyFor: async () => "k",
    effort: "low",
    streamFn: streamMock as never,
    limiter: new Limiter(concurrency),
  } as unknown as PhaseDeps;
  return { home, run, record, cfg, deps };
}

function dossier(id: string): Dossier {
  return {
    id,
    title: "Trigram dedup for run journals",
    mechanism: "hash trigrams and compare",
    draws: "shingling",
    axisValues: { "who it serves": "hobbyists" },
    testableClaim: "dedup at 10k docs in under a second",
    cheapestTest: "run it on 10k synthetic docs",
    failureReason: "trigram sets blow up",
    parents: [],
  };
}

function spec(over: Partial<ProbeSpec> = {}): ProbeSpec {
  return {
    ideaId: "r1-i1-1",
    files: [],
    command: "echo READY",
    needs: [],
    networkRequired: false,
    timeoutSeconds: 30,
    successPredicate: { type: "substring", value: "READY" },
    ...over,
  };
}

const probeEvents = (record: RunRecord) => record.read().filter((e) => e.t === "probe") as Array<Extract<import("../../src/core/record").StoredEvent, { t: "probe" }>>;
const evidenceOf = (run: RunPaths, id: string) => JSON.parse(readFileSync(join(run.ideasDir, `${id}.evidence.json`), "utf8")) as Evidence;

/** One model response: a valid probe_spec is a terminal structured decision. */
const proberSays = (args: Record<string, unknown>) => [
  { content: [{ type: "toolCall", name: "probe_spec", arguments: args }] },
];

const GOOD_ARGS = {
  files: [{ path: "check.sh", content: "echo hi\n" }],
  command: "sh check.sh",
  needs: ["sh"],
  networkRequired: false,
  timeoutSeconds: 20,
  successPredicate: { type: "substring", value: "hi" },
};

describe("validateSpec", () => {
  test("a well formed spec has no problems", () => {
    expect(validateSpec(spec({ files: [{ path: "a/b.txt", content: "x" }] }))).toEqual([]);
  });
  test("an absolute or parent-escaping file path is refused", () => {
    expect(validateSpec(spec({ files: [{ path: "/etc/passwd", content: "x" }] })).join(" ")).toContain("relative");
    expect(validateSpec(spec({ files: [{ path: "../evil.txt", content: "x" }] })).join(" ")).toContain("inside");
  });
  test("an empty command is refused", () => {
    expect(validateSpec(spec({ command: "   " })).join(" ")).toContain("command");
  });
  test("the timeout must be between 5 and 120 seconds", () => {
    expect(validateSpec(spec({ timeoutSeconds: 1 })).join(" ")).toContain("timeoutSeconds");
    expect(validateSpec(spec({ timeoutSeconds: MAX_TIMEOUT_SECONDS + 1 })).join(" ")).toContain("timeoutSeconds");
    expect(validateSpec(spec({ timeoutSeconds: MAX_TIMEOUT_SECONDS }))).toEqual([]);
  });
  test("an empty or uncompilable predicate is refused", () => {
    expect(validateSpec(spec({ successPredicate: { type: "substring", value: "" } })).join(" ")).toContain("successPredicate");
    expect(validateSpec(spec({ successPredicate: { type: "regex", value: "([" } })).join(" ")).toContain("regex");
    expect(validateSpec(spec({ successPredicate: { type: "shape" as never, value: "x" } })).join(" ")).toContain("successPredicate.type");
  });
});

describe("checkNeeds", () => {
  test("cwd does not change literal names passed to an injected executable lookup", () => {
    const seen: string[] = [];
    expect(checkNeeds(["./tool"], { cwd: "/not-used-by-injected-lookup", env: {}, which: (name) => { seen.push(name); return "/resolved/tool"; } })).toEqual([]);
    expect(seen).toEqual(["./tool"]);
  });
  test("an executable on PATH and a present environment variable are both satisfied", () => {
    expect(checkNeeds(["sh"])).toEqual([]);
    expect(checkNeeds(["KILN_PROBE_NEED"], { env: { KILN_PROBE_NEED: "1" }, which: () => null })).toEqual([]);
  });
  test("a name that is neither is reported missing", () => {
    expect(checkNeeds(["kiln-no-such-binary-xyz", "sh"])).toEqual(["kiln-no-such-binary-xyz"]);
  });
  test("a credential need is missing because the probe runs with a stripped environment", () => {
    process.env.KILN_PROBE_TEST_TOKEN = "a-live-credential";
    try {
      expect(checkNeeds(["KILN_PROBE_TEST_TOKEN"])).toEqual(["KILN_PROBE_TEST_TOKEN"]);
    } finally {
      delete process.env.KILN_PROBE_TEST_TOKEN;
    }
  });
});

describe("runProbe", () => {
  test("resolves a preexisting relative executable inside the probe directory", async () => {
    const { run, record } = setup();
    const dir = probeDir(run, "r1-i1-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "local-runtime"), "#!/bin/sh\nprintf READY\n", { mode: 0o755 });
    const result = await runProbe(run, spec({ command: "./local-runtime", needs: ["./local-runtime"] }), { timeoutSeconds: 120 }, record);
    expect(result).toMatchObject({ status: "pass", exitCode: 0 });
  });

  test("exit 0 with the predicate in the output is a pass, recorded in the sidecar and the journal", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec(), { timeoutSeconds: 120 }, record);
    expect(r.status).toBe("pass");
    expect(r.exitCode).toBe(0);
    expect(r.predicateMatched).toBe(true);
    expect(r.stdoutTail).toContain("READY");
    expect(evidenceOf(run, "r1-i1-1").probe).toMatchObject({ status: "pass", exitCode: 0 });
    expect(probeEvents(record).map((e) => [e.id, e.status, e.exitCode])).toEqual([["r1-i1-1", "pass", 0]]);
  });

  test("a regex predicate matches", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "echo count=42", successPredicate: { type: "regex", value: "count=\\d+" } }), { timeoutSeconds: 120 }, record);
    expect(r.status).toBe("pass");
  });

  test("exit 0 without the predicate is a fail", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "echo nothing-useful" }), { timeoutSeconds: 120 }, record);
    expect(r.status).toBe("fail");
    expect(r.predicateMatched).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(evidenceOf(run, "r1-i1-1").probe?.status).toBe("fail");
  });

  test("a non-zero exit is a fail even when the predicate matches", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "echo READY; exit 3" }), { timeoutSeconds: 120 }, record);
    expect(r.status).toBe("fail");
    expect(r.exitCode).toBe(3);
    expect(r.predicateMatched).toBe(true);
  });

  test("a probe past the deadline is a timeout, and the config cap clamps the spec's own timeout", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "sleep 5; echo READY" }), { timeoutSeconds: 1 }, record);
    expect(r.status).toBe("timeout");
    expect(r.durationMs).toBeLessThan(5000);
    expect(probeEvents(record)[0]!.status).toBe("timeout");
    expect(evidenceOf(run, "r1-i1-1").probe?.status).toBe("timeout");
  });

  test("a signal-killed probe is an error, not evidence", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "kill -KILL $$" }), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("error");
    expect(r.reason).toContain("signal");
  });

  test("a command that does not exist is an error, not a failed idea", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "kiln-no-such-binary-xyz" }), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("command_not_found");
    expect(r.stdoutTail ?? "").not.toBe("");
  });

  test("files are materialized under the run's probe directory and the command sees them", async () => {
    const { run, record } = setup();
    const s = spec({ files: [{ path: "nested/data.txt", content: "READY\n" }], command: "cat nested/data.txt" });
    const r = await runProbe(run, s, { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("pass");
    expect(readFileSync(join(probeDir(run, "r1-i1-1"), "nested", "data.txt"), "utf8")).toBe("READY\n");
    expect(existsSync(join(run.probesDir, "r1-i1-1.json"))).toBe(true);
  });

  test("a file path that escapes the probe directory is refused before anything runs", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ files: [{ path: "../escaped.txt", content: "x" }], command: "echo READY" }), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("error");
    expect(r.reason).toContain("escape");
    expect(existsSync(join(run.probesDir, "escaped.txt"))).toBe(false);
    expect(evidenceOf(run, "r1-i1-1").probe?.status).toBe("error");
  });

  test("an absolute file path is refused", async () => {
    const { run, record } = setup();
    const outside = join(tmpdir(), `kiln-probe-escape-${process.pid}.txt`);
    const r = await runProbe(run, spec({ files: [{ path: outside, content: "x" }] }), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("error");
    expect(existsSync(outside)).toBe(false);
  });

  test("materialization refuses an existing symlink instead of writing outside the probe directory", async () => {
    const { run, record } = setup();
    const outside = join(mkdtempSync(join(tmpdir(), "kiln-probe-outside-")), "held.txt");
    writeFileSync(outside, "held");
    const dir = probeDir(run, "safe-id");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "link.txt"));
    const s = spec({ ideaId: "safe-id", files: [{ path: "link.txt", content: "overwritten" }] });
    const result = await runProbe(run, s, { timeoutSeconds: 10 }, record);
    expect(result).toMatchObject({ status: "error" });
    expect(result.reason).toContain("symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("held");
  });

  test("a spec whose needs are unmet short-circuits runProbe itself, not just its caller", async () => {
    const { run, record } = setup();
    const s = spec({ needs: ["kiln-no-such-binary-xyz"], command: "echo ran > ran-marker.txt" });
    const r = await runProbe(run, s, { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("not_run");
    expect(r.reason).toBe("missing_dependency:kiln-no-such-binary-xyz");
    // Nothing was materialized or executed: the check happens before the probe directory exists.
    expect(existsSync(probeDir(run, "r1-i1-1"))).toBe(false);
    expect(evidenceOf(run, "r1-i1-1").probe).toMatchObject({ status: "not_run", reason: "missing_dependency:kiln-no-such-binary-xyz" });
    expect(probeEvents(record).map((e) => [e.id, e.status, e.reason])).toEqual([["r1-i1-1", "not_run", "missing_dependency:kiln-no-such-binary-xyz"]]);
  });

  test("an idea id that is not a safe directory name is refused", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ ideaId: "../../etc" }), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("invalid_idea_id");
  });

  test("a probe directory that cannot be created is an error", async () => {
    const { run, record } = setup();
    writeFileSync(join(run.probesDir, "r1-i1-1"), "in the way");
    const r = await runProbe(run, spec(), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("error");
    expect(r.reason).toContain("materialize");
  });

  test("the evidence sidecar is merged, never overwritten", async () => {
    const { run, record } = setup();
    const before: Evidence = { status: "active", cell: "a/b", priorArt: { status: "not_falsified" }, similarity: 0.2 };
    writeFileSync(join(run.ideasDir, "r1-i1-1.evidence.json"), `${JSON.stringify(before, null, 2)}\n`);
    await runProbe(run, spec(), { timeoutSeconds: 120 }, record);
    const after = evidenceOf(run, "r1-i1-1");
    expect(after.cell).toBe("a/b");
    expect(after.priorArt).toEqual({ status: "not_falsified" });
    expect(after.similarity).toBe(0.2);
    expect(after.status).toBe("active");
    expect(after.probe?.status).toBe("pass");
  });

  test("mergeProbeEvidence starts fresh on an unreadable sidecar rather than losing the result", () => {
    const { run } = setup();
    writeFileSync(join(run.ideasDir, "x1.evidence.json"), "{not json");
    const e = mergeProbeEvidence(run, "x1", { status: "fail", exitCode: 1, durationMs: 5 });
    expect(e.status).toBe("active");
    expect(e.probe?.status).toBe("fail");
  });

  test("stderr stands in for an empty stdout so the judge still sees the output", async () => {
    const { run, record } = setup();
    const r = await runProbe(run, spec({ command: "echo boom 1>&2; exit 2" }), { timeoutSeconds: 30 }, record);
    expect(r.status).toBe("fail");
    expect(r.stderrTail).toContain("boom");
    expect(r.stdoutTail).toContain("boom");
  });

  test("networkRequired is recorded, not enforced", async () => {
    const { run, record } = setup();
    await runProbe(run, spec({ networkRequired: true }), { timeoutSeconds: 30 }, record);
    expect(record.read().some((e) => e.t === "note" && e.text.includes("networkRequired"))).toBe(true);
  });
});

describe("writeProbe", () => {
  test("the exact assignment and relevant source evidence reach the prober without clipping", async () => {
    const base = setup(); let packet = "";
    const rationale = "Check real input availability. " + "constraint ".repeat(100) + "TAIL: do not substitute synthetic inputs.";
    const model = createMockModel({ id: "assigned", handler: async (context: unknown) => { packet = JSON.stringify(context); return proberSays({ ...GOOD_ARGS, scope: "precondition" })[0]!; } } as never);
    base.deps.models = () => ({ model: model as never, ref: "mock/assigned" });
    const result = await writeProbe(base.deps, dossier("assigned"), { status: "active", priorArt: { status: "search_failed", distance: "Data access remains unverified" } }, { rationale });
    expect(packet).toContain(rationale); expect(packet).toContain("Data access remains unverified");
    expect(result.spec?.assignmentContext?.assignment.rationale).toBe(rationale);
    expect(result.spec?.assignmentHash).toMatch(/^[a-f0-9]{64}$/); expect(result.spec?.scope).toBe("precondition");
  });

  test("an assigned unavailable test can explicitly decline without substituting a toy spec", async () => {
    const { deps } = setup([{ content: [{ type: "toolCall", name: "cannot_probe", arguments: { reason: "The required dataset is unavailable locally and requires user authorization." } }] }]);
    const result = await writeProbe(deps, dossier("unavailable"), undefined, { rationale: "Evaluate the assigned real held-out data metric." });
    expect(result.spec).toBeUndefined(); expect(result.workerFailure).toBeUndefined();
    expect(result.cannotProbeReason).toContain("required dataset");
  });

  test("an oversized assignment is rejected before any provider call instead of truncated", async () => {
    const { deps, record } = setup();
    expect(await writeProbe(deps, dossier("oversize"), undefined, { rationale: "x".repeat(8001) })).toMatchObject({ workerFailure: "verify", costUsd: 0 });
    expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(0);
  });
  test("returns the prober's spec, stamped with the idea id, and its cost", async () => {
    const { deps, record } = setup(proberSays(GOOD_ARGS));
    const r = await writeProbe(deps, dossier("r2-i1-4"));
    expect(r.error).toBeUndefined();
    expect(r.spec).toMatchObject({ ideaId: "r2-i1-4", command: "sh check.sh", needs: ["sh"], timeoutSeconds: 20 });
    expect(r.spec!.files).toEqual([{ path: "check.sh", content: "echo hi\n" }]);
    const calls = record.read().filter((e) => e.t === "model.call" && e.role === "prober");
    expect(calls.length).toBe(1);
    expect(r.costUsd).toBe(calls.reduce((s, e) => s + (e.t === "model.call" ? e.costUsd : 0), 0));
    expect(record.read().some((e) => e.t === "turn" && e.role === "prober" && e.phase === "ideate")).toBe(true);
  });

  test("a prober that only talks yields no spec and an error", async () => {
    const { deps } = setup([{ content: ["this idea cannot be probed cheaply"] }]);
    const r = await writeProbe(deps, dossier("r1-i1-1"));
    expect(r.spec).toBeUndefined();
    expect(r.error).toContain("probe_spec");
  });

  test("a prober refusal is preserved instead of being called semantically not-probeable", async () => {
    const { deps } = setup([{ stopReason: "error", errorMessage: "request refused", stopDetails: { type: "refusal", category: "safety" } }]);
    const r = await writeProbe(deps, dossier("r1-i1-1"));
    expect(r).toMatchObject({ stopped: "refused", workerFailure: "refusal" });
    expect(r.error).toContain("refused:safety");
  });

  test("an invalid spec is rejected with the problem named", async () => {
    const { deps } = setup(proberSays({ ...GOOD_ARGS, timeoutSeconds: 900 }));
    const r = await writeProbe(deps, dossier("r1-i1-1"));
    expect(r.spec).toBeUndefined();
    expect(r.error).toContain("timeoutSeconds");
  });

  test("the prober sees the dossier and never the archive standing", async () => {
    const { deps } = setup(proberSays(GOOD_ARGS));
    const evidence: Evidence = { status: "active", strengths: { value: { mean: 1, lo: 0, hi: 2, n: 3 }, feasibility: { mean: 1, lo: 0, hi: 2, n: 3 } } };
    const r = await writeProbe(deps, dossier("r1-i1-1"), evidence);
    expect(r.spec).toBeDefined();
  });
});

describe("runProbeBatch", () => {
  test("passed probe reuse requires the same exact assignment and preserves previous specs", async () => {
    const { deps, run, record } = setup([
      ...proberSays({ ...GOOD_ARGS, scope: "precondition" }),
      ...proberSays({ ...GOOD_ARGS, command: "echo changed", successPredicate: { type: "substring", value: "changed" }, scope: "end_to_end" }),
    ]);
    const ideas = [{ dossier: { ...dossier("assigned-cache"), vsProbability: undefined } }];
    const first = await runProbeBatch(deps, ideas, { roundWallSeconds: 600, assignments: { "assigned-cache": { rationale: "First exact test." } } });
    expect(first[0]?.status).toBe("pass");
    const repeated = await runProbeBatch(deps, ideas, { roundWallSeconds: 600, assignments: { "assigned-cache": { rationale: "First exact test." } } });
    expect(repeated[0]?.assignmentHash).toBe(first[0]?.assignmentHash);
    expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(1);
    const changed = await runProbeBatch(deps, ideas, { roundWallSeconds: 600, assignments: { "assigned-cache": { rationale: "Changed exact test." } } });
    expect(changed[0]?.status).toBe("pass"); expect(changed[0]?.assignmentHash).not.toBe(first[0]?.assignmentHash);
    expect(record.read().filter((event) => event.t === "model.call")).toHaveLength(2);
    expect(existsSync(join(run.probesDir, `assigned-cache.${first[0]?.assignmentHash}.json`))).toBe(true);
    expect(evidenceOf(run, "assigned-cache").probe).toMatchObject({ assignmentHash: changed[0]?.assignmentHash, scope: "end_to_end" });
  });
  test("worker refusal remains fatal without explicit optional-stage policy", async () => {
    const { deps, run } = setup([{ stopReason: "error", errorMessage: "request refused", stopDetails: { type: "refusal", category: "safety" } }]);
    const results = await runProbeBatch(deps, [{ dossier: dossier("required") }], { roundWallSeconds: 600 });
    expect(results[0]).toMatchObject({ workerFailure: "refusal", status: "not_run" });
    expect(results[0]?.optionalRefusal).toBeUndefined();
    expect(existsSync(join(run.ideasDir, "required.evidence.json"))).toBe(false);
  });

  test("optional policy does not swallow a transient worker failure", async () => {
    const { deps, run, record } = setup([{ stopReason: "error", errorMessage: "rate limit exceeded" }]);
    const results = await runProbeBatch(deps, [{ dossier: dossier("unavailable") }], { roundWallSeconds: 600, optional: true });
    expect(results[0]).toMatchObject({ workerFailure: "transient", status: "not_run" });
    expect(results[0]?.optionalRefusal).toBeUndefined();
    expect(existsSync(join(run.ideasDir, "unavailable.evidence.json"))).toBe(false);
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "prober")).toHaveLength(1);
  });

  test("an optional worker refusal is durable unrun evidence while its sibling still executes", async () => {
    const { deps, run, record } = setup([
      { stopReason: "error", errorMessage: "request refused", stopDetails: { type: "refusal", category: "safety" } },
      ...proberSays({ ...GOOD_ARGS, command: "echo hi" }),
    ], 2);
    const results = await runProbeBatch(deps, [{ dossier: dossier("refused") }, { dossier: dossier("unaffected") }], { roundWallSeconds: 600, optional: true });
    expect(results[0]).toMatchObject({ status: "not_run", reason: "worker_refused:safety", workerFailure: "refusal", optionalRefusal: true });
    expect(results[1]?.status).toBe("pass");
    expect(evidenceOf(run, "refused").probe).toMatchObject({ status: "not_run", reason: "worker_refused:safety" });
    expect(probeEvents(record)).toContainEqual(expect.objectContaining({ id: "refused", status: "not_run", reason: "worker_refused:safety" }));
    expect(record.read()).toContainEqual(expect.objectContaining({ t: "failure", class: "refusal", category: "safety" }));
    expect(record.read().filter((event) => event.t === "model.call" && event.role === "prober")).toHaveLength(2);
  });

  test("writes and runs one probe per idea, recording each", async () => {
    const { deps, run, record } = setup([...proberSays({ ...GOOD_ARGS, command: "echo hi" }), ...proberSays({ ...GOOD_ARGS, command: "echo hi" })]);
    const seen: string[] = [];
    const out = await runProbeBatch(deps, [{ dossier: dossier("a1") }, { dossier: dossier("a2") }], { roundWallSeconds: 600, onEach: (r) => seen.push(`${r.ideaId}:${r.status}`) });
    expect(out.map((r) => [r.ideaId, r.status])).toEqual([["a1", "pass"], ["a2", "pass"]]);
    expect(seen.sort()).toEqual(["a1:pass", "a2:pass"]);
    expect(probeEvents(record).length).toBe(2);
    expect(evidenceOf(run, "a2").probe?.status).toBe("pass");
  });

  test("awaits every dispatched sibling before propagating one job's exception", async () => {
    const { deps } = setup([
      ...proberSays({ ...GOOD_ARGS, command: "sleep 0.2; echo hi" }),
      ...proberSays({ ...GOOD_ARGS, command: "sleep 0.2; echo hi" }),
    ], 2);
    deps.onProbePreview = async (s: ProbeSpec) => { if (s.ideaId === "a1") throw new Error("preview failed"); };
    await expect(runProbeBatch(deps, [{ dossier: dossier("a1") }, { dossier: dossier("a2") }], { roundWallSeconds: 600 })).rejects.toThrow("preview failed");
    expect(deps.limiter.active).toBe(0);
    expect(deps.limiter.pending).toBe(0);
  });

  test("ideas past the round wall clock are not_run with reason budget and never reach the prober", async () => {
    const { deps, run, record } = setup(proberSays({ ...GOOD_ARGS, command: "echo hi" }));
    let t = 0;
    // Calls in order: started, b1's enqueue check, b2's enqueue check, b3's enqueue check, then —
    // once the loop finishes and b1 (the only one dispatched) actually gets to run — b1's
    // pre-runProbe recheck, which the trailing 0 keeps safely within budget.
    const clock = [0, 0, 30_000, 30_000, 0];
    const out = await runProbeBatch(deps, [{ dossier: dossier("b1") }, { dossier: dossier("b2") }, { dossier: dossier("b3") }], {
      roundWallSeconds: 10,
      now: () => clock[Math.min(t++, clock.length - 1)]!,
    });
    expect(out.map((r) => [r.ideaId, r.status, r.reason])).toEqual([
      ["b1", "pass", undefined],
      ["b2", "not_run", "budget"],
      ["b3", "not_run", "budget"],
    ]);
    expect(evidenceOf(run, "b3").probe).toMatchObject({ status: "not_run", reason: "budget" });
    expect(probeEvents(record).filter((e) => e.status === "not_run").length).toBe(2);
    // Only the first idea's prober ran: one terminal decision call, not three.
    expect(record.read().filter((e) => e.t === "model.call").length).toBe(1);
  });

  test("a declared dependency that is absent makes the probe not_run, and nothing is executed", async () => {
    const { deps, run } = setup(proberSays({ ...GOOD_ARGS, needs: ["kiln-no-such-binary-xyz"], command: "echo hi > ran.txt" }));
    const out = await runProbeBatch(deps, [{ dossier: dossier("c1") }], { roundWallSeconds: 600 });
    expect(out[0]!.status).toBe("not_run");
    expect(out[0]!.reason).toBe("missing_dependency:kiln-no-such-binary-xyz");
    expect(existsSync(join(run.probesDir, "c1"))).toBe(false);
    expect(evidenceOf(run, "c1").probe?.reason).toBe("missing_dependency:kiln-no-such-binary-xyz");
  });

  test("a prober that declines makes the idea not_run with reason not_probeable", async () => {
    const { deps, run } = setup([{ content: ["nothing here can be tested in seconds"] }]);
    const out = await runProbeBatch(deps, [{ dossier: dossier("d1") }], { roundWallSeconds: 600 });
    expect(out[0]!.status).toBe("not_run");
    expect(out[0]!.reason).toBe("not_probeable");
    expect(out[0]!.error).toContain("probe_spec");
    expect(evidenceOf(run, "d1").probe?.reason).toBe("not_probeable");
  });

  test("the batch runs through the shared limiter without nesting it", async () => {
    const { deps } = setup([...proberSays(GOOD_ARGS), ...proberSays(GOOD_ARGS)]);
    const out = await runProbeBatch(deps, [{ dossier: dossier("e1") }, { dossier: dossier("e2") }], { roundWallSeconds: 600, limiter: deps.limiter });
    expect(out.length).toBe(2);
    expect(deps.limiter.active).toBe(0);
    expect(deps.limiter.pending).toBe(0);
  });

  test("records and emits the frozen probe preview before the process result", async () => {
    const { deps, record } = setup(proberSays(GOOD_ARGS));
    const order: string[] = [];
    deps.onProbePreview = async (spec) => { order.push(`preview:${spec.ideaId}:${spec.command}`); };
    const out = await runProbeBatch(deps, [{ dossier: dossier("preview-1") }], { roundWallSeconds: 600, onEach: () => order.push("result") });
    expect(out[0]!.status).toBe("pass");
    expect(order[0]).toContain("preview:preview-1:");
    expect(order.at(-1)).toBe("result");
    expect(record.read().some((event) => event.t === "note" && event.text.startsWith("probe.preview "))).toBe(true);
  });

  test("probes actually overlap in wall clock time, not one idea at a time", async () => {
    // A per-call handler (not a fixed response queue) so concurrent probers can't race for a shared
    // queue position: each call decides its own turn from its own context, order-independent.
    const SLEEP_MS = 300;
    const model = createMockModel({
      id: "mock-prober",
      handler: (ctx: unknown) => {
        const msgs = (ctx as { messages?: { role?: string }[] }).messages ?? [];
        if (msgs.some((m) => m.role === "toolResult")) return { content: ["probe written"] };
        return {
          content: [
            {
              type: "toolCall" as const,
              name: "probe_spec",
              arguments: { files: [], command: `sleep ${SLEEP_MS / 1000} && echo READY`, needs: [], networkRequired: false, timeoutSeconds: 20, successPredicate: { type: "substring", value: "READY" } },
            },
          ],
        };
      },
    } as never);
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const run = createRun(home, "seed");
    const record = new RunRecord(run.record);
    const deps = {
      home,
      run,
      record,
      cfg: defaultConfig(),
      models: () => ({ model: model as never, ref: "mock/mock-prober" }),
      apiKeyFor: async () => "k",
      effort: "low",
      streamFn: streamMock as never,
      limiter: new Limiter(3),
    } as unknown as PhaseDeps;
    const ideas = [dossier("p1"), dossier("p2"), dossier("p3")].map((d) => ({ dossier: d }));
    const startedAt = Date.now();
    const out = await runProbeBatch(deps, ideas, { roundWallSeconds: 600 });
    const elapsedMs = Date.now() - startedAt;
    expect(out.map((r) => r.status)).toEqual(["pass", "pass", "pass"]);
    // Three ideas, each sleeping SLEEP_MS, through a limiter of concurrency 3: serial execution
    // takes at least 3 * SLEEP_MS; true concurrency overlaps the sleeps and finishes in roughly
    // one sleep's worth of wall clock.
    expect(elapsedMs).toBeLessThan(SLEEP_MS * 3 - 200);
  });

  test("a probe whose remaining round budget is below the minimum useful timeout is not_run: budget, not dispatched", async () => {
    const { deps, run, record } = setup(proberSays({ ...GOOD_ARGS, command: "echo hi" }));
    // roundWallSeconds=10 with 6s already elapsed leaves 4s of budget — under MIN_TIMEOUT_SECONDS (5s).
    let t = 0;
    const clock = [0, 6_000];
    const out = await runProbeBatch(deps, [{ dossier: dossier("f1") }], { roundWallSeconds: 10, now: () => clock[Math.min(t++, clock.length - 1)]! });
    expect(out.map((r) => [r.ideaId, r.status, r.reason])).toEqual([["f1", "not_run", "budget"]]);
    expect(evidenceOf(run, "f1").probe).toMatchObject({ status: "not_run", reason: "budget" });
    expect(record.read().filter((e) => e.t === "model.call").length).toBe(0);
  });

  test(
    "a probe's timeout is clamped to the round's remaining budget, not just cfg.timeoutSeconds or the spec's own timeout",
    async () => {
      // Real clock, a round budget well above MIN_TIMEOUT_SECONDS (so the idea is dispatched) but far
      // below both the spec's declared 20s and cfg's default 120s: only the round-budget clamp from
      // finding 3 can make this idea time out this early, proving it — not just spec/cfg clamping —
      // is in effect. `sleep 30` never gets anywhere near completing before the clamp kills it.
      const { deps, run, record } = setup(proberSays({ ...GOOD_ARGS, command: "sleep 30; echo READY", timeoutSeconds: 20 }));
      const out = await runProbeBatch(deps, [{ dossier: dossier("g1") }], { roundWallSeconds: 6 });
      expect(out[0]!.status).toBe("timeout");
      expect(out[0]!.durationMs).toBeGreaterThan(4500);
      expect(out[0]!.durationMs).toBeLessThan(8000);
      expect(evidenceOf(run, "g1").probe?.status).toBe("timeout");
      expect(probeEvents(record)[0]!.status).toBe("timeout");
    },
    10_000,
  );

  test("a queued idea's remaining budget is re-checked fresh right before it runs, not stale from when it was enqueued", async () => {
    // Two ideas, one limiter slot: h1 runs to completion (writeProbe + runProbe) before h2 is ever
    // released from the queue, so with an injected clock these are the calls in exactly this order:
    // started, h1's enqueue check, h2's enqueue check (both still well within budget — this is the
    // normal case, since the loop dispatches every idea before any of them has actually run), then
    // h1's pre-runProbe recheck, then — only once h1 finishes and hands its slot to h2 — h2's own
    // pre-runProbe recheck. That last call reports the round's budget as gone even though h2 looked
    // fine when it was enqueued: exactly the staleness this fix closes.
    const { deps, run, record } = setup([...proberSays({ ...GOOD_ARGS, command: "echo hi" }), ...proberSays({ ...GOOD_ARGS, command: "echo hi" })], 1);
    let t = 0;
    const clock = [0, 0, 0, 1_000, 9_500];
    const out = await runProbeBatch(deps, [{ dossier: dossier("h1") }, { dossier: dossier("h2") }], {
      roundWallSeconds: 10,
      now: () => clock[Math.min(t++, clock.length - 1)]!,
    });
    expect(out.map((r) => [r.ideaId, r.status, r.reason])).toEqual([
      ["h1", "pass", undefined],
      ["h2", "not_run", "budget"],
    ]);
    expect(evidenceOf(run, "h2").probe).toMatchObject({ status: "not_run", reason: "budget" });
    // h2's prober DID run — its slot opened while the enqueue-time snapshot still looked fine, so a
    // stale clamp (the round-1 bug) would have dispatched it to runProbe instead of catching this.
    // It is the fresh pre-runProbe recheck, not the enqueue-time one, that stops it here.
    expect(record.read().filter((e) => e.t === "model.call").length).toBe(2);
  });
});
