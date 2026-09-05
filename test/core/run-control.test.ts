import { describe, expect, test } from "bun:test";
import {
  currentRunControl,
  rethrowIfRunCancelled,
  RunCancelledError,
  RunControl,
  throwIfRunCancelled,
  withRunControl,
  type RunControlEvent,
} from "../../src/core/run-control";

describe("RunControl", () => {
  test("scopes controls across awaits and restores a nested parent", async () => {
    const outer = new RunControl();
    const inner = new RunControl();
    expect(currentRunControl()).toBeUndefined();
    await withRunControl(outer, async () => {
      await Promise.resolve();
      expect(currentRunControl()).toBe(outer);
      await withRunControl(inner, async () => {
        await Promise.resolve();
        expect(currentRunControl()).toBe(inner);
      });
      expect(currentRunControl()).toBe(outer);
    });
    expect(currentRunControl()).toBeUndefined();
  });

  test("emits correlated source events and stops after unsubscribe or disposal", () => {
    const control = new RunControl();
    const events: RunControlEvent[] = [];
    const unsubscribe = control.subscribe((event) => events.push(event));
    const source = control.registerSource({ role: "brain", phase: "frame" });
    source.text("hello");
    source.toolStart("call-1", "read", { path: "brief.md" });
    source.toolEnd("call-1", "read", true, "body");
    expect(events.map((event) => event.type)).toEqual(["text", "tool_start", "tool_end"]);
    expect(events.every((event) => event.sourceId === source.sourceId && event.role === "brain" && event.phase === "frame")).toBe(true);
    expect(events[1]).toMatchObject({ toolCallId: "call-1", name: "read" });
    source.dispose();
    source.text("late");
    unsubscribe();
    expect(events).toHaveLength(3);
  });

  test("steers only registered eligible sources and removes disposed sources", () => {
    const control = new RunControl();
    const messages: string[] = [];
    const steerable = control.registerSource({ role: "builder", phase: "build", steer: (text) => messages.push(text) });
    control.registerSource({ role: "judge", phase: "ideate", steer: (text) => messages.push(`judge: ${text}`) });
    expect(control.steer("focus")).toEqual([steerable.sourceId]);
    expect(messages).toEqual(["focus"]);
    steerable.dispose();
    expect(control.steer("late")).toEqual([]);
  });

  test("cancel is idempotent and throws a typed control-flow error", () => {
    const control = new RunControl();
    control.cancel("operator stop");
    const firstReason = control.signal.reason;
    control.cancel("ignored second stop");
    expect(control.signal.reason).toBe(firstReason);
    expect(() => throwIfRunCancelled(control.signal)).toThrow(RunCancelledError);
    expect(() => throwIfRunCancelled(control.signal)).toThrow("operator stop");
  });

  test("preserves a direct cancellation error without an ambient control", () => {
    const cancellation = new RunCancelledError("direct stop");
    expect(() => rethrowIfRunCancelled(cancellation)).toThrow(cancellation);
    expect(() => rethrowIfRunCancelled(new Error("ordinary"))).not.toThrow();
  });
});
