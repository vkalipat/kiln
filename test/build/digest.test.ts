import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_EXCERPT_CHARS, DIGEST_CAP_BYTES, buildDigest, composeDigest, digestHeadings, type DigestInputs } from "../../src/build/digest";
import type { BuildState } from "../../src/build/state";
import type { Role } from "../../src/core/config";
import type { RecordEvent, StoredEvent } from "../../src/core/events";
import { initHome } from "../../src/core/home";
import { hashInput, RunRecord } from "../../src/core/record";
import { createRun, writeStatus } from "../../src/core/run";
import type { FeaturesFile } from "../../src/formation/features";

const FIXED = ["Event counts", "Cost and tokens by role", "Failures by class", "Honest exits by kind", "Tool use", "Stall fingerprints", "Stop kind"];

let seq = 0;
const ev = (event: RecordEvent): StoredEvent => ({ seq: ++seq, ts: "2026-09-04T00:00:00.000Z", ...event } as StoredEvent);
const call = (role: Role, costUsd: number, usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 }): RecordEvent =>
  ({ t: "model.call", role, provider: "p", model: "m", inputHash: "h", usage, costUsd, stopReason: "stop", excerpt: "" });
const check = (checkId: string, featureId: string, attempt: number, ok: boolean, outputPath: string, phase: "acceptance" | "regression" = "acceptance"): RecordEvent =>
  ({ t: "check", checkId, featureId, attempt, kind: "shell", phase, ok, exitCode: ok ? 0 : 1, durationMs: 5, overrunMs: 0, timedOut: false, outputPath, outputTruncated: false });
const attempt = (featureId: string, n: number, disposition: "passed" | "verify_failed", costUsd: number): RecordEvent =>
  ({ t: "attempt", featureId, attempt: n, arm: "fresh", builderStopped: "done", builderSelfVerified: false, builderCommitted: true, contextPressure: false, declaredUnsatisfiable: false, declarationReasons: [], declarationOverruled: false, builderCostUsd: costUsd, auditorCostUsd: 0, costUsd, counted: true, disposition });

function features(ids: string[]): FeaturesFile {
  return { version: 1, init: { needs: [] }, features: ids.map((id) => ({ id, title: `Feature ${id}`, description: "d", acceptance: { type: "shell", command: "true" } })) };
}
function state(ids: string[]): BuildState {
  return Object.fromEntries(ids.map((id) => [id, { state: "passed", passes: true, passTransitions: 1, passCommitShas: [], observedCommitShas: [], legacyPassTransitions: 0, legacyCommitShas: [], attempts: 1, repairs: 0 }])) as BuildState;
}

function inputs(patch: Partial<DigestInputs> = {}): DigestInputs {
  seq = 0;
  const outputs: Record<string, string> = { "/out/c1": "all 3 tests passed\n## Fake heading\nmore", "/out/c2": "x".repeat(1_000) };
  const events = [
    ev({ t: "phase.start", phase: "build" }),
    ev(call("builder", 0.5)),
    ev(call("auditor", 0.25, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 })),
    ev({ t: "tool.call", name: "bash", args: { cmd: "SENTINEL_ARGS" }, ok: true, durationMs: 1, excerpt: "SENTINEL_EXCERPT" }),
    ev({ t: "tool.call", name: "bash", args: {}, ok: false, durationMs: 1, excerpt: "" }),
    ev({ t: "tool.call", name: "write", args: {}, ok: true, durationMs: 1, excerpt: "" }),
    ev(check("c1", "f01", 1, true, "/out/c1")),
    ev(attempt("f01", 1, "passed", 0.75)),
    ev(check("c2", "f02", 1, false, "/out/c2")),
    ev(attempt("f02", 1, "verify_failed", 0.3)),
    ev({ t: "stall", featureId: "f02", attempt: 1, tool: "bash", fingerprint: "fp-1" }),
    ev({ t: "failure", class: "verify", message: "SENTINEL_FAILURE" }),
    ev({ t: "failure", class: "verify", message: "again" }),
    ev({ t: "honest_exit", kind: "cannot_be_satisfied", reasons: ["SENTINEL_REASON"], source: "declared" }),
    ev({ t: "honest_exit", kind: "not_formable", reasons: [] }),
    ev({ t: "note", text: "SENTINEL_NOTE" }),
    ev({ t: "stop", stopKind: "budget", budgetTargetUsd: 25 }),
    ev({ t: "phase.end", phase: "build", outcome: "stopped" }),
  ];
  return { events, status: { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "budget" } }, features: features(["f01", "f02"]), state: state(["f01", "f02"]), checkOutput: (path) => outputs[path] ?? "", ...patch };
}

describe("composeDigest", () => {
  test("emits every fixed section under a ## heading, in order, with per-feature sections between them", () => {
    const { text, truncated } = composeDigest(inputs());
    const headings = digestHeadings(text);
    expect(headings).toEqual(["Event counts", "Cost and tokens by role", "Failures by class", "Honest exits by kind", "Feature f01", "Feature f02", "Tool use", "Stall fingerprints", "Stop kind"]);
    expect(truncated).toBe(false);
    expect(text).toContain("- model.call: 2");
    expect(text).toContain("- tool.call: 3");
    expect(text).toContain("- verify: 2");
    expect(text).toContain("- cannot_be_satisfied (declared): 1");
    expect(text).toContain("- not_formable (unrecorded): 1");
    expect(text).toContain("- bash: 2 calls, 1 failed");
    expect(text).toContain("- write: 1 calls, 0 failed");
    expect(text).toContain("fp-1");
    expect(text).toContain("- stopKind: budget");
  });

  test("keeps every usage field and the cost per role", () => {
    const { text } = composeDigest(inputs());
    expect(text).toContain("- builder: calls 1, cost $0.5000, input 100, output 20, cacheRead 30, cacheWrite 5");
    expect(text).toContain("- auditor: calls 1, cost $0.2500, input 10, output 2, cacheRead 0, cacheWrite 0");
  });

  test("writes attempt histories with a 300-character check excerpt that cannot open a new heading", () => {
    const { text } = composeDigest(inputs());
    const f01 = text.slice(text.indexOf("## Feature f01"), text.indexOf("## Feature f02"));
    expect(f01).toContain("- attempt 1 (fresh): passed, builder done, cost $0.7500, counted");
    expect(f01).toContain("check c1 (acceptance): ok, exit 0: all 3 tests passed ## Fake heading more");
    expect(digestHeadings(text)).not.toContain("Fake heading");
    const f02 = text.slice(text.indexOf("## Feature f02"), text.indexOf("## Tool use"));
    const excerpt = /exit 1: (x+)/.exec(f02)?.[1] ?? "";
    expect(excerpt.length).toBe(CHECK_EXCERPT_CHARS);
  });

  test("never surfaces note text, failure messages, honest-exit reasons, or tool arguments", () => {
    const { text } = composeDigest(inputs());
    for (const sentinel of ["SENTINEL_NOTE", "SENTINEL_FAILURE", "SENTINEL_REASON", "SENTINEL_ARGS", "SENTINEL_EXCERPT"]) expect(text).not.toContain(sentinel);
  });

  test("drops per-feature sections first to meet the 16 kB cap, keeping every fixed section", () => {
    const ids = Array.from({ length: 80 }, (_, index) => `f${String(index + 1).padStart(2, "0")}`);
    seq = 0;
    const events: StoredEvent[] = [ev({ t: "phase.start", phase: "build" })];
    for (const id of ids) { events.push(ev(check(`c-${id}`, id, 1, false, `/out/${id}`))); events.push(ev(attempt(id, 1, "verify_failed", 0.1))); }
    const { text, truncated } = composeDigest({ events, status: { phase: "build", state: "failed", outcome: { kind: "failure", failureClass: "integrity" } }, features: features(ids), state: state(ids), checkOutput: () => "y".repeat(400) });
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DIGEST_CAP_BYTES);
    const headings = digestHeadings(text);
    for (const fixed of FIXED) expect(headings).toContain(fixed);
    const kept = headings.filter((heading) => heading.startsWith("Feature "));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(ids.length);
    expect(kept).toEqual(ids.slice(0, kept.length).map((id) => `Feature ${id}`));
    expect(text).toContain(`${ids.length - kept.length} per-feature sections dropped`);
  });

  test("truncates the text itself only when no per-feature section is left to drop", () => {
    seq = 0;
    const events: StoredEvent[] = [];
    for (let index = 0; index < 1_500; index += 1) events.push(ev({ t: "tool.call", name: `tool_${index}_${"n".repeat(20)}`, args: {}, ok: true, durationMs: 1, excerpt: "" }));
    const { text, truncated } = composeDigest({ events, status: { phase: "reflect", state: "done", outcome: { kind: "success" } } });
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DIGEST_CAP_BYTES);
    expect(text).not.toContain("�");
  });
});

describe("buildDigest", () => {
  test("writes reflect/digest.md and returns its hash, byte count and truncation flag", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-digest-")); initHome(home);
    const run = createRun(home, "seed"); const record = new RunRecord(run.record);
    record.append({ t: "phase.start", phase: "build" });
    record.append(call("builder", 0.4));
    record.append({ t: "phase.end", phase: "build", outcome: "ok" });
    writeStatus(run, { phase: "reflect", state: "running" });
    const out = buildDigest(run);
    expect(existsSync(run.digest)).toBe(true);
    expect(readFileSync(run.digest, "utf8")).toBe(out.text);
    expect(out.hash).toBe(hashInput(out.text));
    expect(out.bytes).toBe(Buffer.byteLength(out.text));
    expect(out.truncated).toBe(false);
    expect(digestHeadings(out.text)).toEqual(FIXED);
    expect(out.text).toContain("- outcome: success");
    expect(out.text).toContain("- stopKind: none");
  });

  test("reports a finished run as success whether reflect finds it still open or already closed, and never mid-build as success", () => {
    const events = [ev({ t: "phase.end", phase: "build", outcome: "ok" })];
    expect(composeDigest({ events, status: { phase: "reflect", state: "running" } }).text).toContain("- outcome: success");
    expect(composeDigest({ events, status: { phase: "reflect", state: "done", outcome: { kind: "success" } } }).text).toContain("- outcome: success");
    expect(composeDigest({ events, status: { phase: "build", state: "running" } }).text).toContain("- outcome: running");
  });

  test("reads check excerpts from the recorded output paths and folds feature state when features.json exists", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-digest-")); initHome(home);
    const run = createRun(home, "seed"); const record = new RunRecord(run.record);
    writeFileSync(run.features, JSON.stringify(features(["f01"])));
    writeFileSync(run.featureState, `${JSON.stringify({ t: "feature.state", featureId: "f01", from: "pending", to: "blocked", reason: "attempts_exhausted", attempts: 3, repairs: 0 })}\n`);
    const output = join(run.dir, "check-out.txt"); writeFileSync(output, "boom\n");
    record.append({ t: "phase.start", phase: "build" });
    record.append(check("c1", "f01", 1, false, output));
    record.append(attempt("f01", 1, "verify_failed", 0.2));
    record.append(check("gone", "f01", 2, false, join(run.dir, "missing.txt")));
    record.append(attempt("f01", 2, "verify_failed", 0.2));
    record.append({ t: "stop", stopKind: "blocked" });
    record.append({ t: "phase.end", phase: "build", outcome: "stopped" });
    writeStatus(run, { phase: "build", state: "stopped", outcome: { kind: "stopped", stopKind: "blocked" } });
    const out = buildDigest(run);
    expect(out.text).toContain("## Feature f01");
    expect(out.text).toContain("state: blocked, attempts 3, blocked attempts_exhausted");
    expect(out.text).toContain("check c1 (acceptance): failed, exit 1: boom");
    expect(out.text).toContain("check gone (acceptance): failed, exit 1: (output missing)");
    expect(out.text).toContain("- stopKind: blocked");
  });
});
