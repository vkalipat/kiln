import { expect, test } from "bun:test";
import { resolveJevRoutingMode, shouldClassifyJev, type JevRoutingMode, type JevRoutingTrigger } from "../../src/operator/jev-routing-policy";

test("new runs classify only explicit auto boundaries by default", () => {
  const mode = resolveJevRoutingMode({ isResume: false });
  expect(mode).toBe("boundaries");
  expect(shouldClassifyJev(mode, "prompt")).toBe(false);
  expect(shouldClassifyJev(mode, "route_step_auto")).toBe(true);
  expect(shouldClassifyJev(mode, "explicit_step")).toBe(false);
});
test("explicit per-prompt experiment remains available without changing explicit steps", () => {
  const mode = resolveJevRoutingMode({ isResume: false, requestedMode: "per_prompt" });
  expect(shouldClassifyJev(mode, "prompt")).toBe(true);
  expect(shouldClassifyJev(mode, "route_step_auto")).toBe(true);
  expect(shouldClassifyJev(mode, "explicit_step")).toBe(false);
});
test("resume preserves both frozen modes and historical pre-mode Jev behavior", () => {
  for (const mode of ["boundaries", "per_prompt"] as const) {
    expect(resolveJevRoutingMode({ isResume: true, savedPolicy: { mode } })).toBe(mode);
    expect(resolveJevRoutingMode({ isResume: true, savedPolicy: { mode }, requestedMode: mode })).toBe(mode);
  }
  expect(resolveJevRoutingMode({ isResume: true, savedPolicy: {} })).toBe("per_prompt");
  expect(resolveJevRoutingMode({ isResume: true })).toBe("boundaries");
});
test("resume rejects an explicit mode conflict instead of silently rewriting policy", () => {
  expect(() => resolveJevRoutingMode({ isResume: true, savedPolicy: { mode: "boundaries" }, requestedMode: "per_prompt" })).toThrow("preserves");
  expect(() => resolveJevRoutingMode({ isResume: true, savedPolicy: {}, requestedMode: "boundaries" })).toThrow("preserves");
  expect(() => resolveJevRoutingMode({ isResume: true, requestedMode: "per_prompt" })).toThrow("preserves");
});
test("invalid persisted/input modes fail before any routing action", () => {
  for (const value of [null, "all", 1, {}, ""]) {
    expect(() => resolveJevRoutingMode({ isResume: false, requestedMode: value })).toThrow("routing mode");
    expect(() => resolveJevRoutingMode({ isResume: true, savedPolicy: { mode: value } })).toThrow("routing mode");
  }
  expect(() => shouldClassifyJev("unexpected" as JevRoutingMode, "prompt")).toThrow();
  expect(() => shouldClassifyJev("boundaries", "unknown" as JevRoutingTrigger)).toThrow();
});
