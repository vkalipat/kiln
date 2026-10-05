import { expect, test } from "bun:test";
import { createResearchClassifier } from "../../src/operator/research-classify";
import { createJevWorkflowService, type JevWorkflowDecision } from "../../src/operator/jev-service";
import { JEV_MODEL, type JevChoiceAnswer } from "../../src/integrations/jev";
import type { ResearchPassage } from "../../src/operator/research-task";

type Request = Parameters<ReturnType<typeof createJevWorkflowService>["evaluate"]>[0];
const field = { id: "claim", question: "The feature is available." };
test("classification preflights the complete request count without spending an insufficient allocation", async () => {
  let calls = 0;
  const classify = createResearchClassifier({
    capacity: () => ({ callsRemaining: 64, inputTokensRemaining: 1_000_000, requestInputReserve: 64000 }),
    evaluate: async () => { calls++; throw new Error("must not dispatch"); },
  }, "fixture");
  const input = { question: "q".repeat(4096), fields: Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, question: "q".repeat(1024) })),
    passages: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, sourceId: `s${i}`, text: "x".repeat(12000), start: 0, end: 12000 })) };
  await expect(classify(input, new AbortController().signal)).rejects.toThrow("requires 72 requests; only 64 remain");
  expect(calls).toBe(0);
});
const passage = (id: string, text: string, sourceId = "source-1"): ResearchPassage => ({ id, text, sourceId, start: 0, end: text.length });
const answer = (choice: string, accepted = true): JevChoiceAnswer => ({ choice, accepted, confidence: accepted ? 0.99 : 0.2, probabilities: { [choice]: 1 } });
function reply(request: Request, modify?: (answers: Record<string, JevChoiceAnswer>) => void): JevWorkflowDecision {
  const state = request.state as { fields: { id: string; question: string }[]; passages: { id: string; text: string }[] };
  const support = state.passages.find(p => p.text.includes("SUPPORT"))?.id;
  const conflict = state.passages.find(p => p.text.includes("CONFLICT"))?.id;
  const answers: Record<string, JevChoiceAnswer> = {};
  for (const f of state.fields) {
    answers[`${f.id}_coverage`] = answer(support && conflict ? "mixed" : support ? "supports" : conflict ? "contradicts" : "not_stated");
    answers[`${f.id}_support`] = answer(support ?? "none");
    answers[`${f.id}_conflict`] = answer(conflict ?? "none");
  }
  modify?.(answers);
  return { source: "jev", reason: "accepted", answers, requestedModel: JEV_MODEL, returnedModel: JEV_MODEL,
    latencyMs: 0, stateHash: "fixture", dispatched: true, costUsd: 0.001 };
}

test("support and contradiction in separate chunks aggregate to mixed with existing citations", async () => {
  const requests: Request[] = [];
  const classify = createResearchClassifier({ evaluate: async request => { requests.push(request); return reply(request); } }, "session");
  const passages = Array.from({ length: 30 }, (_, i) => passage(`original-${i}`, `${i === 0 ? "SUPPORT" : i === 29 ? "CONFLICT" : "CONTEXT"} ${"x".repeat(990)}`));
  const result = await classify({ question: "Assess availability", fields: [field], passages }, new AbortController().signal);
  expect(requests.length).toBeGreaterThan(1);
  expect(result.labels).toEqual([{ sourceId: "source-1", fieldId: "claim", coverage: "mixed", passageIds: ["original-0", "original-29"] }]);
  expect(result.costUsd).toBeCloseTo(requests.length * 0.001);
  expect(requests.every(r => r.operation === "research" && r.sessionId === "session")).toBe(true);
});

test("field and passage chunking evaluates every supplied character within transport caps", async () => {
  const fields = Array.from({ length: 12 }, (_, i) => ({ id: `field-${i}`, question: `FIELD_${i} ${"Ω".repeat(950)}` }));
  const passages = Array.from({ length: 20 }, (_, i) => passage(`original-${i}`, `PASSAGE_${i} ${"界".repeat(1200)}`));
  const seen = new Map<string, string>(); let calls = 0;
  const classify = createResearchClassifier({ evaluate: async request => {
    calls++;
    expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(16000);
    const wire = { model: JEV_MODEL, state: request.state, questions: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, { type: "choice", ...q }])) };
    expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThanOrEqual(65536);
    const state = request.state as any;
    for (const f of state.fields) seen.set(f.question, (seen.get(f.question) ?? "") + state.passages.map((p: any) => p.text).join(""));
    return reply(request);
  } }, "session");
  const result = await classify({ question: "Ω".repeat(4096), fields, passages }, new AbortController().signal);
  expect(calls).toBeGreaterThan(3);
  for (const f of fields) expect(seen.get(f.question)).toBe(passages.map(p => p.text).join(""));
  expect(result.labels).toHaveLength(12);
});

test("unresolved conflict head preserves support citation without claiming complete coverage", async () => {
  const classify = createResearchClassifier({ evaluate: async request => ({ ...reply(request, answers => { answers.f0_conflict = answer("none", false); }),
    source: "fallback", reason: "low_confidence" }) }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("real-id", "SUPPORT")] }, new AbortController().signal);
  expect(result.labels[0]).toMatchObject({ coverage: "unknown", passageIds: ["real-id"] });
});

test("fabricated passage ID causes unknown instead of a fabricated citation", async () => {
  const classify = createResearchClassifier({ evaluate: async request => reply(request, answers => { answers.f0_support = answer("p999"); }) }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("real-id", "SUPPORT")] }, new AbortController().signal);
  expect(result.labels[0]).toMatchObject({ coverage: "unknown", passageIds: [] });
});

test.each(["supports", "contradicts"])("%s coverage cannot discard independently accepted opposite evidence", async selected => {
  const classify = createResearchClassifier({ evaluate: async request => reply(request, answers => { answers.f0_coverage = answer(selected); }) }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("yes", "SUPPORT"), passage("no", "CONFLICT")] }, new AbortController().signal);
  expect(result.labels[0]).toMatchObject({ coverage: "mixed", passageIds: ["yes", "no"] });
});

test("not-stated coverage conflicting with selected evidence becomes unknown and retains citation", async () => {
  const classify = createResearchClassifier({ evaluate: async request => reply(request, answers => { answers.f0_coverage = answer("not_stated"); }) }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("yes", "SUPPORT")] }, new AbortController().signal);
  expect(result.labels[0]).toMatchObject({ coverage: "unknown", passageIds: ["yes"] });
});

test("not-stated requires both none heads to be accepted", async () => {
  const classify = createResearchClassifier({ evaluate: async request => reply(request, answers => { answers.f0_support = answer("none", false); }) }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("neutral", "CONTEXT")] }, new AbortController().signal);
  expect(result.labels[0]).toMatchObject({ coverage: "unknown", passageIds: [] });
});

test("one unknown chunk preserves valid earlier citation but final coverage stays unknown", async () => {
  let calls = 0;
  const classify = createResearchClassifier({ evaluate: async request => {
    calls++;
    if (calls === 1) return reply(request);
    return { source: "fallback", reason: "timeout", requestedModel: JEV_MODEL, latencyMs: 1, stateHash: "fixture", dispatched: true };
  } }, "session");
  const passages = Array.from({ length: 20 }, (_, i) => passage(`p-${i}`, `${i === 0 ? "SUPPORT" : "CONTEXT"} ${"x".repeat(990)}`));
  const result = await classify({ question: "Assess", fields: [field], passages }, new AbortController().signal);
  expect(calls).toBeGreaterThan(1);
  expect(result.labels[0]).toMatchObject({ coverage: "unknown", passageIds: ["p-0"] });
  expect(result.costUsd).toBeUndefined();
});

test("empty captured evidence remains unknown without external evaluation", async () => {
  const classify = createResearchClassifier({ evaluate: async () => { throw new Error("must not call"); } }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("empty", "")] }, new AbortController().signal);
  expect(result).toEqual({ labels: [{ sourceId: "source-1", fieldId: "claim", coverage: "unknown", passageIds: [] }], costUsd: 0 });
});

test("missing key through production service makes no network call and zero-cost unknown labels", async () => {
  const service = createJevWorkflowService({ enabled: true, apiKey: undefined, signal: () => new AbortController().signal,
    reserve: async () => { throw new Error("must not reserve"); }, onStats: () => {},
    fetch: (async () => { throw new Error("must not call"); }) as unknown as typeof fetch });
  const result = await createResearchClassifier(service, "session")({ question: "Assess", fields: [field], passages: [passage("real-id", "SUPPORT")] }, new AbortController().signal);
  expect(result).toEqual({ labels: [{ sourceId: "source-1", fieldId: "claim", coverage: "unknown", passageIds: [] }], costUsd: 0 });
});

test("production service batches multiple field heads and reports settled transport cost", async () => {
  let calls = 0, reservations = 0;
  const service = createJevWorkflowService({ enabled: true, apiKey: "fixture", signal: () => new AbortController().signal,
    reserve: async () => { reservations++; return { dispatch: () => true, settle: () => {} }; }, onStats: () => {},
    fetch: (async (_url: unknown, init?: RequestInit) => {
      calls++;
      const sent = JSON.parse(init!.body as string);
      expect(Object.keys(sent.questions)).toHaveLength(6);
      const answers = Object.fromEntries(Object.entries(sent.questions).map(([id, raw]) => {
        const q = raw as { criteria: Record<string, string> };
        const choice = id.endsWith("_coverage") ? "supports" : id.endsWith("_support") ? "p0" : "none";
        return [id, { type: "choice", choice, confidence: 0.99,
          probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }];
      }));
      return Response.json({ model: JEV_MODEL, answers, usage: { input_tokens: 300, output_tokens: 60 } });
    }) as unknown as typeof fetch });
  const result = await createResearchClassifier(service, "session")({ question: "Assess", fields: [field, { id: "second", question: "Another claim" }],
    passages: [passage("original-citation", "SUPPORT")] }, new AbortController().signal);
  expect(calls).toBe(1); expect(reservations).toBe(1);
  expect(result.labels.map(label => label.passageIds)).toEqual([["original-citation"], ["original-citation"]]);
  expect(result.costUsd).toBeCloseTo(300 * 0.042 / 1e6, 10);
});

test("separate sources never share citation IDs and cancellation stops further chunks", async () => {
  const controller = new AbortController(); let calls = 0;
  const classify = createResearchClassifier({ evaluate: async request => {
    calls++; controller.abort(); return reply(request);
  } }, "session");
  await expect(classify({ question: "Assess", fields: [field], passages: [passage("first", "SUPPORT"), passage("second", "CONFLICT", "source-2")] }, controller.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
  const regular = createResearchClassifier({ evaluate: async request => reply(request) }, "session");
  const result = await regular({ question: "Assess", fields: [field], passages: [passage("first", "SUPPORT"), passage("second", "CONFLICT", "source-2")] }, new AbortController().signal);
  expect(result.labels).toEqual([{ sourceId: "source-1", fieldId: "claim", coverage: "supports", passageIds: ["first"] },
    { sourceId: "source-2", fieldId: "claim", coverage: "contradicts", passageIds: ["second"] }]);
});

test("bounded citation list retains both sides even when contradiction arrives after twelve supports", async () => {
  const passages = Array.from({ length: 170 }, (_, i) => passage(`id-${i}`, `${i === 169 ? "CONFLICT" : "SUPPORT"} ${"x".repeat(990)}`));
  const result = await createResearchClassifier({ evaluate: async request => reply(request) }, "session")({ question: "Assess", fields: [field], passages }, new AbortController().signal);
  expect(result.labels[0]!.coverage).toBe("mixed");
  expect(result.labels[0]!.passageIds).toHaveLength(12);
  expect(result.labels[0]!.passageIds).toContain("id-169");
});

test("unresolved support head preserves contradiction citation as unknown coverage", async () => {
  const classify = createResearchClassifier({ evaluate: async request => reply(request, answers => { answers.f0_support = answer("none", false); }) }, "session");
  const result = await classify({ question: "Assess", fields: [field], passages: [passage("conflict", "CONFLICT")] }, new AbortController().signal);
  expect(result.labels[0]).toMatchObject({ coverage: "unknown", passageIds: ["conflict"] });
});

test("independent sources share at most three slots without extra requests or reordered labels", async () => {
  let active = 0, peak = 0, calls = 0;
  let release!: () => void, admitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const three = new Promise<void>(resolve => { admitted = resolve; });
  const classify = createResearchClassifier({ evaluate: async request => {
    calls++; active++; peak = Math.max(peak, active); if (calls === 3) admitted();
    await gate;
    active--; return reply(request);
  } }, "session");
  const passages = Array.from({ length: 7 }, (_, i) => passage(`p-${i}`, `SUPPORT source ${i}`, `source-${i}`));
  const pending = classify({ question: "Assess", fields: [field], passages }, new AbortController().signal);
  await three;
  expect(calls).toBe(3); expect(active).toBe(3);
  release(); const result = await pending;
  expect(peak).toBe(3); expect(calls).toBe(7);
  expect(result.labels.map(label => label.sourceId)).toEqual(passages.map(p => p.sourceId));
  expect(result.labels.map(label => label.passageIds)).toEqual(passages.map(p => [p.id]));
  expect(result.costUsd).toBeCloseTo(0.007);
});

test("cancellation aborts all admitted sources and never schedules remaining sources", async () => {
  const controller = new AbortController(); let calls = 0, cancelled = 0;
  let admitted!: () => void;
  const three = new Promise<void>(resolve => { admitted = resolve; });
  const classify = createResearchClassifier({ evaluate: async request => {
    calls++; if (calls === 3) admitted();
    await new Promise<void>((_resolve, reject) => request.signal!.addEventListener("abort", () => { cancelled++; reject(new Error("cancelled")); }, { once: true }));
    return reply(request);
  } }, "session");
  const passages = Array.from({ length: 8 }, (_, i) => passage(`p-${i}`, "SUPPORT", `source-${i}`));
  const pending = classify({ question: "Assess", fields: [field], passages }, controller.signal);
  const checked = pending.then(() => undefined, error => error as Error);
  await three; controller.abort(); expect((await checked)?.message).toContain("cancelled");
  expect(calls).toBe(3); expect(cancelled).toBe(3);
});

test("first failure aborts siblings but waits for their owned cleanup before rejecting", async () => {
  let releaseCleanup!: () => void, reportCleanup!: () => void, rejectFirst!: (error: Error) => void;
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const cleanupStarted = new Promise<void>(resolve => { reportCleanup = resolve; });
  const original = new Error("first source failed");
  let calls = 0, settled = false, cleaned = false;
  const classify = createResearchClassifier({ evaluate: async request => {
    if (++calls === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    else {
      await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
      reportCleanup(); await cleanup; cleaned = true; throw new Error("sibling cancelled");
    }
    return reply(request);
  } }, "session");
  const pending = classify({ question: "Assess", fields: [field], passages: [passage("a", "SUPPORT", "a"), passage("b", "CONFLICT", "b")] }, new AbortController().signal);
  const outcome = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  rejectFirst(original); await cleanupStarted;
  expect(settled).toBe(false); expect(cleaned).toBe(false);
  releaseCleanup(); expect(await outcome).toBe(original);
  expect(cleaned).toBe(true); expect(calls).toBe(2);
});
