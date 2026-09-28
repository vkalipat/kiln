/** Provider-free transport comparison. No model latency, quality or frontier displacement claim. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateWithJev, type JevChoiceAnswer, type JevChoiceQuestion, type JevState } from "../../src/integrations/jev";

const questions: Record<string, JevChoiceQuestion> = {
  relevant: { instructions: "Does the evidence address the requested subject?", criteria: { yes: "Addresses the subject", no: "Different subject" } },
  contradiction: { instructions: "Does the evidence explicitly contradict the claim?", criteria: { yes: "Explicit contradiction", no: "No explicit contradiction" } },
  complete: { instructions: "Is enough evidence available to resolve the claim?", criteria: { yes: "Evidence sufficient", no: "Evidence incomplete" } },
};
const fixtures: Array<{ id: string; state: JevState; expected: Record<string, JevChoiceAnswer> }> = [
  { id: "relevant-contradiction", state: { claim: "Every sample passed", evidence: "Sample B failed the specified check." }, expected: {
    relevant: answer("yes"), contradiction: answer("yes"), complete: answer("yes"),
  } },
  { id: "incomplete-uncertain", state: { claim: "Every sample passed", evidence: "Sample A passed. Sample B was not measured." }, expected: {
    relevant: answer("yes"), contradiction: answer("no", 0.55), complete: answer("no"),
  } },
];
function answer(choice: "yes" | "no", confidence = 0.99): JevChoiceAnswer {
  return { choice, confidence, accepted: confidence >= 0.8,
    probabilities: { yes: choice === "yes" ? 0.99 : 0.01, no: choice === "no" ? 0.99 : 0.01 } };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

async function arm(fixture: typeof fixtures[number], mode: "separate-questions" | "same-state-batch") {
  const wire: Array<{ questionIds: string[]; bytes: number }> = [];
  const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = String(init?.body), payload = JSON.parse(raw);
    if (digest(payload.state) !== digest(fixture.state)) throw new Error("Fixture state changed on the wire");
    const ids = Object.keys(payload.questions);
    wire.push({ questionIds: ids, bytes: Buffer.byteLength(raw) });
    return Response.json({ model: payload.model, answers: Object.fromEntries(ids.map(id => {
      if (!fixture.expected[id]) throw new Error("Unknown fixture question");
      const { accepted: _accepted, ...result } = fixture.expected[id];
      return [id, { type: "choice", ...result }];
    })) }); // Intentionally no fabricated provider token/cost counters.
  }) as unknown as typeof fetch;
  const groups = mode === "same-state-batch" ? [questions] : Object.entries(questions).map(([id, question]) => ({ [id]: question }));
  const observed: Record<string, JevChoiceAnswer> = {};
  for (const group of groups) {
    const decision = await evaluateWithJev(fixture.state, group, { enabled: true, apiKey: "offline-fixture-only", fetch: transport });
    if (!decision.answers) throw new Error(`Fixture response rejected: ${decision.reason}`);
    Object.assign(observed, decision.answers);
  }
  const verified = Object.keys(fixture.expected).every(id => digest(observed[id]) === digest(fixture.expected[id]));
  return { mode, verified, observedRequests: wire.length, serializedRequestBytes: wire.reduce((n, call) => n + call.bytes, 0), wire,
    outcomes: Object.fromEntries(Object.entries(observed).map(([id, item]) => [id, { choice: item.choice, accepted: item.accepted }])) };
}

export async function runJevWorkflowBenchmark() {
  const comparisons = [];
  for (const fixture of fixtures) {
    const baseline = await arm(fixture, "separate-questions"), candidate = await arm(fixture, "same-state-batch");
    comparisons.push({ fixture: fixture.id, fixtureSha256: digest(fixture), baseline, candidate,
      observedRequestDifference: baseline.observedRequests - candidate.observedRequests,
      sameVerifiedOutcomes: baseline.verified && candidate.verified && digest(baseline.outcomes) === digest(candidate.outcomes) });
  }
  return { version: 1, providerMode: "deterministic-injected-transport", baseline: "three separate same-state Jev classification requests",
    candidate: "one same-state Jev batch request", comparisons,
    sourceSha256: createHash("sha256").update(readFileSync(resolve(import.meta.dir, "../../src/integrations/jev.ts"))).digest("hex"),
    frontierRequestsDisplaced: null, providerTokens: null, providerCostUsd: null, providerLatencyMs: null,
    limits: ["Fixture answers are supplied, not generated: this does not measure semantic model accuracy.",
      "Baseline is separate Jev requests, not native frontier behavior.",
      "Wire bytes and request counts are observed; they are not billed tokens or a live speedup.",
      "No task is declared complete and no evidence is discarded by this transport comparison."] };
}

if (import.meta.main) {
  const report = await runJevWorkflowBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.comparisons.some(pair => !pair.sameVerifiedOutcomes)) process.exitCode = 1;
}
