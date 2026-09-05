import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consecutivePauses, handleBuilderTransient, pauseBeforePick, retryWindowExit } from "../../src/build/loop-transient";
import { appendAttempt } from "../../src/build/loop-support";
import { parseProgress } from "../../src/build/progress";
import { foldState } from "../../src/build/state";
import { saveConfig } from "../../src/core/config";
import { readStatus } from "../../src/core/run";
import type { RecordEvent, StoredEvent } from "../../src/core/events";
import { builderResult, feature, setupLoop, type LoopFixture } from "./loop-fixture";

const RESET_AT = "2026-09-05T00:00:00.000Z";
const f01 = feature();

function pick(s: LoopFixture, attempt: number, featureBudgetUsd = 5) {
  s.record.append({ t: "feature.pick", featureId: "f01", attempt, phaseBudgetUsd: 10, featureBudgetUsd });
}

const dispositions = (s: LoopFixture) => s.record.read().flatMap((event) => event.t === "attempt" ? [event.disposition] : []);

describe("consecutivePauses", () => {
  const stored = (seq: number, event: RecordEvent): StoredEvent => ({ seq, ts: "2026-09-04T00:00:00.000Z", ...event });
  const pause = (seq: number) => stored(seq, { t: "pause", reason: "usage_limit", wakeAt: RESET_AT });

  test("counts usage pauses since the last attempt, pick, or transient stop", () => {
    const attempt = stored(4, { t: "attempt", featureId: "f01", attempt: 1, arm: "fresh", builderStopped: "done", builderSelfVerified: false, builderCommitted: false, contextPressure: false, declaredUnsatisfiable: false, declarationReasons: [], declarationOverruled: false, builderCostUsd: 0, auditorCostUsd: 0, costUsd: 0, counted: false, disposition: "transient" });
    expect(consecutivePauses([])).toBe(0);
    expect(consecutivePauses([pause(1), pause(2)])).toBe(2);
    expect(consecutivePauses([pause(1), pause(2), stored(3, { t: "feature.pick", featureId: "f01", attempt: 1, phaseBudgetUsd: 10 })])).toBe(0);
    expect(consecutivePauses([pause(1), pause(2), stored(3, { t: "feature.pick", featureId: "f01", attempt: 1, phaseBudgetUsd: 10 }), attempt, pause(5)])).toBe(1);
    expect(consecutivePauses([pause(1), pause(2), stored(3, { t: "stop", stopKind: "transient" })])).toBe(0);
    expect(consecutivePauses([pause(1), pause(2), stored(3, { t: "stop", stopKind: "budget" }), pause(4)])).toBe(3);
    expect(consecutivePauses([pause(1), stored(2, { t: "pause", reason: "operator", wakeAt: RESET_AT })])).toBe(1);
  });
});

describe("pauseBeforePick", () => {
  test("pauses at the 95 percent boundary poll and stops after two consecutive proactive pauses", async () => {
    const s = setupLoop(); const now = Date.parse("2026-09-04T12:00:00.000Z");
    s.deps.fetchUsage = async () => ({ used: 50, limit: 100, resetAt: RESET_AT });
    expect(await pauseBeforePick(s.deps, now)).toBeUndefined();
    expect(s.record.read().some((event) => event.t === "pause" || event.t === "stop")).toBe(false);

    s.deps.fetchUsage = async () => ({ used: 95, limit: 100, resetAt: RESET_AT });
    expect(await pauseBeforePick(s.deps, now)).toEqual({ outcome: "ok" });
    expect(readStatus(s.deps.run)).toMatchObject({ state: "paused", pausedReason: "usage_limit", wakeAt: RESET_AT });
    expect(await pauseBeforePick(s.deps, now)).toEqual({ outcome: "ok" });
    expect(await pauseBeforePick(s.deps, now)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(s.record.read().filter((event) => event.t === "pause")).toHaveLength(2);
    expect(readStatus(s.deps.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "transient" } });

    // The transient stop opens a fresh window on resume.
    expect(await pauseBeforePick(s.deps, now)).toEqual({ outcome: "ok" });
    expect(s.record.read().filter((event) => event.t === "pause")).toHaveLength(3);
  });
});

describe("retryWindowExit", () => {
  const transient = { disposition: "transient", counted: false, declarationOverruled: false } as const;
  const paused = { disposition: "paused", counted: false, declarationOverruled: false } as const;
  const usage = { reason: "usage_limit", wakeAt: RESET_AT };

  test("stops on the third consecutive transient attempt and pauses until the third consecutive paused attempt", () => {
    const s = setupLoop();
    const failed = (attempt: number, value: typeof transient | typeof paused) => appendAttempt(s.deps, "fresh", f01, attempt, builderResult({ stopped: "error", error: "server", errorStatus: 500 }), 0, value);
    failed(1, transient); expect(retryWindowExit(s.deps, "f01", transient)).toBeUndefined();
    failed(2, transient); expect(retryWindowExit(s.deps, "f01", transient)).toBeUndefined();
    failed(3, transient); expect(retryWindowExit(s.deps, "f01", transient)).toMatchObject({ outcome: "stopped", stopKind: "transient" });

    failed(4, paused); expect(retryWindowExit(s.deps, "f01", paused, usage)).toEqual({ outcome: "ok" });
    expect(readStatus(s.deps.run)).toMatchObject({ state: "paused", wakeAt: RESET_AT });
    failed(5, paused); expect(retryWindowExit(s.deps, "f01", paused, usage)).toEqual({ outcome: "ok" });
    failed(6, paused); expect(retryWindowExit(s.deps, "f01", paused, usage)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(s.record.read().filter((event) => event.t === "stop")).toHaveLength(2);
  });

  test("counted dispositions never exit the loop", () => {
    const s = setupLoop();
    appendAttempt(s.deps, "fresh", f01, 1, builderResult(), 0, { disposition: "verify_failed", counted: true, declarationOverruled: false });
    expect(retryWindowExit(s.deps, "f01", { disposition: "verify_failed", counted: true, declarationOverruled: false })).toBeUndefined();
    expect(s.record.read().some((event) => event.t === "stop" || event.t === "pause")).toBe(false);
  });

  test("a wall expiry is a deadline stop ahead of the retry window's transient stop or pause", () => {
    const s = setupLoop();
    const failed = (attempt: number, value: typeof transient | typeof paused) => appendAttempt(s.deps, "fresh", f01, attempt, builderResult({ stopped: "error", error: "server", errorStatus: 500 }), 0, value);
    failed(1, transient); failed(2, transient); failed(3, transient);
    s.deps.cfg.budgets.wallSeconds = 0; saveConfig(s.home, s.deps.cfg);
    expect(retryWindowExit(s.deps, "f01", transient)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(readStatus(s.deps.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline" } });
    failed(4, paused);
    expect(retryWindowExit(s.deps, "f01", paused, usage)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(s.record.read().flatMap((event) => event.t === "stop" ? [event.stopKind] : [])).toEqual(["deadline", "deadline"]);
    expect(s.record.read().some((event) => event.t === "pause")).toBe(false);
  });
});

describe("handleBuilderTransient", () => {
  test("leaves non-transient builders to the check", async () => {
    const s = setupLoop(); pick(s, 1);
    for (const builder of [builderResult(), builderResult({ stopped: "error", error: "refused", errorStatus: 400 }), builderResult({ stopped: "turn_cap" })]) {
      expect(await handleBuilderTransient(s.deps, "fresh", s.project, s.git, f01, 1, builder)).toBeUndefined();
    }
    expect(s.record.read().some((event) => event.t === "attempt" || event.t === "feature.state")).toBe(false);
  });

  test("records an uncounted transient attempt, restores the tree, and stops on the third in a row", async () => {
    const s = setupLoop(); s.git.diffText = " file.ts | 1 +"; const before = "b".repeat(40);
    const builder = builderResult({ stopped: "error", error: "server", errorStatus: 500, beforeHead: before });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      pick(s, attempt);
      const outcome = await handleBuilderTransient(s.deps, "single_session", s.project, s.git, f01, attempt, builder);
      if (attempt < 3) expect(outcome).toEqual({ exit: undefined }); else expect(outcome?.exit).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    }
    expect(dispositions(s)).toEqual(["transient", "transient", "transient"]);
    expect(s.record.read().filter((event) => event.t === "attempt").map((event) => event.t === "attempt" && event.arm)).toEqual(["single_session", "single_session", "single_session"]);
    expect(s.record.read().filter((event) => event.t === "feature.state")).toEqual(Array.from({ length: 3 }, (_, index) => expect.objectContaining({ to: "failed", attempt: index + 1, attempts: 0, reason: "builder_transient" })));
    expect(foldState(s.deps.run).f01).toMatchObject({ state: "failed", attempts: 0, blocked: undefined });
    expect(s.git.calls.filter((call) => call.method === "checkoutAndClean")).toEqual(Array.from({ length: 3 }, () => ({ method: "checkoutAndClean", dir: s.project.repo, restoreRef: before })));
    const entries = parseProgress(readFileSync(s.project.progress, "utf8"));
    expect(entries.map((entry) => entry.key)).toEqual(["f01:1:attempt:attempt-1", "f01:2:attempt:attempt-2", "f01:3:attempt:attempt-3"]);
    expect(entries.every((entry) => entry.text.includes("discard: file.ts | 1 +"))).toBe(true);
    expect(readStatus(s.deps.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "transient" } });
  });

  test("a usage-limit error pauses reactively with the provider's reset time", async () => {
    const s = setupLoop(); const providers: string[] = []; pick(s, 1);
    s.deps.fetchUsage = async (provider) => { providers.push(provider); return { used: 10, limit: 100, resetAt: RESET_AT }; };
    const outcome = await handleBuilderTransient(s.deps, "fresh", s.project, s.git, f01, 1, builderResult({ stopped: "error", error: "rate", errorStatus: 429, builderModelRef: "anthropic/builder" }));
    expect(outcome?.exit).toEqual({ outcome: "ok" });
    expect(providers).toEqual(["anthropic"]);
    expect(dispositions(s)).toEqual(["paused"]);
    expect(readStatus(s.deps.run)).toMatchObject({ state: "paused", pausedReason: "usage_limit", wakeAt: RESET_AT });
    expect(s.record.read().find((event) => event.t === "feature.state")).toMatchObject({ to: "failed", reason: "builder_paused" });
  });

  test("a transient session that crosses the feature ceiling blocks instead of retrying", async () => {
    const s = setupLoop(); pick(s, 1, 0.1);
    const outcome = await handleBuilderTransient(s.deps, "fresh", s.project, s.git, f01, 1, builderResult({ stopped: "error", error: "server", errorStatus: 503, costUsd: 0.5 }));
    expect(outcome?.exit).toBeUndefined();
    expect(foldState(s.deps.run).f01).toMatchObject({ blocked: true, blockedReason: "feature_budget" });
    expect(s.record.read().some((event) => event.t === "stop" || event.t === "pause")).toBe(false);
  });
});
