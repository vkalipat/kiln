import { describe, expect, test } from "bun:test";
import { StallDetector, classifyFailure } from "../../src/core/failure";

describe("classifyFailure", () => {
  test("structured refusal details win over message and status classification", () => {
    expect(classifyFailure({ stopDetails: { type: "refusal", category: "policy" }, status: 503, timedOut: true })).toBe("refusal");
    expect(classifyFailure({ stopDetails: { type: "sensitive" }, message: "usd_cap" })).toBe("refusal");
  });
  test("rate limit is transient", () => expect(classifyFailure({ status: 429 })).toBe("transient"));
  test("5xx is transient", () => expect(classifyFailure({ status: 503 })).toBe("transient"));
  test("timeout is deadline", () => expect(classifyFailure({ timedOut: true })).toBe("deadline"));
  test("abort error is deadline", () => expect(classifyFailure({ error: Object.assign(new Error("x"), { name: "AbortError" }) })).toBe("deadline"));
  test("network error is transient", () => expect(classifyFailure({ error: new TypeError("fetch failed") })).toBe("transient"));
  test("non-zero exit is verify", () => expect(classifyFailure({ exitCode: 1 })).toBe("verify"));
  test("policy keyword", () => expect(classifyFailure({ message: "policy: path outside allowed roots" })).toBe("policy"));
  test("usd-cap stop text is budget", () => expect(classifyFailure({ message: "usd_cap reached at a turn boundary" })).toBe("budget"));
});

describe("StallDetector", () => {
  test("three identical fingerprints stall", () => {
    const d = new StallDetector(3);
    expect(d.observe("bash", "error: x")).toBe(false);
    expect(d.observe("bash", "error: x")).toBe(false);
    expect(d.observe("bash", "error: x")).toBe(true);
    expect(d.tool).toBe("bash");
    expect(d.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  test("a different result resets", () => {
    const d = new StallDetector(3);
    d.observe("bash", "a"); d.observe("bash", "a"); d.observe("bash", "b");
    expect(d.observe("bash", "a")).toBe(false);
  });
});
