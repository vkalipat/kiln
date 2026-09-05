import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { parseLandscape, runDiscover } from "../../src/phases/discover";
import { parseBrief, type PhaseDeps } from "../../src/phases/frame";
import { shapeHash } from "../../src/phases/contracts";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { createRun, readStatus, writeStatus, type RunPaths } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
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

describe("runDiscover", () => {
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
});
