import { expect, test } from "bun:test";
import { paletteInvocation } from "../../src/tui/palette-input";
import { commandToArgv } from "../../src/tui/palette";

test("adaptive controls ignore the draft and preview preserves it as a seed", () => {
  expect(paletteInvocation("model: adaptive", "run-1", "my idea")).toEqual({ args: [] });
  expect(commandToArgv("model: adaptive")).toEqual(["model", "routing", "adaptive"]);
  expect(commandToArgv("model: manual")).toEqual(["model", "routing", "manual"]);
  expect(commandToArgv("model: preview", paletteInvocation("model: preview", undefined, "research a business idea").args)).toEqual(["model", "plan", "research a business idea"]);
  expect(paletteInvocation("model: preview", undefined, "").missing).toBeDefined();
});

test("calibration palette preserves explicit labels and spending authorization", () => {
  const bound = paletteInvocation("evals: calibrate", "run-1", "--labels human --budget 8 --groups 20");
  expect(commandToArgv("evals: calibrate", bound.args)).toEqual(["evals", "calibrate", "--labels", "human", "--budget", "8", "--groups", "20"]);
  expect(paletteInvocation("evals: calibrate", "run-1", "").missing).toContain("--budget");
});
