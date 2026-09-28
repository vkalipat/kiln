import { expect, test } from "bun:test";
import { classifyOperatorStep } from "../../src/routing/jev";
test("discrete step advisor preserves explicit fallback without opt-in", async () => {
  expect(await classifyOperatorStep("Fix the bug", { fallback: "implement" })).toMatchObject({ choice: "implement", source: "fallback", reason: "disabled" });
});
test("caller may restrict actions, never supply model refs or missing fallback", () => {
  expect(() => classifyOperatorStep("task", { fallback: "review", allowedSteps: ["research", "implement"] })).toThrow();
  expect(() => classifyOperatorStep("task", { fallback: "implement", allowedSteps: ["implement", "implement"] })).toThrow();
});
