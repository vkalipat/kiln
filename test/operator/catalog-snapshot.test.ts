import { expect, test } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-catalog";
import { ROLES } from "../../src/core/config";
import { operatorCatalogSha256 } from "../../src/operator/catalog-snapshot";
import type { PreparedStepRouting } from "../../src/operator/routing";
const ref = "openai/test-frontier", alternative = "openai/test-alternative";
const prepared = (): PreparedStepRouting => ({
  admittedRoleRefs: Object.fromEntries(ROLES.map(role => [role, [{ ref, effort: "low" }, { ref: alternative, effort: "high" }]])),
  selectedRoleRefs: Object.fromEntries(ROLES.map(role => [role, ref])),
  fingerprint: "unrelated", configHash: "unrelated", evidence: { asOf: "2000-01-01" },
}) as unknown as PreparedStepRouting;
const model = (): Model => ({ provider: "openai", id: "test-frontier", api: "openai-responses", supportsTools: true, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000, thinking: { mode: "effort", efforts: ["low", "high"] } }) as unknown as Model;
const lookup = (value = model()) => (key: string) => ({ ...value, id: key.split("/")[1]! });
test("catalog snapshot is canonical and independent of effort, unrelated hashes, and dates", () => {
  const a = prepared(), first = operatorCatalogSha256(a, lookup());
  const b = prepared(); b.admittedRoleRefs.brain[0]!.effort = "high"; b.configHash = "effort-changed"; b.fingerprint = "different";
  b.evidence = { ...b.evidence, asOf: "2030-01-01" };
  const reordered = Object.fromEntries(Object.entries(model()).reverse()) as unknown as Model;
  expect(operatorCatalogSha256(b, lookup(reordered))).toBe(first); expect(first).toMatch(/^[a-f0-9]{64}$/);
});
test("price, API, token, reasoning and tool capability drift each changes the fingerprint", () => {
  const original = model(), baseline = operatorCatalogSha256(prepared(), lookup(original));
  const changed: Model[] = [
    { ...original, cost: { ...original.cost, input: 9 } },
    { ...original, api: "openai-completions" },
    { ...original, maxTokens: original.maxTokens! + 1 },
    { ...original, contextWindow: original.contextWindow! + 1 },
    { ...original, thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] } },
    { ...original, toolMode: "code_mode_only" },
    { ...original, supportsTools: false },
    { ...original, headers: { "X-Client-Version": "new" } },
  ];
  for (const value of changed) expect(operatorCatalogSha256(prepared(), lookup(value))).not.toBe(baseline);
});
test("selected model and admitted membership or priority are frozen", () => {
  const a = prepared(), baseline = operatorCatalogSha256(a, lookup());
  const b = prepared(); b.selectedRoleRefs.brain = alternative;
  expect(operatorCatalogSha256(b, lookup())).not.toBe(baseline);
  const c = prepared(); c.admittedRoleRefs.brain.reverse();
  expect(operatorCatalogSha256(c, lookup())).not.toBe(baseline);
  const d = prepared(); d.admittedRoleRefs.brain.pop();
  expect(operatorCatalogSha256(d, lookup())).not.toBe(baseline);
});
test("missing, mismatched and credential-bearing model data fail closed", () => {
  expect(() => operatorCatalogSha256(prepared(), () => undefined)).toThrow("unavailable");
  expect(() => operatorCatalogSha256(prepared(), () => model())).toThrow("identity mismatch");
  expect(() => operatorCatalogSha256(prepared(), lookup({ ...model(), headers: { Authorization: "private" } }))).toThrow("credential fields");
});
