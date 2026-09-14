import { test, expect } from "bun:test";
import { payload, grade, wilson, reserveUsd, requestBody, normalizeFormat, type Item } from "../../scripts/benchmarks/runtime-pilot";
const item: Item = { id: "synthetic", dataset: "arc1", input: { train: [{ input: [[0]], output: [[1]], secret: "LEAK" }], test: [{ input: [[0]], output: "LEAK" }], target: "LEAK" }, target: [[[1]]], sourceHash: "synthetic" };
test("positive allowlist removes answer fields and nested extras", () => { expect(payload(item)).not.toContain("LEAK"); expect(JSON.parse(payload(item)).test).toEqual([{ input: [[0]] }]); });
test("all grids and dimensions must match; wrong malformed refusal and failures never correct", () => {
  expect(grade(item, '{"answer":[[[1]]]}', "done").correct).toBe(true);
  for (const [text, status] of [['{"answer":[[[1,1]]]}', "done"], ['{"answer":[[[1]]]}', "refused"], ['answer: 1', "done"], ['{"answer":[[[1]]]}', "timeout"]]) expect(grade(item, text!, status!).correct).toBe(false);
  expect(grade({ ...item, target: [[[1]], [[2]]] }, '{"answer":[[[1]]]}', "done").correct).toBe(false);
});
test("MC payload omits targets and scores letters exactly", () => {
  const mc: Item = { ...item, dataset: "biology", input: { question: "synthetic", choices: ["one", "two"], answer: "LEAK" }, target: "B" };
  expect(payload(mc)).not.toContain("LEAK"); expect(grade(mc, '{"answer":"B"}', "done").correct).toBe(true); expect(grade(mc, '{"answer":"two"}', "done").correct).toBe(false);
});
test("Wilson bounds and worst-case reservation", () => { expect(wilson(0, 0)).toBeNull(); expect(wilson(0, 10)![1]).toBeGreaterThan(0.27); expect(wilson(10, 10)![0]).toBeLessThan(0.73); expect(reserveUsd(1000)).toBeGreaterThan(0.2); expect(reserveUsd(2000)).toBeGreaterThan(reserveUsd(1000)); });
test("transport reads native OAuth byte payloads and SDK Request without changing them", async () => {
  const body = '{"model":"synthetic","max_tokens":4096}';
  expect(await requestBody("https://example.invalid", { body })).toBe(body);
  expect(await requestBody("https://example.invalid", { body: new TextEncoder().encode(body) })).toBe(body);
  const req = new Request("https://example.invalid", { method: "POST", body });
  expect(await requestBody(req)).toBe(body); expect(await req.text()).toBe(body);
});
test("post-hoc normalizer extracts formatting only, without answer coercion", () => {
  expect(normalizeFormat('Explanation\n{"answer":"B"}')).toEqual({ category: "prose_before_final_JSON_object", text: '{"answer":"B"}' });
  expect(normalizeFormat('```json\n{"answer":"B"}\n```').category).toBe("Markdown_fenced_valid_JSON");
  expect(normalizeFormat('"B"').category).toBe("JSON_scalar_wrong_shape");
  expect(normalizeFormat('{"answer":2}').text).toBe('{"answer":2}');
  expect(normalizeFormat('nothing').category).toBe("unparseable");
});
