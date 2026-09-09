import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Context } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { parseLandscape, runDiscover, SCOUT_CHECKPOINT_POLICY_VERSION } from "../../src/phases/discover";
import { parseBrief, type PhaseDeps } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { createRun, readStatus, writeStatus, type RunPaths } from "../../src/core/run";
import { hashInput, RunRecord } from "../../src/core/record";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";
import { initHome } from "../../src/core/home";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery";
const BRIEF = `# Brief\n\n## Problem\np\n\n## Constraints\n- c\n\n## Search success\n- s\n\n## Non-goals\n- n\n\n## Shape\nproduct\n\n## Axes\n${AXES}\n\n## Discovery questions\n- Q1?\n- Q2?\n`;
const LANDSCAPE = `# Landscape\n\n## Obvious list\n- an app that counts mites\n\n## Atoms\n- mite (common)\n- acoustic sensing (rare)\n\n## Tensions\n- cheap vs accurate\n\n## Distant domains\n- vineyard pest monitoring\n`;

describe("parseLandscape", () => {
  test("extracts the four lists", () => {
    const l = parseLandscape(LANDSCAPE);
    expect(l.missing).toEqual([]); expect(l.obvious).toEqual(["an app that counts mites"]); expect(l.atoms.length).toBe(2); expect(l.domains).toEqual(["vineyard pest monitoring"]);
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

function checkpointMetadata(path: string): Record<string, unknown> {
  const line = readFileSync(path, "utf8").split("\n", 1)[0]!;
  return JSON.parse(Buffer.from(line.slice("<!-- kiln-scout-v1:".length, -4), "base64url").toString("utf8"));
}

describe("runDiscover", () => {
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
    const first = deps(base, brain, cappedScout); first.cfg.budgets.usd = 0.1;
    expect(await runDiscover(first)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 0.1 });
    expect(cappedScout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
    expect(checkpointMetadata(join(base.run.discoveryDir, "1-q1.md"))).toMatchObject({
      policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION, budgetTargetUsd: 0.1, failure: { class: "budget" },
    });

    const sameScout = createMockModel({ id: "same", handler: async () => ({ content: ["must not run"] }) } as never);
    const sameBrain = createMockModel({ id: "same-brain", handler: async () => ({ content: ["must not run"] }) } as never);
    const same = deps(base, sameBrain, sameScout); same.cfg.budgets.usd = 0.1;
    expect(await runDiscover(same)).toMatchObject({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: 0.1 });
    expect(sameScout.calls).toHaveLength(0); expect(sameBrain.calls).toHaveLength(0);

    const retryScout = createMockModel({ id: "retry", handler: async () => ({ content: ["- recovered"] }) } as never);
    const retryBrain = createMockModel({ id: "retry-brain", handler: async () => ({ content: [{ type: "toolCall", name: "write", arguments: { path: base.run.landscape, content: LANDSCAPE } }] }) } as never);
    const increased = deps(base, retryBrain, retryScout, 1); increased.cfg.budgets.usd = 3;
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
    expect(await runDiscover(deps(base, brain, scout, 1))).toMatchObject({ outcome: "ok" });
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
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 0.03;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0.03 });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(0);
    expect(d.limiter.active).toBe(0); expect(d.limiter.pending).toBe(0);
    expect(readStatus(base.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0.03 } });
  });

  test("the same run wall deadline also aborts discovery synthesis after scouts finish", async () => {
    const base = setup();
    const scout = createMockModel({ id: "fast-scout", handler: async () => ({ content: ["- finding"] }) } as never);
    const brain = createMockModel({ id: "slow-brain", handler: async () => ({ delayMs: 5_000, content: ["late"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.wallSeconds = 0.8;
    expect(await runDiscover(d)).toMatchObject({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: 0.8 });
    expect(scout.calls).toHaveLength(2); expect(brain.calls).toHaveLength(1);
    expect(readStatus(base.run)).toMatchObject({ state: "stopped", outcome: { stopKind: "deadline", wallTargetSeconds: 0.8 } });
  });

  test("completed crossing scouts are preserved but synthesis cannot start past the run target", async () => {
    const base = setup(); const pricing = { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 };
    const scout = createMockModel({ id: "crossing-scout", cost: pricing, handler: async () => ({ content: ["- finding"], usage: { input: 1_000_000, cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } } }) } as never);
    const brain = createMockModel({ id: "must-not-run", handler: async () => ({ content: ["x"] }) } as never);
    const d = deps(base, brain, scout); d.cfg.budgets.usd = 1;
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
