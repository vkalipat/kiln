import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { createBrain } from "../../src/brain/agent";
import { adaptiveEvidencePrompt, classifyEvidenceDomain } from "../../src/brain/adaptive-evidence";
import { defaultConfig, type Phase, type Role } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";

function adaptive() {
  const cfg = defaultConfig();
  cfg.routing = { mode: "adaptive" };
  return cfg;
}

function create(role: Role, phase: Phase, toolNames: string[], kernel = "# old custom kernel") {
  const home = mkdtempSync(join(tmpdir(), "kiln-evidence-"));
  const run = createRun(home, "Develop a research idea for protein discovery.");
  writeFileSync(run.status, JSON.stringify({ shape: "research" }));
  const model = createMockModel({ id: "mock", responses: [{ content: ["done"] }] });
  const brain = createBrain({
    model: model as never,
    tools: toolNames.map((name) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) })) as never,
    systemPrompt: [kernel],
    pinned: "contract",
    record: new RunRecord(run.record),
    role,
    phase,
    turnCap: 1,
    streamFn: streamMock as never,
    shaping: { cfg: adaptive(), runId: run.id },
  });
  return brain.agent.state.systemPrompt;
}

describe("adaptive evidence prompt", () => {
  test("injects the full policy into a stale custom kernel and keeps the pinned contract last", () => {
    const prompt = create("generator", "ideate", []);
    const block = prompt.find((part) => part.startsWith("## Evidence discipline"));
    expect(block).toContain("actually inspected source");
    expect(block).toContain("failed, blocked, or incomplete search");
    expect(block).toContain("no external retrieval tool");
    expect(block).toContain("novel mechanisms are hypotheses");
    expect(block).toContain("do not turn the run into clinical advice or operational wet-lab instructions");
    expect(prompt.at(-1)).toBe("## Pinned\ncontract");
  });

  test("adds role-aware retrieval guidance without duplicating a current evidence heading", () => {
    const prompt = create("scout", "discover", ["web_search", "web_fetch"], "# kernel\n\n## Evidence discipline\n\nExisting rules.");
    const joined = prompt.join("\n");
    expect(joined.match(/^## Evidence discipline\s*$/gm)).toHaveLength(1);
    expect(joined.match(/^## Adaptive evidence context\s*$/gm)).toHaveLength(1);
    expect(joined).toContain("External retrieval is available through `web_search`, `web_fetch`");
    expect(joined).toContain("Open and inspect a source before citing it");
  });

  test("keeps verdict-only reviewers from claiming browser verification", () => {
    const prompt = create("judge", "ideate", ["verdict"]);
    const joined = prompt.join("\n");
    expect(joined).toContain("This seat has no external retrieval tool");
    expect(joined).toContain("Do not claim to have browsed or independently checked a source");
    expect(joined).toContain("Agreement between models or reviewers is not fact verification");
  });

  test("does not inject runtime guidance in manual mode", () => {
    const cfg = defaultConfig();
    cfg.routing = { mode: "manual" };
    expect(adaptiveEvidencePrompt({
      cfg,
      role: "brain",
      phase: "frame",
      toolNames: ["web_search"],
      systemPrompt: ["stale kernel"],
      recordPath: "/does/not/exist/record.jsonl",
    })).toBeUndefined();
  });

  test("specializes research and business seeds without treating every product as business", () => {
    expect(classifyEvidenceDomain("Research a GFP minibinder", "research")).toBe("research");
    expect(classifyEvidenceDomain("Find a startup market and pricing wedge", "product")).toBe("business");
    expect(classifyEvidenceDomain("Design a better desk organizer", "product")).toBe("general");
  });
});
