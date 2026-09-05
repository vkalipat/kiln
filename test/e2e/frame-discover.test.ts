import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { main } from "../../src/cli/main";

const AXES = "- who it serves: hobbyists | sideliners | commercial\n- mechanism class: sensing | modeling | logistics\n- where the value shows up: prevention | diagnosis | recovery";
const BRIEF = (p: string) => `# Brief\n\n## Problem\np\n\n## Constraints\n- c\n\n## Search success\n- s\n\n## Non-goals\n- n\n\n## Shape\nproduct\n\n## Axes\n${AXES}\n\n## Discovery questions\n- Q1?\n- Q2?\n`;
const LANDSCAPE = `# Landscape\n\n## Obvious list\n- o\n\n## Atoms\n- a (common)\n\n## Tensions\n- t\n\n## Distant domains\n- d\n`;

describe("kiln run new through discover (mocked)", () => {
  test("produces brief, discovery, landscape, record, and json summary", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    let briefPath = ""; let landscapePath = "";
    const brainModel = createMockModel({ id: "brain", handler: async (ctx: { systemPrompt?: string[]; messages: Array<{ role: string; content: unknown }> }) => {
      // `JSON.stringify(ctx)` would escape the pinned block's real newlines to literal `\n`
      // (backslash+n), which `\S+` does not treat as a boundary, so it over-captures past the
      // path. Read the pinned system-prompt entries directly instead, where newlines are real.
      const sys = (ctx.systemPrompt ?? []).join("\n"); const m = /Output file: (\S+)/.exec(sys); const target = m?.[1] ?? "";
      if (target.endsWith("brief.md") && !existsSync(target)) { briefPath = target; return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: BRIEF(target) } }] }; }
      if (target.endsWith("landscape.md") && !existsSync(target)) { landscapePath = target; return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: LANDSCAPE } }] }; }
      return { content: ["done"] };
    } } as never);
    const scoutModel = createMockModel({ id: "scout", handler: async () => ({ content: ["- finding (https://x)"] }) } as never);
    const out: string[] = [];
    const code = await main(["run", "new", "an app for beekeepers", "--home", home, "--through", "discover", "--json"], { write: (s) => out.push(s), error: () => {} }, { streamFn: streamMock as never, brainModel: brainModel as never, scoutModel: scoutModel as never, apiKeyFor: async () => "k" });
    expect(code).toBe(0);
    const summary = JSON.parse(out.join(""));
    expect(summary.status.phase).toBe("ideate");
    expect(readFileSync(join(summary.dir, "brief.md"), "utf8")).toBe(BRIEF(briefPath));
    expect(readdirSync(join(summary.dir, "discovery")).length).toBe(2);
    expect(summary.status.shape).toBe("product");
    expect(typeof summary.status.shapeHash).toBe("string");
    expect(readFileSync(join(summary.dir, "landscape.md"), "utf8")).toBe(LANDSCAPE);
    const record = readFileSync(join(summary.dir, "record.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(record.filter((e) => e.t === "phase.end").map((e) => e.phase)).toEqual(["frame", "discover"]);
    void landscapePath;
  });
});
