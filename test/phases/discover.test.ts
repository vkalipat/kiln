import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { cachedDiscoverySynthesisWallMs, discoverySynthesisReady, parseLandscape, runDiscover, SCOUT_CHECKPOINT_POLICY_VERSION } from "../../src/phases/discover";
import { parseBrief, type PhaseDeps } from "../../src/phases/frame";
import { discoverContract, shapeHash } from "../../src/phases/contracts";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { createRun, readStatus, writeStatus, type RunPaths } from "../../src/core/run";
import { hashInput, RunRecord } from "../../src/core/record";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { initHome } from "../../src/core/home";
import * as phaseDeadlines from "../../src/phases/shared";
import { freezeRouting } from "../../src/workflow/routing";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery";
const BRIEF = `# Brief\n\n## Problem\np\n\n## Constraints\n- c\n\n## Search success\n- s\n\n## Non-goals\n- n\n\n## Shape\nproduct\n\n## Axes\n${AXES}\n\n## Discovery questions\n- Q1?\n- Q2?\n`;
const LANDSCAPE = `# Landscape\n\n## Obvious list\n- an app that counts mites\n\n## Atoms\n- mite (common)\n- acoustic sensing (rare)\n\n## Tensions\n- cheap vs accurate\n\n## Distant domains\n- vineyard pest monitoring\n`;

describe("parseLandscape", () => {
  test("a final landscape write preserves explicit evidence gaps and ends before another call", async () => {
    const base = setup();
    const scout = createMockModel({ handler: async () => ({ content: ["- Observation from https://example.test/source; other coverage unknown."] }) } as never);
    const landscape = LANDSCAPE + "\nEvidence: https://example.test/source. Coverage is partial; uncited suggestions remain unverified.\n";
    const brain = createMockModel({ responses: [
      { content: [{ type: "toolCall", name: "write", arguments: { path: "landscape.md", content: landscape } }] },
      { throw: "unnecessary paid continuation" },
    ] as never });
    expect(await runDiscover(deps(base, brain, scout))).toEqual({ outcome: "ok" });
    expect(brain.calls).toHaveLength(1);
    expect(readFileSync(base.run.landscape, "utf8")).toBe(landscape);
  });
  test("empty headings remain a draft until a valid edit ends synthesis without another call", async () => {
    const base = setup();
    const draft = "## Obvious list\n## Atoms\n## Tensions\n## Distant domains\n";
    const scout = createMockModel({ handler: async () => ({ content: ["- Source observation; coverage remains partial."] }) } as never);
    const brain = createMockModel({ responses: [
      { content: [{ type: "toolCall", name: "write", arguments: { path: "landscape.md", content: draft } }] },
      { content: [{ type: "toolCall", name: "read", arguments: { path: "landscape.md" } }] },
      { content: [{ type: "toolCall", name: "edit", arguments: { path: "landscape.md", old: draft, new: LANDSCAPE } }] },
      { throw: "unnecessary paid continuation" },
    ] as never });
    expect(await runDiscover(deps(base, brain, scout))).toEqual({ outcome: "ok" });
    expect(brain.calls).toHaveLength(3);
    expect(parseLandscape(readFileSync(base.run.landscape, "utf8")).atoms).toHaveLength(2);
    expect(readStatus(base.run).phase).toBe("ideate");
  });
  test("extracts the four lists", () => {
    const l = parseLandscape(LANDSCAPE);
    expect(l.missing).toEqual([]); expect(l.obvious).toEqual(["an app that counts mites"]); expect(l.atoms.length).toBe(2); expect(l.domains).toEqual(["vineyard pest monitoring"]);
  });
});

describe("discovery research expansion", () => {
  test("the discovery contract prefers supplied evidence instead of mandatory rereading", () => {
    const base = setup(); const contract = discoverContract(base.run, ["Q1?"], 20);
    expect(contract).not.toContain("read them first");
    expect(contract).toContain("supplied"); expect(contract).toContain("overflow");
  });

  for (const closeDuring of ["scouts", "synthesis"]) test(`network tools disappear when the soft window closes during ${closeDuring}`, async () => {
    const base = setup(); const contexts: string[][] = [];
    const scout = createMockModel({ id: "observed", handler: async (context: Context) => context.messages.some((message) => message.role === "toolResult")
      ? { delayMs: closeDuring === "scouts" ? 450 : 0, content: ["- Observed source https://example.test/source"] }
      : { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://example.test/source" } }] } } as never);
    const brain = createMockModel({ id: "local-synthesis", handler: async (context: Context) => {
      contexts.push((context.tools ?? []).map((tool) => tool.name));
      if (closeDuring === "synthesis" && contexts.length === 1) return { delayMs: 450, content: [{ type: "toolCall", name: "note", arguments: { text: "Compose from supplied findings" } }] };
      return { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] };
    } } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 1.2;
    d.cfg.budgets.share = { frame: 0, discover: 1, ideate: 0, form: 0, build: 0, reflect: 0 };
    d.searchJitterMs = 0; d.fetchImpl = (async () => new Response("Observed source")) as unknown as typeof fetch;
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    const finalTools = contexts.at(-1)!;
    for (const name of ["web_search", "web_fetch", "scout"]) expect(finalTools).not.toContain(name);
    for (const name of ["read", "write", "edit", "note", "exit"]) expect(finalTools).toContain(name);
  });

  test("a denied late retrieval leaves sanitized durable evidence without request arguments", async () => {
    const base = setup(); let fetches = 0;
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- Finding"] }) } as never);
    const brain = createMockModel({ id: "late-fetch", responses: [
      { content: [{ type: "toolCall", name: "note", arguments: { text: "ready" } }] },
      { content: [
        { type: "toolCall", name: "web_fetch", arguments: { url: "https://example.test/private-query-token" } },
        { type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } },
      ] },
    ] as never });
    const d = deps(base, brain, scout, 2); d.fetchImpl = (async () => { fetches++; return new Response("must not run"); }) as unknown as typeof fetch;
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" }); expect(fetches).toBe(0);
    const denials = base.record.read().filter((event) => event.t === "note" && event.text.startsWith("Discovery research denied:"));
    expect(denials).toHaveLength(1); expect(JSON.stringify(denials)).toContain("web_fetch");
    expect(JSON.stringify(denials)).not.toContain("private-query-token");
  });

  test("resumed synthesis cannot refill the research half or repeat paid successful scouts", async () => {
    const base = setup(BRIEF + "- Q3?\n- Q4?\n");
    base.record.append({ t: "phase.start", phase: "frame" });
    base.record.append({ t: "model.call", role: "brain", provider: "mock", model: "frame", inputHash: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.54, stopReason: "stop", excerpt: "" });
    base.record.append({ t: "phase.end", phase: "frame", outcome: "ok" });
    const scout = createMockModel({ id: "paid-resumable", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async (context: Context) => (context.tools?.length ?? 0) === 0
      ? { content: ["- Observed evidence."], usage: { input: 6_000, output: 2_800 } }
      : { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://example.test/source" } }], usage: { input: 8_000, output: 1_600 } } } as never);
    const firstBrain = createMockModel({ id: "transient-synthesis", handler: async () => ({ throw: "rate limit exceeded" }) } as never);
    const d = deps(base, firstBrain, scout); d.cfg.budgets.usd = 10;
    d.cfg.budgets.share = { frame: 0.05, discover: 0.15, ideate: 0.4, form: 0.075, build: 0.3, reflect: 0.025 };
    d.fetchImpl = (async () => new Response("Observed source")) as unknown as typeof fetch; d.searchJitterMs = 0;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(scout.calls).toHaveLength(6);
    const resumed = createMockModel({ id: "resumed", responses: [
      { content: [0, 1, 2].map((i) => ({ type: "toolCall", name: "scout", arguments: { question: `Extra ${i}?` } })) },
      { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] },
    ] as never });
    d.models = (role) => ({ model: (role === "scout" ? scout : resumed) as unknown as Model, ref: `mock/${role}` });
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(6); expect(base.record.costUsd()).toBeCloseTo(1.06);
  });

  test("a crossing call cannot dispatch another queued scout after the research pool is spent", async () => {
    const base = setup();
    const scout = createMockModel({ id: "crosses-pool", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async () => ({ content: ["- Completed source finding."], usage: { input: 200_000, output: 0 } }) } as never);
    const brain = createMockModel({ id: "synthesis", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }] as never });
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 10; d.limiter = new Limiter(1);
    d.cfg.budgets.share = { frame: 0.05, discover: 0.15, ideate: 0.4, form: 0.075, build: 0.3, reflect: 0.025 };
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(1); expect(base.record.costUsd()).toBeCloseTo(1);
    expect(checkpointMetadata(join(base.run.discoveryDir, "2-q2.md"))).toMatchObject({ state: "failure", failure: { class: "budget" } });
    expect(d.limiter.pending).toBe(0); expect(d.limiter.active).toBe(0);
  });

  test("a configured fallback is not launched with an unfinishable leftover allowance", async () => {
    const base = setup();
    const primary = createMockModel({ id: "primary-priced", provider: "openai", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async () => ({ stopReason: "error", errorMessage: "rate limit exceeded", usage: { input: 120_000, output: 0 } }) } as never);
    const fallback = createMockModel({ id: "fallback-priced", provider: "anthropic", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async () => ({ content: ["must not run"] }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const d = deps(base, brain, primary); d.cfg.budgets.usd = 10;
    d.cfg.budgets.share = { frame: 0.05, discover: 0.15, ideate: 0.4, form: 0.075, build: 0.3, reflect: 0.025 };
    d.cfg.roles.scout = ["openai/primary-priced", "anthropic/fallback-priced"];
    d.availableProviders = new Set(["openai", "anthropic"]);
    d.modelsOn = () => ({ model: fallback as unknown as Model, ref: "anthropic/fallback-priced" });
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(fallback.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
  });

  for (const [target, funded] of [[10, 2], [25, 4]]) test(`a $${target} run funds ${funded} complete scouts before landscape synthesis`, async () => {
    const brief = BRIEF + "- Q3?\n- Q4?\n";
    const base = setup(brief);
    base.record.append({ t: "phase.start", phase: "frame" });
    base.record.append({ t: "model.call", role: "brain", provider: "mock", model: "frame", inputHash: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.54, stopReason: "stop", excerpt: "" });
    base.record.append({ t: "phase.end", phase: "frame", outcome: "ok" });
    const scout = createMockModel({ id: "priced-scout", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async (context: Context) => (context.tools?.length ?? 0) === 0
      ? { content: ["- Observed finding https://example.test/source; additional coverage unknown."], usage: { input: 6_000, output: 2_800 } }
      : { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://example.test/source" } }], usage: { input: 8_000, output: 1_600 } } } as never);
    const brain = createMockModel({ id: "synthesis", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }] as never });
    const d = deps(base, brain, scout); d.cfg.budgets.usd = target;
    d.cfg.budgets.share = { frame: 0.05, discover: 0.15, ideate: 0.4, form: 0.075, build: 0.3, reflect: 0.025 };
    d.fetchImpl = (async () => new Response("Observed source evidence")) as unknown as typeof fetch; d.searchJitterMs = 0;
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    const checkpoints = readdirSync(base.run.discoveryDir).map((file) => checkpointMetadata(join(base.run.discoveryDir, file)));
    expect(checkpoints.filter((checkpoint) => checkpoint.state === "ok")).toHaveLength(funded);
    expect(checkpoints.filter((checkpoint) => checkpoint.state === "failure")).toHaveLength(4 - funded);
    for (const checkpoint of checkpoints.filter((item) => item.state === "failure")) expect(checkpoint).toMatchObject({ failure: { class: "budget" }, budgetTargetUsd: target });
    expect(brain.calls).toHaveLength(1);
    expect(base.record.costUsd() - 0.54).toBeLessThanOrEqual((target * 0.2 - 0.54) / 2);
  });

  test("an allocation below one complete priced scout dispatches no models", async () => {
    const base = setup();
    const scout = createMockModel({ id: "unfunded", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, handler: async () => ({ content: ["must not run"] }) } as never);
    const brain = createMockModel({ id: "unfunded-brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 0.1;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "budget" });
    expect(scout.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
    expect(readdirSync(base.run.discoveryDir)).toHaveLength(2);
  });

  test("oversized cached findings remain bounded with explicit provenance and overflow paths", async () => {
    const base = setup(); let synthesisInput = "";
    for (const [index, question] of ["Q1?", "Q2?"].entries()) {
      const checkpoint = Buffer.from(JSON.stringify({ fingerprint: hashInput({ brief: BRIEF, question }), state: "ok" }), "utf8").toString("base64url");
      writeFileSync(join(base.run.discoveryDir, `${index + 1}-q${index + 1}.md`), `<!-- kiln-scout-v1:${checkpoint} -->\n# Question\n${question}\n\n# Findings\n- [Source](https://example.test/${index}) ${"x".repeat(20_000)} hidden-tail-${index}\n`);
    }
    const scout = createMockModel({ id: "must-not-repeat", handler: async () => ({ content: ["must not run"] }) } as never);
    const brain = createMockModel({ id: "bounded-handoff", handler: async (context: Context) => {
      synthesisInput = JSON.stringify(context.messages);
      return { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] };
    } } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(0); expect(brain.calls).toHaveLength(1);
    expect(synthesisInput.length).toBeLessThan(20_000);
    expect(synthesisInput).toContain("Overflow:"); expect(synthesisInput).toContain("1-q1.md"); expect(synthesisInput).toContain("2-q2.md");
    expect(synthesisInput).toContain("https://example.test/0"); expect(synthesisInput).not.toContain("hidden-tail-");
  });

  test("synthesis receives current checkpoint evidence and failures without filesystem model turns", async () => {
    const base = setup(); let calls = 0; let synthesisInput = "";
    writeFileSync(join(base.run.discoveryDir, "untrusted.md"), "stale unverified claim must not be inlined");
    const staleQuestion = "A follow-up from the previous brief";
    const staleFingerprint = hashInput({ brief: "previous brief", question: staleQuestion });
    const staleMetadata = Buffer.from(JSON.stringify({ fingerprint: staleFingerprint, state: "ok" }), "utf8").toString("base64url");
    writeFileSync(join(base.run.discoveryDir, `followup-${staleFingerprint}.md`), `<!-- kiln-scout-v1:${staleMetadata} -->\n# Question\n${staleQuestion}\n\n# Findings\nstale fingerprint claim\n`);
    const scout = createMockModel({ id: "handoff-scout", handler: async () => calls++ === 0
      ? { content: ["- Supported observation [source](https://example.test/source)."] }
      : { stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" } } } as never);
    const brain = createMockModel({ id: "handoff-brain", handler: async (context: Context) => {
      synthesisInput = JSON.stringify(context.messages);
      return { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] };
    } } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "ok" });
    expect(brain.calls).toHaveLength(1);
    expect(synthesisInput).toContain("Supported observation [source](https://example.test/source)");
    expect(synthesisInput).toContain("1-q1.md"); expect(synthesisInput).toContain("2-q2.md");
    expect(synthesisInput).toContain("refusal"); expect(synthesisInput).toContain("safety");
    expect(synthesisInput).not.toContain("stale unverified claim");
    expect(synthesisInput).not.toContain("stale fingerprint claim");
  });

  test("a soft retrieval cutoff with no observed source cannot manufacture discovery evidence", async () => {
    const base = setup(); let fetches = 0;
    // Control only the deadline signal boundary. CI load must not turn the
    // soft-retrieval evidence test into the separately tested hard-deadline path.
    const deadlines: { ms: number; controller: AbortController }[] = [];
    const deadlineSpy = spyOn(phaseDeadlines, "createDisposableDeadline").mockImplementation(ms => {
      const controller = new AbortController(); deadlines.push({ ms, controller });
      return { signal: controller.signal, dispose() {} };
    });
    let softClosed = false;
    try {
      const scout = createMockModel({ id: "late-retrieval", handler: async (context: Context) => {
        if ((context.tools?.length ?? 0) === 0) return { content: ["- unsupported invented observation"] };
        if (!softClosed) {
          const ordered = [...deadlines].sort((a, b) => a.ms - b.ms);
          expect(ordered).toHaveLength(3);
          expect(ordered[0]!.ms).toBeLessThan(ordered[1]!.ms);
          ordered[0]!.controller.abort(new DOMException("Synthetic retrieval cutoff", "TimeoutError"));
          expect(ordered.slice(1).every(deadline => !deadline.controller.signal.aborted)).toBe(true);
          softClosed = true;
        }
        return { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://example.test/source" } }] };
      } } as never);
      const brain = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["must not run"] }) } as never);
      const d = deps(base, brain, scout);
      d.fetchImpl = (async () => { fetches++; return new Response("Source content"); }) as unknown as typeof fetch;
      expect(await runDiscover(d)).toMatchObject({ outcome: "failed", failureClass: "verify" });
      expect(softClosed).toBe(true);
      expect(fetches).toBe(0); expect(brain.calls).toHaveLength(0);
      expect(existsSync(base.run.landscape)).toBe(false);
      for (const file of readdirSync(base.run.discoveryDir)) expect(readFileSync(join(base.run.discoveryDir, file), "utf8")).not.toContain("unsupported invented observation");
    } finally { deadlineSpy.mockRestore(); }
  });

  test("configured scout turn cap triggers the tool-free findings window in discovery", async () => {
    const base = setup();
    const scout = createMockModel({ id: "configured-cap", handler: async (context: Context) => (context.tools?.length ?? 0) === 0
      ? { content: ["- Supported finding; remaining coverage is unknown."] }
      : { content: [{ type: "toolCall", name: "read", arguments: { path: base.run.brief } }] } } as never);
    const brain = createMockModel({ id: "brain", responses: [
      { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] },
    ] as never });
    const d = deps(base, brain, scout, 1); d.cfg.ideation.scoutTurnCap = 6;
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    // Four researching turns then one tool-free summary, independently for each question.
    expect(scout.calls).toHaveLength(10);
    expect(readdirSync(base.run.discoveryDir)).toHaveLength(2);
  });

  test("a completed scout survives its sibling's research deadline and feeds landscape synthesis", async () => {
    const base = setup(); let secondQuestionCalls = 0;
    const cost = { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 };
    const scout = createMockModel({ id: "mixed-deadline", cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 }, handler: async (context: Context) => {
      if (JSON.stringify(context.messages).includes("Question: Q1?")) return { content: ["- Observed source evidence from https://example.test/source"], usage: { input: 1_000_000, cost } };
      if (secondQuestionCalls++ === 0) return { content: [{ type: "toolCall", name: "read", arguments: { path: base.run.brief } }], usage: { input: 1_000_000, cost } };
      return { delayMs: 5_000, content: ["must never become findings"] };
    } } as never);
    const brain = createMockModel({ id: "synthesis", handler: async () => {
      expect(readFileSync(join(base.run.discoveryDir, "1-q1.md"), "utf8")).toContain("Observed source evidence");
      expect(checkpointMetadata(join(base.run.discoveryDir, "2-q2.md"))).toMatchObject({ state: "failure", failure: { class: "deadline" } });
      return { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE + "\nEvidence gap: the second question reached its research deadline.\n" } }] };
    } } as never);
    const d = deps(base, brain, scout, 1); d.cfg.budgets.wallSeconds = 1.2;
    d.cfg.budgets.share = { frame: 0, discover: 1, ideate: 0, form: 0, build: 0, reflect: 0 };
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(brain.calls).toHaveLength(1);
    expect(d.limiter.active).toBe(0); expect(d.limiter.pending).toBe(0);
    const canonicalCost = base.record.read().reduce((sum, event) => sum + (event.t === "model.call" ? event.costUsd : 0), 0);
    expect(canonicalCost).toBeGreaterThanOrEqual(0.02);
    expect(readStatus(base.run).usdSpent).toBeCloseTo(canonicalCost);
    expect(readFileSync(join(base.run.discoveryDir, "2-q2.md"), "utf8")).not.toContain("must never become findings");
  });

  test("previous discovery wall consumption preserves the downstream allocation on resume", async () => {
    const base = setup();
    writeFileSync(base.run.record, [
      { seq: 1, ts: "2026-01-01T00:00:00.000Z", t: "phase.start", phase: "discover" },
      { seq: 2, ts: "2026-01-01T00:01:00.000Z", t: "phase.end", phase: "discover", outcome: "stopped" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    base.record = new RunRecord(base.run.record);
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["must not run"] }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 1_500;
    // Explicit 4% cumulative phase share has already consumed its 60 seconds; 1440 remain
    // for later phases, and an ordinary resume must not spend them on discovery.
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline" });
    expect(scout.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
  });

  test("discovery preserves downstream dollars and cannot replenish its phase allocation on resume", async () => {
    const base = setup();
    const scout = createMockModel({ id: "paid", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, handler: async () => ({ content: ["- evidence"], usage: { input: 1_000_000, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const d = deps(base, brain, scout);
    d.cfg.budgets.usd = 25;
    d.cfg.budgets.share = { frame: 0, discover: 0.04, ideate: 0.46, form: 0, build: 0.5, reflect: 0 };
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "budget" });
    expect(base.record.costUsd()).toBe(2); // Crossing calls finish; later phases retain $23.
    expect(brain.calls).toHaveLength(0);
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "budget" });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
  });

  test("direct blocked retrieval batches cannot replenish their allowance on resume", async () => {
    const base = setup(); let fetches = 0;
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- evidence"] }) } as never);
    const batch = { content: Array.from({ length: 8 }, (_, i) => ({ type: "toolCall", name: "web_fetch", arguments: { url: `https://example.test/${i}` } })) };
    const first = createMockModel({ id: "first", responses: [batch, { throw: "rate limit exceeded" }] as never });
    const d = deps(base, first, scout); d.cfg.ideation.scoutTurnCap = 2;
    d.fetchImpl = (async () => { fetches++; return new Response("blocked", { status: 403 }); }) as unknown as typeof fetch;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(fetches).toBe(4);
    const resumed = createMockModel({ id: "resumed", responses: [batch,
      { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }, { content: ["done"] },
    ] as never });
    d.models = (role) => ({ model: (role === "scout" ? scout : resumed) as unknown as Model, ref: `mock/${role}` });
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(fetches).toBe(4);
  });

  test("the final synthesis turn can write but cannot dispatch additional research", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- evidence"] }) } as never);
    const brain = createMockModel({ id: "brain", responses: [
      { content: [{ type: "toolCall", name: "note", arguments: { text: "ready" } }] },
      { content: [
        { type: "toolCall", name: "scout", arguments: { question: "More?" } },
        { type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } },
      ] },
    ] as never });
    expect(await runDiscover(deps(base, brain, scout, 2))).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(2);
  });

  test("one follow-up wave remains bounded across a transient synthesis resume", async () => {
    const base = setup();
    const scout = createMockModel({ id: "bounded-scout", handler: async () => ({ content: ["- evidence"] }) } as never);
    const requests = Array.from({ length: 8 }, (_, i) => ({ type: "toolCall", name: "scout", arguments: { question: `Follow-up ${i}?` } }));
    const first = createMockModel({ id: "first", responses: [{ content: requests }, { throw: "rate limit exceeded" }] as never });
    expect(await runDiscover(deps(base, first, scout))).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(scout.calls).toHaveLength(4); // Two initial questions, then one refinement per question.
    const resumed = createMockModel({ id: "resumed", responses: [
      { content: requests },
      { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] },
      { content: ["done"] },
    ] as never });
    expect(await runDiscover(deps(base, resumed, scout))).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(4);
  });
});

function setup(brief = BRIEF) {
  const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
  const run = createRun(home, "seed"); writeFileSync(run.brief, brief);
  writeStatus(run, { phase: "discover", shape: parseBrief(brief).shape, shapeHash: shapeHash(parseBrief(brief)) });
  const record = new RunRecord(run.record);
  return { home, run, record };
}

/** Builds `PhaseDeps` with one model per role, the way the CLI's resolver does. */
function deps(base: { home: string; run: RunPaths; record: RunRecord }, brainModel: unknown, scoutModel: unknown, turnCap = 20): PhaseDeps {
  const cfg = defaultConfig();
  cfg.budgets.turns.discover = turnCap;
  return {
    ...base,
    cfg,
    models: (role) => ({ model: (role === "scout" ? scoutModel : brainModel) as Model, ref: `mock/${role}` }),
    apiKeyFor: async () => "k",
    streamFn: streamMock as never,
    effort: "medium",
    limiter: new Limiter(2),
  };
}

function seedFailureCheckpoints(base: ReturnType<typeof setup>, failureClass: "budget" | "deadline", metadata: Record<string, unknown> = {}) {
  const brief = readFileSync(base.run.brief, "utf8");
  for (const [index, question] of ["Q1?", "Q2?"].entries()) {
    const checkpoint = {
      fingerprint: hashInput({ brief, question }), state: "failure", ...metadata,
      failure: { class: failureClass, message: `${failureClass} fixture` },
    };
    const encoded = Buffer.from(JSON.stringify(checkpoint), "utf8").toString("base64url");
    writeFileSync(join(base.run.discoveryDir, `${index + 1}-q${index + 1}.md`), `<!-- kiln-scout-v1:${encoded} -->\n# Question\n${question}\n\n# Findings\n(scout failed: ${failureClass}: fixture)\n`);
  }
}

function seedSuccessCheckpoints(base: ReturnType<typeof setup>) {
  const brief = readFileSync(base.run.brief, "utf8");
  for (const [index, question] of parseBrief(brief).questions.slice(0, 4).entries()) {
    const checkpoint = { fingerprint: hashInput({ brief, question }), state: "ok", policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION };
    const encoded = Buffer.from(JSON.stringify(checkpoint), "utf8").toString("base64url");
    writeFileSync(join(base.run.discoveryDir, `${index + 1}-q${index + 1}.md`), `<!-- kiln-scout-v1:${encoded} -->\n# Question\n${question}\n\n# Findings\n- cached finding ${index + 1}\n`);
  }
}

function freezeCheckpointExecution(base: ReturnType<typeof setup>, cfg: ReturnType<typeof defaultConfig>) {
  freezeRouting(base.run, cfg, { workflow: { phases: ["frame", "discover", "ideate", "checkpoint"] } });
}

function checkpointMetadata(path: string): Record<string, unknown> {
  const line = readFileSync(path, "utf8").split("\n", 1)[0]!;
  return JSON.parse(Buffer.from(line.slice("<!-- kiln-scout-v1:".length, -4), "base64url").toString("utf8"));
}

describe("runDiscover", () => {
  test("same-target resume synthesizes complete cached checkpoints without any research side effect", async () => {
    const base = setup(); seedSuccessCheckpoints(base);
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    writeFileSync(base.run.record, [
      { seq: 1, ts: iso(-300_017), t: "phase.start", phase: "frame" },
      { seq: 2, ts: iso(-214_176), t: "phase.end", phase: "frame", outcome: "ok" },
      { seq: 3, ts: iso(-214_176), t: "phase.start", phase: "discover" },
      { seq: 4, ts: iso(0), t: "phase.end", phase: "discover", outcome: "stopped" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    base.record = new RunRecord(base.run.record);
    writeStatus(base.run, { phase: "discover", state: "stopped", outcome: { kind: "stopped", stopKind: "deadline", wallTargetSeconds: 1500 } });
    const scout = createMockModel({ id: "no-replayed-scout", handler: async () => ({ content: ["must not run"] }) } as never);
    let tools: string[] = [];
    const brain = createMockModel({ id: "cached-synthesis", handler: async (context: Context) => {
      tools = (context.tools ?? []).map((tool) => tool.name);
      return { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] };
    } } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 25; d.cfg.budgets.wallSeconds = 1500;
    d.cfg.budgets.share = { frame: 0.05, discover: 0.15, ideate: 0.4, form: 0.075, build: 0.3, reflect: 0.025 };
    d.executionPhases = ["frame", "discover", "ideate"];
    freezeCheckpointExecution(base, d.cfg);
    expect(discoverySynthesisReady(base.run)).toBe(true);
    expect(cachedDiscoverySynthesisWallMs(base.run, d.cfg, base.record, now, d.executionPhases)).toBeCloseTo(599_983, -1);
    expect(await runDiscover(d)).toEqual({ outcome: "ok" });
    expect(scout.calls).toHaveLength(0);
    for (const name of ["web_search", "web_fetch", "scout"]) expect(tools).not.toContain(name);
    expect(readStatus(base.run)).toMatchObject({ phase: "ideate", state: "running" });
  });

  test("fresh scouts keep their original window and then unlock synthesis-only headroom", async () => {
    const base = setup();
    const scout = createMockModel({ id: "bounded-scout", handler: async () => ({ delayMs: 40, content: ["- completed current finding"] }) } as never);
    let synthesisTools: string[] = [];
    const brain = createMockModel({ id: "extended-synthesis", handler: async (context: Context) => {
      synthesisTools = (context.tools ?? []).map((tool) => tool.name);
      return { delayMs: 180, content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] };
    } } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 25; d.cfg.budgets.wallSeconds = 1;
    d.cfg.budgets.share = { frame: 0, discover: 0.2, ideate: 0.2, form: 0.1, build: 0.4, reflect: 0.1 };
    d.executionPhases = ["frame", "discover", "ideate"];
    freezeCheckpointExecution(base, d.cfg);
    const started = Date.now();
    expect(await runDiscover(d)).toEqual({ outcome: "ok" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(1);
    for (const name of ["web_search", "web_fetch", "scout"]) expect(synthesisTools).not.toContain(name);
  });

  test("fresh synthesis-only headroom expires as a resumable deadline stop", async () => {
    const base = setup();
    const scout = createMockModel({ id: "quick-scout", handler: async () => ({ delayMs: 10, content: ["- completed current finding"] }) } as never);
    const brain = createMockModel({ id: "too-slow-synthesis", handler: async () => ({ delayMs: 1_000, content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 25; d.cfg.budgets.wallSeconds = 1;
    d.cfg.budgets.share = { frame: 0, discover: 0.2, ideate: 0.2, form: 0.1, build: 0.4, reflect: 0.1 };
    d.executionPhases = ["frame", "discover", "ideate"];
    freezeCheckpointExecution(base, d.cfg);
    expect(await runDiscover(d)).toEqual({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 1 });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(1);
    expect(readStatus(base.run)).toMatchObject({ phase: "discover", state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 1 } });
  });

  test("successful direct source fetches remain usable when the search engine is blocked", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async (ctx: any) => {
      const results = (ctx.messages ?? []).filter((message: any) => message.role === "toolResult");
      if (results.length === 0) return { content: [{ type: "toolCall", name: "web_search", arguments: { query: "source" } }] };
      if (results.length === 1) return { content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://source.example/info" } }] };
      return { content: ["- Documented fact (https://source.example/info). Broader search was unavailable."] };
    } } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: existsSync(base.run.landscape) ? ["done"] : [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const d = deps(base, brain, scout);
    d.fetchImpl = (async (input: any) => String(input).includes("source.example")
      ? new Response("<p>Documented source fact.</p>") : new Response("Blocked", { status: 403 })) as typeof fetch;
    expect((await runDiscover(d)).outcome).toBe("ok");
    expect(readStatus(base.run).phase).toBe("ideate");
  });
  test("all-scout DNS errors stop resumably without invoking the synthesis brain or auto-retrying", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async () => ({ throw: "getaddrinfo ENOTFOUND chatgpt.com" }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(readStatus(base.run)).toMatchObject({ phase: "discover", state: "stopped", outcome: { stopKind: "transient", message: expect.stringContaining("ENOTFOUND") } });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
  });
  test("structured scout 503 status is transient even when its message is generic", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async () => ({ throw: "upstream unavailable", responseStatus: 503, responseHeaders: {} }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(brain.calls).toHaveLength(0);
  });
  test("a transient scout retries once on an approved different-provider fallback", async () => {
    const base = setup();
    const primary = createMockModel({ id: "primary", provider: "openai-codex", handler: async () => ({ throw: "upstream unavailable", responseStatus: 503, responseHeaders: {} }) } as never);
    const fallback = createMockModel({ id: "fallback", provider: "anthropic", handler: async () => ({ content: ["- corroborated finding"] }) } as never);
    const brain = createMockModel({ id: "brain", provider: "openai-codex", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const d = deps(base, brain, primary);
    d.cfg.roles.scout = ["openai-codex/primary", "anthropic/fallback"];
    d.availableProviders = new Set(["openai-codex", "anthropic"]);
    d.models = (role) => role === "scout" ? { model: primary, ref: "openai-codex/primary" } : { model: brain, ref: "openai-codex/brain" };
    d.modelsOn = (_role, provider) => {
      if (provider === "anthropic") return { model: fallback, ref: "anthropic/fallback" };
      throw new Error("unavailable");
    };
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(primary.calls).toHaveLength(2); expect(fallback.calls).toHaveLength(2);
    expect(base.record.read().filter((event) => event.t === "note" && event.text.includes("different-provider fallback once"))).toHaveLength(2);
  });
  test("OpenAI API and Codex aliases are not treated as independent fallback vendors", async () => {
    const base = setup();
    const primary = createMockModel({ id: "primary", provider: "openai", handler: async () => ({ throw: "rate limit exceeded" }) } as never);
    const sameVendor = createMockModel({ id: "same-vendor", provider: "openai-codex", handler: async () => ({ content: ["must not run"] }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const d = deps(base, brain, primary);
    d.cfg.roles.scout = ["openai/primary", "openai-codex/same-vendor"];
    d.availableProviders = new Set(["openai", "openai-codex"]);
    d.models = (role) => role === "scout" ? { model: primary, ref: "openai/primary" } : { model: brain, ref: "mock/brain" };
    d.modelsOn = () => ({ model: sameVendor, ref: "openai-codex/same-vendor" });
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(primary.calls).toHaveLength(2); expect(sameVendor.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
  });
  test("a mixed DNS/refusal batch is not treated as a resumable network-only stop", async () => {
    const base = setup(); let calls = 0;
    const scout = createMockModel({ id: "scout", handler: async () => calls++ === 0
      ? { throw: "getaddrinfo ENOTFOUND chatgpt.com" }
      : { stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" } } } as never);
    const brain = createMockModel({ id: "brain", responses: [] } as never);
    expect((await runDiscover(deps(base, brain, scout))).outcome).toBe("failed");
    expect(readStatus(base.run).state).toBe("failed"); expect(brain.calls).toHaveLength(0);
  });
  test("runs one scout per question, then the brain writes the landscape", async () => {
    const base = setup();
    const { run, record } = base;
    const scoutModel = createMockModel({ id: "scout", responses: [{ content: ["- finding for Q1 (https://a)"] }, { content: ["- finding for Q2 (https://b)"] }] as never });
    const brainModel = createMockModel({ id: "brain", handler: async () => ({ content: existsSync(run.landscape) ? ["done"] : [{ type: "toolCall", name: "write", arguments: { path: run.landscape, content: LANDSCAPE } }] }) } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r.outcome).toBe("ok");
    const files = readdirSync(run.discoveryDir).sort();
    expect(files.length).toBe(2); expect(readFileSync(join(run.discoveryDir, files[0]!), "utf8")).toMatch(/# Question\nQ1\?\n\n# Findings\n- finding for Q1/);
    expect(readFileSync(run.landscape, "utf8")).toBe(LANDSCAPE); expect(readStatus(run).phase).toBe("ideate");
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "scout").length).toBe(2);
  });

  test("refuses when the brief's shape no longer matches the one frozen at frame exit", async () => {
    const base = setup();
    writeFileSync(base.run.brief, BRIEF.replace("## Shape\nproduct", "## Shape\nresearch"));
    const brainModel = createMockModel({ id: "brain", handler: async () => ({ content: ["should never be called"] }) } as never);
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("integrity"); expect(r.message).toMatch(/shape/); expect(r.message).toMatch(/new run/); }
    expect(brainModel.calls.length).toBe(0);
    expect(scoutModel.calls.length).toBe(0);
    expect(readStatus(base.run).state).toBe("failed");
    expect(base.record.read().some((e) => e.t === "phase.start")).toBe(false);
  });

  test("a run frozen before shapes existed is not refused", async () => {
    const base = setup();
    writeStatus(base.run, { shape: undefined, shapeHash: undefined });
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brainModel = createMockModel({ id: "brain", handler: async () => (existsSync(base.run.landscape) ? { content: ["done"] } : { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    expect((await runDiscover(deps(base, brainModel, scoutModel))).outcome).toBe("ok");
  });

  test("the brain can spawn an extra scout through the scout tool", async () => {
    const base = setup();
    const { run, record } = base;
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding for a scouted question"] }) } as never);
    let asked = false;
    const brainModel = createMockModel({ id: "brain", handler: async () => {
      if (!asked) { asked = true; return { content: [{ type: "toolCall", name: "scout", arguments: { question: "who else sells this?" } }] }; }
      if (!existsSync(run.landscape)) return { content: [{ type: "toolCall", name: "write", arguments: { path: run.landscape, content: LANDSCAPE } }] };
      return { content: ["done"] };
    } } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r.outcome).toBe("ok");
    // Two questions from the brief plus the one the brain asked for.
    expect(record.read().filter((e) => e.t === "model.call" && e.role === "scout").length).toBe(3);
    const toolCall = record.read().find((e) => e.t === "tool.call" && e.name === "scout");
    expect(toolCall && toolCall.t === "tool.call" ? toolCall.excerpt : "").toContain("- finding for a scouted question");
  });

  test("a scout the brain spawns reports its failure back as text", async () => {
    const base = setup();
    const { run, record } = base;
    let n = 0;
    // The two brief questions succeed; the one the brain asks for fails.
    const scoutModel = createMockModel({ id: "scout", handler: async () => (n++ < 2 ? { content: ["- ok"] } : { throw: "scout exploded" }) } as never);
    let asked = false;
    const brainModel = createMockModel({ id: "brain", handler: async () => {
      if (!asked) { asked = true; return { content: [{ type: "toolCall", name: "scout", arguments: { question: "who else?" } }] }; }
      if (!existsSync(run.landscape)) return { content: [{ type: "toolCall", name: "write", arguments: { path: run.landscape, content: LANDSCAPE } }] };
      return { content: ["done"] };
    } } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r.outcome).toBe("ok");
    const toolCall = record.read().find((e) => e.t === "tool.call" && e.name === "scout");
    expect(toolCall && toolCall.t === "tool.call" ? toolCall.excerpt : "").toContain("scout failed:");
    expect(record.read().filter((e) => e.t === "failure").length).toBe(1);
  });

  test("scout failures are recorded, written into the findings file, and fail the phase when all fail", async () => {
    const base = setup();
    const { run, record } = base;
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({ throw: "boom" }) } as never);
    const brainModel = createMockModel({ id: "brain", handler: async () => ({ content: ["should never be called"] }) } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.message).toMatch(/scout/);
    const failures = record.read().filter((e) => e.t === "failure");
    expect(failures.length).toBe(2); // one per question
    expect(brainModel.calls.length).toBe(0);
    expect(record.read().some((e) => e.t === "model.call" && e.role === "brain")).toBe(false);
    const files = readdirSync(run.discoveryDir).sort();
    expect(files.length).toBe(2);
    expect(readFileSync(join(run.discoveryDir, files[0]!), "utf8")).toMatch(/# Findings\n\(scout failed: \w+: .*boom/);
    expect(readStatus(run).state).toBe("failed");
  });

  test("scout refusals retain their category in the record and findings note", async () => {
    const base = setup();
    const { run, record } = base;
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({
      stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" },
    }) } as never);
    const brainModel = createMockModel({ id: "brain", handler: async () => ({ content: ["should never be called"] }) } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r).toMatchObject({ outcome: "failed", failureClass: "refusal" });
    expect(brainModel.calls).toHaveLength(0);
    expect(record.read().filter((event) => event.t === "failure")).toHaveLength(2);
    for (const event of record.read().filter((value) => value.t === "failure")) {
      expect(event).toMatchObject({ class: "refusal", category: "safety" });
    }
    const findings = readdirSync(run.discoveryDir).map((file) => readFileSync(join(run.discoveryDir, file), "utf8"));
    expect(findings).toHaveLength(2);
    for (const body of findings) expect(body).toContain("# Findings\n(scout refused: safety)\n");

    const cachedScout = createMockModel({ id: "cached", handler: async () => ({ content: ["must not run"] }) } as never);
    const cachedBrain = createMockModel({ id: "cached-brain", handler: async () => ({ content: ["must not run"] }) } as never);
    expect(await runDiscover(deps(base, cachedBrain, cachedScout))).toMatchObject({ outcome: "failed", failureClass: "refusal" });
    expect(cachedScout.calls).toHaveLength(0); expect(cachedBrain.calls).toHaveLength(0);
  });

  test("all bounded scout dollar caps stop resumably and only retry after the dollar target grows", async () => {
    const base = setup(); const charged = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const cappedScout = createMockModel({ id: "capped", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, handler: async () => ({
      content: [{ type: "toolCall", name: "read", arguments: { path: base.run.brief } }], usage: { input: 1_000_000, cost: charged },
    }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const first = deps(base, brain, cappedScout); first.cfg.budgets.usd = 3;
    expect(await runDiscover(first)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 3 });
    expect(cappedScout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
    expect(checkpointMetadata(join(base.run.discoveryDir, "1-q1.md"))).toMatchObject({
      policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION, budgetTargetUsd: 3, failure: { class: "budget" },
    });

    const sameScout = createMockModel({ id: "same", handler: async () => ({ content: ["must not run"] }) } as never);
    const sameBrain = createMockModel({ id: "same-brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const same = deps(base, sameBrain, sameScout); same.cfg.budgets.usd = 3;
    expect(await runDiscover(same)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 3 });
    expect(sameScout.calls).toHaveLength(0); expect(sameBrain.calls).toHaveLength(0);

    const retryScout = createMockModel({ id: "retry", handler: async () => ({ content: ["- recovered"] }) } as never);
    const retryBrain = createMockModel({ id: "retry-brain", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    // The configured cumulative phase share is 4%; the increased target must actually cover
    // the $2 already spent within its research half before dispatching recovery models.
    const increased = deps(base, retryBrain, retryScout, 1); increased.cfg.budgets.usd = 125;
    expect(await runDiscover(increased)).toMatchObject({ outcome: "ok" });
    expect(retryScout.calls).toHaveLength(2); expect(retryBrain.calls).toHaveLength(1);
  });

  test("all scout deadlines stop resumably and cached questions require a larger wall target", async () => {
    const base = setup();
    const timedOut = createMockModel({ id: "timed-out", handler: async () => ({ throw: "request timed out" }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const first = deps(base, brain, timedOut);
    expect(await runDiscover(first)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: first.cfg.budgets.wallSeconds });
    const target = first.cfg.budgets.wallSeconds;
    expect(checkpointMetadata(join(base.run.discoveryDir, "1-q1.md"))).toMatchObject({
      policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION, wallTargetSeconds: target, failure: { class: "deadline" },
    });

    const sameScout = createMockModel({ id: "same", handler: async () => ({ content: ["must not run"] }) } as never);
    const sameBrain = createMockModel({ id: "same-brain", handler: async () => ({ content: ["must not run"] }) } as never);
    expect(await runDiscover(deps(base, sameBrain, sameScout))).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: target });
    expect(sameScout.calls).toHaveLength(0); expect(sameBrain.calls).toHaveLength(0);

    const retryScout = createMockModel({ id: "retry", handler: async () => ({ content: ["- recovered"] }) } as never);
    const retryBrain = createMockModel({ id: "retry-brain", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const increased = deps(base, retryBrain, retryScout, 1); increased.cfg.budgets.wallSeconds = target + 1;
    expect(await runDiscover(increased)).toMatchObject({ outcome: "ok" });
    expect(retryScout.calls).toHaveLength(2); expect(retryBrain.calls).toHaveLength(1);
  });

  test("old budget checkpoints get one policy-migration retry without discarding successful checkpoints", async () => {
    const base = setup();
    seedFailureCheckpoints(base, "budget");
    const brief = readFileSync(base.run.brief, "utf8");
    const oldSuccess = { fingerprint: hashInput({ brief, question: "Q1?" }), state: "ok" };
    const encoded = Buffer.from(JSON.stringify(oldSuccess), "utf8").toString("base64url");
    writeFileSync(join(base.run.discoveryDir, "1-q1.md"), `<!-- kiln-scout-v1:${encoded} -->\n# Question\nQ1?\n\n# Findings\n- already paid success\n`);
    const scout = createMockModel({ id: "migration", handler: async () => ({ content: ["- recovered under bounded synthesis"] }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    expect(await runDiscover(deps(base, brain, scout, 1))).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(1); expect(brain.calls).toHaveLength(1);
    expect(readFileSync(join(base.run.discoveryDir, "1-q1.md"), "utf8")).toContain("already paid success");
    expect(checkpointMetadata(join(base.run.discoveryDir, "2-q2.md"))).toMatchObject({ policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION, state: "ok" });
  });

  test("one failing scout still lets the phase run on the others", async () => {
    const base = setup();
    const { run, record } = base;
    let n = 0;
    const scoutModel = createMockModel({ id: "scout", handler: async () => (n++ === 0 ? { throw: "boom" } : { content: ["- a real finding"] }) } as never);
    const brainModel = createMockModel({ id: "brain", handler: async () => (existsSync(run.landscape) ? { content: ["done"] } : { content: [{ type: "toolCall", name: "write", arguments: { path: run.landscape, content: LANDSCAPE } }] }) } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel));
    expect(r.outcome).toBe("ok");
    expect(record.read().filter((e) => e.t === "failure").length).toBe(1);
    const bodies = readdirSync(run.discoveryDir).map((f) => readFileSync(join(run.discoveryDir, f), "utf8"));
    expect(bodies.some((b) => b.includes("scout failed"))).toBe(true);
    expect(bodies.some((b) => b.includes("- a real finding"))).toBe(true);
  });

  test("a missing brief is an integrity failure recorded before the phase starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    const run = createRun(home, "seed"); writeStatus(run, { phase: "discover" }); // no brief.md
    const record = new RunRecord(run.record);
    const model = createMockModel({ id: "m", handler: async () => ({ content: ["x"] }) } as never);
    const r = await runDiscover(deps({ home, run, record }, model, model));
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("integrity"); expect(r.message).toContain("brief"); }
    expect(readStatus(run).state).toBe("failed");
    expect(record.read().some((e) => e.t === "failure" && e.class === "integrity")).toBe(true);
    expect(record.read().some((e) => e.t === "phase.start")).toBe(false);
    expect(model.calls.length).toBe(0);
  });

  test("exhausting the turn cap is a budget failure", async () => {
    const base = setup();
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brainModel = createMockModel({ id: "brain", handler: async () => ({ content: [{ type: "toolCall", name: "note", arguments: { text: "again" } }] }) } as never);
    const r = await runDiscover(deps(base, brainModel, scoutModel, 2));
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") { expect(r.failureClass).toBe("budget"); expect(r.message).toBe("turn cap 2 reached in discover"); }
    // Two journalled brain turns and no corrective re-prompt after the cap.
    expect(base.record.read().filter((e) => e.t === "model.call" && e.role === "brain").length).toBe(2);
  });

  test("a valid landscape written on the final allowed turn completes without another provider call", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brain = createMockModel({ id: "brain", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }] as never });
    expect(await runDiscover(deps(base, brain, scout, 1))).toMatchObject({ outcome: "ok" });
    expect(brain.calls).toHaveLength(1);
    expect(readStatus(base.run)).toMatchObject({ phase: "ideate", state: "running" });
  });

  test("a transient synthesis stop resumes without repeating successful paid scouts", async () => {
    const base = setup(); let scoutAttempt = 0;
    const firstScout = createMockModel({ id: "scout-1", handler: async () => scoutAttempt++ === 0
      ? { content: ["- durable finding"] }
      : { throw: "getaddrinfo ENOTFOUND chatgpt.com" } } as never);
    const firstBrain = createMockModel({ id: "brain-1", handler: async () => ({ throw: "getaddrinfo ENOTFOUND chatgpt.com" }) } as never);
    expect(await runDiscover(deps(base, firstBrain, firstScout))).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    expect(firstScout.calls).toHaveLength(2);

    const resumedScout = createMockModel({ id: "scout-2", handler: async () => ({ content: ["- recovered finding"] }) } as never);
    const resumedBrain = createMockModel({ id: "brain-2", handler: async () => existsSync(base.run.landscape)
      ? { content: ["done"] }
      : { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] } } as never);
    expect(await runDiscover(deps(base, resumedBrain, resumedScout))).toMatchObject({ outcome: "ok" });
    expect(resumedScout.calls).toHaveLength(1);
    expect(readStatus(base.run)).toMatchObject({ phase: "ideate", state: "running" });
  });

  test("resumed discovery synthesis shares its durable brain turn cap", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const firstBrain = createMockModel({ id: "first-brain", handler: async () => ({ throw: "rate limit exceeded" }) } as never);
    expect(await runDiscover(deps(base, firstBrain, scout, 2))).toMatchObject({ outcome: "stopped", stopKind: "transient" });

    const noMoreScouts = createMockModel({ id: "no-more-scouts", handler: async () => ({ content: ["must not run"] }) } as never);
    const resumedBrain = createMockModel({ id: "resumed-brain", responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }] as never });
    expect(await runDiscover(deps(base, resumedBrain, noMoreScouts, 2))).toMatchObject({ outcome: "ok" });
    expect(noMoreScouts.calls).toHaveLength(0); expect(resumedBrain.calls).toHaveLength(1);
    expect(base.record.read().filter((event) => event.t === "turn" && event.phase === "discover" && event.role === "brain")).toHaveLength(2);
  });

  test("a valid recovered landscape and matching scout checkpoints skip every paid model", async () => {
    const base = setup();
    const firstScout = createMockModel({ id: "scout-1", handler: async () => ({ content: ["- durable finding"] }) } as never);
    const firstBrain = createMockModel({ id: "brain-1", handler: async () => ({ throw: "getaddrinfo ENOTFOUND chatgpt.com" }) } as never);
    expect(await runDiscover(deps(base, firstBrain, firstScout))).toMatchObject({ outcome: "stopped", stopKind: "transient" });
    writeFileSync(base.run.landscape, LANDSCAPE);

    const scout = createMockModel({ id: "scout-2", handler: async () => ({ content: ["must not run"] }) } as never);
    const brain = createMockModel({ id: "brain-2", handler: async () => ({ content: ["must not run"] }) } as never);
    const resumed = deps(base, brain, scout); resumed.cfg.budgets.usd = 0; resumed.cfg.budgets.wallSeconds = 0;
    expect(await runDiscover(resumed)).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
  });

  test("a cancellation keeps completed scout work resumable without pretending the interrupted scout finished", async () => {
    const base = setup();
    const control = new RunControl();
    const scout = createMockModel({ id: "scout-cancel", handler: async (context: Context) => {
      const text = JSON.stringify(context.messages.at(-1));
      return text.includes("Q1?") ? { content: ["- durable before cancel"] } : { delayMs: 5_000, content: ["- too late"] };
    } } as never);
    const brain = createMockModel({ id: "brain-cancel", handler: async () => ({ content: ["must not run"] }) } as never);
    const firstDeps = deps(base, brain, scout);
    const running = withRunControl(control, () => runDiscover(firstDeps));
    const deadline = Date.now() + 2_000;
    while (readdirSync(base.run.discoveryDir).length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(readdirSync(base.run.discoveryDir)).toHaveLength(1);
    control.cancel("test pause");
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
    expect(firstDeps.limiter.active).toBe(0); expect(firstDeps.limiter.pending).toBe(0);

    const resumedScout = createMockModel({ id: "scout-resume", handler: async () => ({ content: ["- resumed"] }) } as never);
    const resumedBrain = createMockModel({ id: "brain-resume", handler: async () => existsSync(base.run.landscape)
      ? { content: ["done"] }
      : { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] } } as never);
    expect(await runDiscover(deps(base, resumedBrain, resumedScout))).toMatchObject({ outcome: "ok" });
    expect(resumedScout.calls).toHaveLength(1);
  });

  test("an empty scout answer is a visible verify failure and never becomes research context", async () => {
    const base = setup();
    const scout = createMockModel({ id: "empty-scout", handler: async () => ({ content: [] }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "failed", failureClass: "verify" });
    expect(brain.calls).toHaveLength(0);
    for (const file of readdirSync(base.run.discoveryDir)) expect(readFileSync(join(base.run.discoveryDir, file), "utf8")).toContain("scout returned no findings");
  });

  test("a non-transient partial scout result is not retried after transient synthesis", async () => {
    const base = setup(); let n = 0;
    const firstScout = createMockModel({ id: "first", handler: async () => n++ === 0
      ? { content: ["- evidence"] }
      : { stopReason: "error", errorMessage: "Refusal (safety)", stopDetails: { type: "refusal", category: "safety" } } } as never);
    const firstBrain = createMockModel({ id: "brain-first", handler: async () => ({ throw: "rate limit exceeded" }) } as never);
    expect(await runDiscover(deps(base, firstBrain, firstScout))).toMatchObject({ outcome: "stopped", stopKind: "transient" });

    const resumedScout = createMockModel({ id: "second", handler: async () => ({ content: ["must not run"] }) } as never);
    const resumedBrain = createMockModel({ id: "brain-second", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    expect(await runDiscover(deps(base, resumedBrain, resumedScout))).toMatchObject({ outcome: "ok" });
    expect(resumedScout.calls).toHaveLength(0);
  });

  test("a changed brief invalidates prior scout checkpoints even when the shape is unchanged", async () => {
    const base = setup();
    const firstScout = createMockModel({ id: "first", handler: async () => ({ content: ["- old"] }) } as never);
    const firstBrain = createMockModel({ id: "brain-first", handler: async () => ({ throw: "rate limit exceeded" }) } as never);
    expect(await runDiscover(deps(base, firstBrain, firstScout))).toMatchObject({ outcome: "stopped" });
    writeFileSync(base.run.brief, BRIEF.replace("## Problem\np", "## Problem\nchanged context"));

    const scout = createMockModel({ id: "second", handler: async () => ({ content: ["- current"] }) } as never);
    const brain = createMockModel({ id: "brain-second", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "ok" });
    expect(scout.calls).toHaveLength(2);
  });

  test("deadline classification stays authoritative even when a valid landscape file exists", async () => {
    const base = setup(); writeFileSync(base.run.landscape, LANDSCAPE);
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ throw: "request timed out" }) } as never);
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "failed", failureClass: "deadline" });
    expect(readStatus(base.run)).toMatchObject({ state: "failed", outcome: { failureClass: "deadline" } });
  });

  test("text produced after every attempted retrieval failed is discarded as unverified", async () => {
    const base = setup();
    const search = { content: [{ type: "toolCall" as const, name: "web_search", arguments: { query: "evidence" } }] };
    const scout = createMockModel({ id: "search-scout", responses: [search, search, { content: ["- unsupported claim"] }, { content: ["- unsupported claim"] }] as never });
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const d = deps(base, brain, scout); d.fetchImpl = (async () => { throw new TypeError("fetch failed: network offline"); }) as unknown as typeof fetch;
    expect(await runDiscover(d)).toMatchObject({ outcome: "failed", failureClass: "verify" });
    expect(brain.calls).toHaveLength(0);
    for (const file of readdirSync(base.run.discoveryDir)) {
      const body = readFileSync(join(base.run.discoveryDir, file), "utf8");
      expect(body).not.toContain("unsupported claim");
      expect(body).toContain("discarded as unverified");
    }
  });

  test("discovery scouts obey the shared model concurrency limiter", async () => {
    const base = setup(); let active = 0; let peak = 0;
    const scout = createMockModel({ id: "limited", handler: async () => {
      active += 1; peak = Math.max(peak, active);
      await Bun.sleep(15);
      active -= 1;
      return { content: ["- finding"] };
    } } as never);
    const brain = createMockModel({ id: "brain", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const d = deps(base, brain, scout); d.limiter = new Limiter(1);
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(peak).toBe(1);
  });

  test("terminal status carries the journal's actual cost", async () => {
    const base = setup(); const pricing = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
    const charged = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const scout = createMockModel({ id: "paid-scout", cost: pricing, handler: async () => ({ content: ["- finding"], usage: { input: 1_000_000, cost: charged } }) } as never);
    const brain = createMockModel({ id: "paid-brain", cost: pricing, handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }], usage: { input: 1_000_000, cost: charged } }) } as never);
    const d = deps(base, brain, scout, 1); d.cfg.budgets.usd = 100;
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(base.record.costUsd()).toBeCloseTo(3);
    expect(readStatus(base.run).usdSpent).toBeCloseTo(base.record.costUsd());
  });

  test("an exhausted run target stops before discovery dispatch and records the target", async () => {
    const base = setup();
    const scout = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    const brain = createMockModel({ id: "must-not-run-brain", handler: async () => ({ content: ["x"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 0;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 0 });
    expect(scout.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
    expect(readStatus(base.run)).toMatchObject({ phase: "discover", state: "stopped", outcome: { stopKind: "budget", budgetTargetUsd: 0 } });
  });

  test("an exhausted wall target stops before discovery dispatch", async () => {
    const base = setup();
    const scout = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    const brain = createMockModel({ id: "must-not-run-brain", handler: async () => ({ content: ["x"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 0;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0 });
    expect(scout.calls).toHaveLength(0); expect(brain.calls).toHaveLength(0);
    expect(readStatus(base.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0 } });
  });

  test("discovery settles all scouts when the remaining run wall deadline aborts them", async () => {
    const base = setup();
    const scout = createMockModel({ id: "slow-scout", handler: async () => ({ delayMs: 5_000, content: ["late"] }) } as never);
    const brain = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    // Leave enough time to dispatch both mocks before the two-thirds research window expires.
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 0.3;
    d.cfg.budgets.share = { frame: 0, discover: 1, ideate: 0, form: 0, build: 0, reflect: 0 };
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0.3 });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
    expect(d.limiter.active).toBe(0); expect(d.limiter.pending).toBe(0);
    expect(existsSync(base.run.landscape)).toBe(false);
    expect(readStatus(base.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0.3 } });
  });

  test("the same run wall deadline also aborts discovery synthesis after scouts finish", async () => {
    const base = setup();
    const scout = createMockModel({ id: "fast-scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brain = createMockModel({ id: "slow-brain", handler: async () => ({ delayMs: 5_000, content: ["late"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 0.8;
    d.cfg.budgets.share = { frame: 0, discover: 1, ideate: 0, form: 0, build: 0, reflect: 0 };
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0.8 });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(1);
    expect(readStatus(base.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0.8 } });
  });

  test("completed crossing scouts are preserved but synthesis cannot start past the run target", async () => {
    const base = setup(); const pricing = { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 };
    const scout = createMockModel({ id: "crossing-scout", cost: pricing, handler: async () => ({ content: ["- finding"], usage: { input: 1_000_000, cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } } }) } as never);
    const brain = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 1;
    d.cfg.budgets.share = { frame: 0, discover: 1, ideate: 0, form: 0, build: 0, reflect: 0 };
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 1 });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
    expect(base.record.costUsd()).toBeCloseTo(4);
    expect(readdirSync(base.run.discoveryDir)).toHaveLength(2);
  });

  test("a contract-valid landscape from a crossing dollar-cap turn is accepted without another call", async () => {
    const base = setup(); const charged = { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 };
    const scout = createMockModel({ id: "free-scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brain = createMockModel({
      id: "crossing-brain", cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
      responses: [{ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }], usage: { input: 1_000_000, cost: charged } }] as never,
    });
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 1;
    expect(await runDiscover(d)).toMatchObject({ outcome: "ok" });
    expect(brain.calls).toHaveLength(1); expect(base.record.costUsd()).toBeCloseTo(2);
  });

  test("the synthesis brain cannot rewrite harness-owned scout checkpoints", async () => {
    const base = setup();
    const scout = createMockModel({ id: "scout", handler: async () => ({ content: ["- original evidence"] }) } as never);
    const firstFinding = join(base.run.discoveryDir, "1-q1.md");
    const brain = createMockModel({ id: "brain", responses: [
      { content: [{ type: "toolCall", name: "write", arguments: { path: firstFinding, content: "forged" } }] },
      { content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] },
      { content: ["done"] },
    ] as never });
    expect(await runDiscover(deps(base, brain, scout))).toMatchObject({ outcome: "ok" });
    expect(readFileSync(firstFinding, "utf8")).toContain("original evidence");
    expect(base.record.read()).toContainEqual(expect.objectContaining({ t: "tool.call", name: "write", ok: false }));
  });
});
