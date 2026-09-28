import { expect, test } from "bun:test";
import { compileWorkflow, planWorkflow } from "../../src/workflow/plan";

test("explicit ideation survives implementation vocabulary while preserving a supplied concept", () => {
  const seed = "Research a computational approach to predicting response distributions. Use the actual research and ideation loop to generate materially different mechanisms, examine prior art and counterevidence, compare eligible candidates, select a direction, and build a minimal runnable predictor with evaluation files. Optimize quality jointly with compute efficiency.";
  const plan = planWorkflow(seed);
  expect(plan).toMatchObject({ intent: "supplied_concept", goal: "deliver", assumptionPolicy: "preserve", strategy: { mode: "focused", research: "targeted" } });
  expect(compileWorkflow(plan, {}).phases).toEqual(["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"]);
});

test("declined ideation and alternatives preserve direct utility routing", () => {
  for (const suffix of ["No ideation.", "No alternatives.", "Skip ideation.", "No ideation or alternatives.", "Do not brainstorm."]) {
    expect(planWorkflow(`Build a CSV parser. ${suffix}`).strategy).toEqual({ mode: "direct", research: "none" });
  }
  expect(planWorkflow("Build a CSV parser.").strategy).toEqual({ mode: "direct", research: "none" });
});
