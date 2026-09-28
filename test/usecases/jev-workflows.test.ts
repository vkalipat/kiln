import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevWorkflowBenchmark } from "../../scripts/benchmarks/jev-workflows";
import { runResearchTask, type ResearchTaskInput, type ResearchClassification } from "../../src/operator/research-task";
import { createJevWorkflowService } from "../../src/operator/jev-service";
import { createOperatorMeter } from "../../src/operator/meter";
import { runBrowserWorkflow, type BrowserSnapshot, type BrowserWorkflowPort, type BrowserTaskInput } from "../../src/operator/browser-workflow";

const roots: string[] = [];
function workspace() { const root = mkdtempSync(join(tmpdir(), "kiln-jev-workflow-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const research: ResearchTaskInput = { question: "Does every sample pass, and was sample B measured?",
  requiredFields: [{ id: "all_pass", question: "Did every sample pass?" }, { id: "measured", question: "Was sample B measured?" }],
  sources: ["https://docs.example.com/results"], allowedHosts: ["docs.example.com"] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const browserTask: BrowserTaskInput = { tab: "fixture-results", task: "Display the measured sample results and exact result URL",
  allowedActions: [{ kind: "click", label: "Results" }],
  checks: [{ kind: "url_equals", value: "https://docs.example.com/results" }, { kind: "text_includes", value: "Sample B failed" }] };
function browserFixture(overrides: Partial<BrowserWorkflowPort> = {}) {
  const calls = { observations: 0, decisions: 0, actions: 0, verifies: 0 };
  const snapshot: BrowserSnapshot = { url: "https://docs.example.com/start", title: "Sample results", text: "Open results",
    actions: [{ id: "e1", kind: "click", label: "Results", node: 1 }], marker: "snapshot-1", page_key: "fixture-page", guards: {} };
  const port: BrowserWorkflowPort = {
    observe: async () => { calls.observations++; return structuredClone(snapshot); },
    decide: async payload => { calls.decisions++; return { accepted: true, stateHash: payload.stateHash, operation: "done" }; },
    act: async () => { calls.actions++; return { status: "acted" }; },
    verify: async checks => { calls.verifies++; return checks.map((check, index) => ({ index, kind: check.kind, passed: true })); },
    wait: async () => {}, now: () => performance.now(), ...overrides,
  };
  return { port, calls, snapshot };
}

test("same-state batching preserves contradictory and uncertain fixture answers with observed request counts", async () => {
  const report = await runJevWorkflowBenchmark();
  expect(report.providerMode).toBe("deterministic-injected-transport");
  expect(report.comparisons).toHaveLength(2);
  for (const pair of report.comparisons) {
    expect(pair.sameVerifiedOutcomes).toBe(true);
    expect(pair.baseline.observedRequests).toBe(3);
    expect(pair.candidate.observedRequests).toBe(1);
    expect(pair.candidate.wire.flatMap(call => call.questionIds).sort()).toEqual(["complete", "contradiction", "relevant"]);
  }
  expect(report.comparisons[1]!.candidate.outcomes.contradiction).toEqual({ choice: "no", accepted: false });
  expect(report.frontierRequestsDisplaced).toBeNull();
  expect(report.providerTokens).toBeNull();
  expect(report.providerCostUsd).toBeNull();
  expect(report.providerLatencyMs).toBeNull();
});

test("research keeps the complete captured contradiction and leaves an unassessed requirement unknown", async () => {
  const full = `Sample B failed the required check.\n${"Context evidence. ".repeat(1000)}`;
  const receipt = await runResearchTask(research, { artifactDir: workspace(),
    fetchSource: async () => ({ text: full, truncated: false, costUsd: 0 }),
    classify: async ({ passages }) => ({ labels: [{ sourceId: "source-1", fieldId: "all_pass", coverage: "contradicts", passageIds: [passages[0]!.id] }], costUsd: 0 }),
  });
  expect(receipt.truthVerified).toBe(false);
  expect(receipt.sources[0]!.truncated).toBe(true);
  expect(readFileSync(receipt.sources[0]!.artifact.path, "utf8")).toBe(full);
  expect(receipt.sources[0]!.artifact.sha256).toBe(hash(full));
  expect(receipt.fields.find(field => field.id === "all_pass")!.evidence[0]!.coverage).toBe("contradicts");
  expect(receipt.fields.find(field => field.id === "measured")!.status).toBe("unknown");
  expect(receipt.unknowns.some(reason => reason.includes("measured"))).toBe(true);
});

test("failed research capture cannot become a negative finding or trigger classification", async () => {
  let classifications = 0;
  const receipt = await runResearchTask(research, { artifactDir: workspace(),
    fetchSource: async () => { throw new Error("fixture capture failure"); },
    classify: async () => { classifications++; return { labels: [] }; },
  });
  expect(classifications).toBe(0);
  expect(receipt.sources).toHaveLength(0);
  expect(receipt.status).toBe("partial");
  expect(receipt.fields.every(field => field.status === "unknown")).toBe(true);
  expect(receipt.cost).toMatchObject({ knownUsd: 0, unknownCalls: 1, complete: false });
  expect(receipt.truthVerified).toBe(false);
});

test("cancelling uncooperative research I/O prevents browser fallback and labels", async () => {
  const control = new AbortController();
  let started!: () => void, browserCalls = 0, classifications = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const work = runResearchTask(research, { artifactDir: workspace(), signal: control.signal,
    fetchSource: async () => { started(); return new Promise(() => {}); },
    browser: async () => { browserCalls++; return { text: "must not capture" }; },
    classify: async () => { classifications++; return { labels: [] }; },
  });
  await entered; control.abort();
  const receipt = await work;
  expect(receipt.status).toBe("cancelled");
  expect(browserCalls).toBe(0);
  expect(classifications).toBe(0);
  expect(receipt.fields.every(field => field.status === "unknown")).toBe(true);
  expect(receipt.cost.unknownCalls).toBe(1);
});

test("research refuses invented evidence locations without discarding actual source bytes", async () => {
  const source = "Sample B has not been measured.";
  const receipt = await runResearchTask(research, { artifactDir: workspace(),
    fetchSource: async () => ({ text: source, truncated: false, costUsd: 0 }),
    classify: async () => ({ labels: [{ sourceId: "source-1", fieldId: "all_pass", coverage: "supports", passageIds: ["source-2-p1"] }], costUsd: 0 }),
  });
  expect(receipt.failures.some(failure => failure.stage === "classify")).toBe(true);
  expect(receipt.fields.every(field => field.status === "unknown")).toBe(true);
  expect(readFileSync(receipt.sources[0]!.artifact.path, "utf8")).toBe(source);
  expect(receipt.truthVerified).toBe(false);
});

test("cancelling classification preserves captured evidence but cannot publish a late supporting claim", async () => {
  const control = new AbortController(); let started!: () => void;
  let finish!: (result: { labels: ResearchClassification[] }) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const work = runResearchTask(research, { artifactDir: workspace(), signal: control.signal,
    fetchSource: async () => ({ text: "Sample B was not measured.", costUsd: 0 }),
    classify: async () => { started(); return new Promise(resolve => { finish = resolve; }); },
  });
  await entered; control.abort();
  const receipt = await work;
  finish({ labels: [{ sourceId: "source-1", fieldId: "all_pass", coverage: "supports", passageIds: ["source-1-p1"] }] });
  await Promise.resolve();
  expect(receipt.status).toBe("cancelled");
  expect(receipt.sources).toHaveLength(1);
  expect(receipt.fields.every(field => field.status === "unknown")).toBe(true);
  expect(receipt.cost.unknownCalls).toBe(1);
  expect(readFileSync(receipt.sources[0]!.artifact.path, "utf8")).toBe("Sample B was not measured.");
});

test("a dispatched workflow decision without usage keeps dollar and token exposure across resume", async () => {
  const dir = workspace(), control = new AbortController(); let requests = 0;
  const meter = createOperatorMeter({ run: { id: "unknown-usage", dir }, limitUsd: 0.01, onViolation: error => { throw error; } });
  const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests++;
    const payload = JSON.parse(String(init?.body));
    return Response.json({ model: payload.model, answers: { useful: { type: "choice", choice: "yes", confidence: 0.99, probabilities: { yes: 0.99, no: 0.01 } } } });
  }) as unknown as typeof fetch;
  const options = { enabled: true, apiKey: "offline-fixture-only", maxInputTokens: 100000, fetch: transport, signal: () => control.signal,
    reserve: meter.reserveExternal, onStats: () => {} };
  const request = { operation: "research" as const, sessionId: "fixture-parent", state: "Sample B failed",
    questions: { useful: { instructions: "Does this address the sample?", criteria: { yes: "Addresses sample", no: "Unrelated" } } } };
  const service = createJevWorkflowService(options);
  try {
    expect((await service.evaluate(request)).reason).toBe("accepted");
    expect(meter.usage().rows[0]!.state).toBe("unknown");
    expect(meter.usage().knownCostUsd).toBe(0);
    expect(meter.usage().chargedUsd).toBeGreaterThan(0);
    expect(service.stats().unknownInputTokens).toBe(64000);
    const resumed = createJevWorkflowService({ ...options, initialStats: service.stats() });
    expect((await resumed.evaluate(request)).reason).toBe("token_budget");
    expect(requests).toBe(1);
  } finally { await meter.close(); }
});

test("research detects artifact mutation during classification and never presents the stale support as valid", async () => {
  const artifactDir = workspace();
  const receipt = await runResearchTask(research, { artifactDir,
    fetchSource: async () => ({ text: "Sample B was not measured.", truncated: false, costUsd: 0 }),
    classify: async ({ passages }) => {
      const capture = join(artifactDir, readdirSync(artifactDir)[0]!, "source-1.txt");
      chmodSync(capture, 0o600); writeFileSync(capture, "Replacement bytes: every sample passed.");
      return { labels: [{ sourceId: "source-1", fieldId: "all_pass", coverage: "supports", passageIds: [passages[0]!.id] }], costUsd: 0 };
    },
  });
  expect(receipt.status).toBe("partial");
  expect(receipt.sources[0]!.integrity).toBe("changed");
  expect(receipt.fields.every(field => field.status === "unknown")).toBe(true);
  expect(receipt.truthVerified).toBe(false);
  expect(hash(readFileSync(receipt.sources[0]!.artifact.path, "utf8"))).not.toBe(receipt.sources[0]!.artifact.sha256);
});

test("browser failed capture cannot dispatch a decision or claim success", async () => {
  const fixture = browserFixture({ observe: async () => { throw new Error("fixture capture unavailable"); } });
  expect((await runBrowserWorkflow(browserTask, fixture.port)).status).toBe("incomplete");
  expect(fixture.calls.decisions).toBe(0);
  expect(fixture.calls.actions).toBe(0);
  expect(fixture.calls.verifies).toBe(0);
});

test.each(["failed", "missing", "wrong-binding"] as const)("browser DONE cannot bypass %s independent requirements", async variant => {
  const fixture = browserFixture({ verify: async checks => variant === "missing" ? [] : checks.map((check, index) => ({
    index: variant === "wrong-binding" ? index + 1 : index, kind: check.kind, passed: variant !== "failed" || index === 0,
  })) });
  const result = await runBrowserWorkflow(browserTask, fixture.port);
  expect(result.status).toBe("incomplete");
  expect(result.quality).toBe("specified_checks_only");
  expect(fixture.calls.actions).toBe(0);
});

test("passing supplied browser assertions does not certify untested requirements of the whole task", async () => {
  const fixture = browserFixture();
  const result = await runBrowserWorkflow({ ...browserTask, task: "Find every sample outcome and prove there are no missing measurements" }, fixture.port);
  expect(result.status).toBe("verified");
  expect(result.quality).toBe("specified_checks_only");
  expect(result.taskQualityValidated).toBe(false);
});

test("classifier-selected browser mutation cannot exceed the explicit action allowance", async () => {
  const fixture = browserFixture({ decide: async payload => ({ accepted: true, stateHash: payload.stateHash, operation: "click", target: "e1" }) });
  const result = await runBrowserWorkflow({ ...browserTask, allowedActions: [] }, fixture.port);
  expect(result.status).toBe("unsupported");
  expect(fixture.calls.actions).toBe(0);
});

test("unsupported controls retain native fallback instead of treating the bounded task as done", async () => {
  const fixture = browserFixture(); fixture.snapshot.unsupported = "Shadow-root control requires native fallback";
  const result = await runBrowserWorkflow(browserTask, fixture.port);
  expect(result.status).toBe("unsupported");
  expect(fixture.calls.decisions).toBe(0);
  expect(fixture.calls.actions).toBe(0);
});

test("browser stale target stops before another input or automatic replay", async () => {
  let attempts = 0;
  const fixture = browserFixture({
    decide: async payload => ({ accepted: true, stateHash: payload.stateHash, operation: "click", target: "e1" }),
    act: async () => { attempts++; return { status: "stale" }; },
  });
  const result = await runBrowserWorkflow(browserTask, fixture.port);
  expect(result.status).toBe("stale");
  expect(attempts).toBe(1);
  expect(fixture.calls.observations).toBe(1);
  expect(fixture.calls.verifies).toBe(0);
});

test("browser action with an uncertain acknowledgement is not replayed or called verified", async () => {
  let possibleMutations = 0;
  const fixture = browserFixture({
    decide: async payload => ({ accepted: true, stateHash: payload.stateHash, operation: "click", target: "e1" }),
    act: async () => { possibleMutations++; throw new Error("Acknowledgement lost after input"); },
  });
  const result = await runBrowserWorkflow(browserTask, fixture.port);
  expect(result.status).toBe("ambiguous");
  expect(possibleMutations).toBe(1);
  expect(fixture.calls.observations).toBe(1);
  expect(fixture.calls.verifies).toBe(0);
});

test("browser cancellation during observation promptly returns without any model or action", async () => {
  const control = new AbortController(); let started!: () => void, release!: (snapshot: BrowserSnapshot) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const fixture = browserFixture({ signal: control.signal, observe: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const work = runBrowserWorkflow(browserTask, fixture.port);
  await entered; control.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work, new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 100); })]);
    expect(result?.status).toBe("cancelled");
    expect(fixture.calls.decisions).toBe(0);
    expect(fixture.calls.actions).toBe(0);
  } finally { clearTimeout(timeout); release(fixture.snapshot); await work; }
});
