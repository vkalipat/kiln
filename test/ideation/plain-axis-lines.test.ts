import { expect, test } from "bun:test";
import { normalizeAxes, parseDossier } from "../../src/ideation/dossier";

test("plain axis lines follow the documented generator format without guessing values", () => {
  const axes = [
    { name: "mechanism", values: ["low-rank effect transfer", "optimal transport"] },
    { name: "transfer assumption", values: ["shared effect subspace", "transferable latent representation"] },
    { name: "distribution representation", values: ["empirical residual samples", "transported cell samples"] },
    { name: "target context access", values: ["control cells", "none"] },
    { name: "value emphasis", values: ["cpu efficiency", "shift robustness"] },
  ];
  for (const prefix of ["", "- "]) {
    const text = "## Axes\n" + axes.map((axis) => `${prefix}${axis.name}: ${axis.values[0]}`).join("\n");
    const mapped = normalizeAxes(parseDossier(text).dossier, axes);
    expect(mapped.missing).toEqual([]); expect(mapped.unknown).toEqual([]); expect(mapped.extra).toEqual([]);
    expect(Object.keys(mapped.axisValues)).toHaveLength(5);
  }
  const invalid = normalizeAxes(parseDossier("## Axes\nmechanism: invented mechanism\nunknown axis: value").dossier, axes);
  expect(invalid.unknown).toHaveLength(1); expect(invalid.extra).toEqual(["unknown axis"]); expect(invalid.missing).toHaveLength(4);
});
