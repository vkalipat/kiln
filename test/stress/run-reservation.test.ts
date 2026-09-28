import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { readStatus, runPaths } from "../../src/core/run";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BRIEF = `# Brief

## Problem
Create one bounded local utility concept.

## Constraints
- no network

## Search success
- observable local behavior

## Non-goals
- hosted deployment

## Shape
product

## Axes
- user: developer | operator | researcher
- interface: cli | library | service
- value: speed | reliability | portability

## Discovery questions
- Which behavior is directly testable?
- Which edge case is most likely to fail?
`;

describe("exclusive run reservation", () => {
  test("eight simultaneous starts with one id create one authoritative run and no duplicate work", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-stress-reservation-"));
    roots.push(root);
    const home = join(root, ".kiln");
    initHome(home);
    let modelCalls = 0;
    const brain = createMockModel({ id: "reservation-brain", provider: "mock-producer", handler: async (context: { systemPrompt?: string[]; messages?: Array<{ role?: string }> }) => {
      modelCalls += 1;
      await Bun.sleep(30);
      if (context.messages?.at(-1)?.role === "toolResult") return { content: ["done"] };
      const target = /Output file: (\S+)/.exec((context.systemPrompt ?? []).join("\n"))?.[1] ?? "";
      return { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: BRIEF } }] };
    } } as never);
    const invoke = async () => {
      const output: string[] = [];
      const code = await main([
        "run", "new", "Create one bounded local utility concept", "--id", "stress-same-id", "--through", "frame", "--home", home, "--json",
      ], { write: (text) => output.push(text), error: (text) => output.push(text) }, {
        brainModel: brain as never,
        streamFn: streamMock as never,
        apiKeyFor: async () => "provider-free-stress",
      });
      return { code, output: output.join("") };
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => invoke()));

    expect(results.map((result) => result.code).sort()).toEqual([0, 2, 2, 2, 2, 2, 2, 2]);
    expect(results.find((result) => result.code === 2)?.output).toContain("already exists");
    const run = runPaths(home, "stress-same-id");
    expect(existsSync(run.dir)).toBe(true);
    expect(readStatus(run)).toMatchObject({ phase: "discover", state: "running", shape: "product" });
    const events = new RunRecord(run.record).read();
    expect(events.filter((event) => event.t === "run.created")).toHaveLength(1);
    expect(events.filter((event) => event.t === "phase.end" && event.phase === "frame")).toHaveLength(1);
    expect(modelCalls).toBe(1); // One authoritative artifact, no redundant completion narration.
  }, 10_000);
});
