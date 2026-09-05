import { expect, test } from "bun:test";
import { paletteInvocation } from "../../src/tui/palette-input";
import { commandToArgv } from "../../src/tui/palette";

test("calibration palette preserves explicit labels and spending authorization", () => {
  const bound = paletteInvocation("evals: calibrate", "run-1", "--labels human --budget 8 --groups 20");
  expect(commandToArgv("evals: calibrate", bound.args)).toEqual(["evals", "calibrate", "--labels", "human", "--budget", "8", "--groups", "20"]);
  expect(paletteInvocation("evals: calibrate", "run-1", "").missing).toContain("--budget");
});
