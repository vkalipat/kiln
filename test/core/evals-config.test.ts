import { expect, test } from "bun:test";
import { defaultEvals } from "../../src/core/evals-config";

test("eval defaults keep a total role plan and the frozen sweep size", () => {
  const config = defaultEvals();
  expect(Object.keys(config.rolePhases)).toHaveLength(10);
  expect(config.sweepPairsPerSeed).toBe(8);
  expect(config.rolePhases.reflector).toEqual({ through: "build", cloneAfter: "freeze" });
});
