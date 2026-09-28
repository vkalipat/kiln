import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { createBrain, type BrainOptions } from "../../src/brain/agent";
import { brainTools } from "../../src/brain/tools";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { defaultConfig } from "../../src/core/config";
import { RunControl, withRunControl } from "../../src/core/run-control";

const cell = (input: string) => ({ content: [{ type: "toolCall", name: "exec", arguments: { input }, customWireName: "exec" }] });
function setup(responses: unknown[], overrides: Partial<BrainOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-code-mode-agent-"));
  const run = createRun(home, "seed");
  const record = new RunRecord(run.record);
  let exits = 0;
  const tools = brainTools({ cwd: run.dir, roots: [run.dir], run, record, onExit: () => { exits++; } }, "frame");
  const mock = createMockModel({ id: "scripted-code-mode", responses: responses as never });
  const model = getBundledModel("openai-codex", "gpt-6-astra")!;
  const contexts: unknown[] = [];
  const brain = createBrain({ model, tools, systemPrompt: ["Test the supplied tools; no network."], pinned: "Keep the original task.", record,
    role: "brain", phase: "frame", turnCap: 5, effort: "low", apiKey: "synthetic", shaping: { cfg: defaultConfig(), runId: run.id },
    streamFn: (_model, context, options) => { contexts.push(context); return streamMock(mock, context, options); }, ...overrides });
  return { brain, run, record, contexts, model, exits: () => exits };
}

test("native Code Mode sends only a custom executor and preserves nested artifact completion", async () => {
  const events: string[] = [];
  const f = setup([cell('await tools.note({text:"start"}); await tools.write({path:"artifact.txt",content:"complete"}); await tools.note({text:"must not run"});')], {
    afterTool: (event) => event.name === "write" && event.ok,
    onTool: (event) => events.push(`${event.phase}:${event.name}`),
  });
  const result = await f.brain.run("Write the artifact.");
  expect(result.stopped).toBe("done");
  expect(f.contexts).toHaveLength(1);
  expect(readFileSync(join(f.run.dir, "artifact.txt"), "utf8")).toBe("complete");
  const context = f.contexts[0] as { tools: Parameters<typeof convertOpenAICodexResponsesTools>[0] };
  expect(context.tools.map((tool) => tool.name)).toEqual(["exec"]);
  const wire = convertOpenAICodexResponsesTools(context.tools, f.model as Parameters<typeof convertOpenAICodexResponsesTools>[1]);
  expect(wire).toHaveLength(1);
  expect(wire[0]).toMatchObject({ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark" } });
  expect(events).toContain("start:note");
  expect(events).toContain("end:write");
  expect(f.record.read().some((event) => event.t === "note" && event.text === "must not run")).toBe(false);
  expect(f.record.read().filter((event) => event.t === "tool.call").map((event) => event.name)).toEqual(["note", "write", "exec"]);
  expect(f.record.read().filter((event) => event.t === "model.call")).toHaveLength(1);
});

test("Code Mode honors withdrawal inside a cell and updates the next wire tool inventory", async () => {
  let f: ReturnType<typeof setup>;
  f = setup([cell('await tools.note({text:"withdraw"}); text(await tools.read({path:"input.txt"}));'), { content: ["The read capability was withdrawn."] }], {
    onTool: (event) => {
      if (event.name === "note" && event.phase === "end") f.brain.agent.setTools(f.brain.agent.state.tools.filter((tool) => tool.name === "note"));
    },
  });
  writeFileSync(join(f.run.dir, "input.txt"), "not retrieved");
  await f.brain.run("Respect tool withdrawal.");
  expect(f.contexts).toHaveLength(2);
  expect(f.record.read().some((event) => event.t === "tool.call" && event.name === "read")).toBe(false);
  const next = f.contexts[1] as { tools: Array<{ name: string; description: string }> };
  expect(next.tools.map((tool) => tool.name)).toEqual(["exec"]);
  expect(next.tools[0]!.description).toContain('"name":"note"');
  expect(next.tools[0]!.description).not.toContain('"name":"read"');
});

test("Code Mode preserves the tool-free finishing window and retrieved evidence", async () => {
  const f = setup([cell('text(await tools.read({path:"input.txt"}));'), { content: ["The retained evidence supports the answer."] }], { finalizeWithoutTools: () => true });
  writeFileSync(join(f.run.dir, "input.txt"), "EXACT-RETRIEVED-EVIDENCE");
  const result = await f.brain.run("Read then synthesize.");
  expect(result.stopped).toBe("done");
  expect(f.contexts).toHaveLength(2);
  expect((f.contexts[1] as { tools: unknown[] }).tools).toEqual([]);
  expect(JSON.stringify(f.contexts[1])).toContain("EXACT-RETRIEVED-EVIDENCE");
});

test("Code Mode terminal calls cannot strand queued steering", async () => {
  let f: ReturnType<typeof setup>;
  f = setup([
    cell('await tools.note({text:"queue steering"}); await tools.exit({kind:"underspecified",reasons:["stale decision"]});'),
    cell('await tools.note({text:"handled revised request"});'),
  ], {
    onTool: (event) => {
      if (event.phase === "end" && event.name === "note" && (event.args as { text: string }).text === "queue steering") {
        f.brain.agent.steer({ role: "user", content: "REVISED-USER-CONSTRAINT", timestamp: Date.now() });
      }
    },
    afterTool: (event) => event.name === "note" && (event.args as { text: string }).text === "handled revised request",
  });
  const result = await f.brain.run("Original request.");
  expect(result).toMatchObject({ stopped: "done" });
  expect(f.exits()).toBe(0);
  expect(f.contexts).toHaveLength(2);
  expect(JSON.stringify(f.contexts[1])).toContain("REVISED-USER-CONSTRAINT");
});

test("Code Mode cancellation prevents queued mutations and preserves cancellation status", async () => {
  const control = new RunControl();
  const f = setup([cell('await tools.note({text:"cancel"}); await tools.write({path:"must-not-exist",content:"bad"});')], {
    onTool: (event) => { if (event.phase === "end" && event.name === "note") control.cancel("test operator stop"); },
  });
  await expect(withRunControl(control, () => f.brain.run("stop safely"))).rejects.toThrow();
  expect(f.record.read().some((event) => event.t === "tool.call" && event.name === "write")).toBe(false);
});

test("Code Mode retains turn and dollar admission guards", async () => {
  const turn = setup([cell('await tools.note({text:"one"});')], { turnCap: 1 });
  expect((await turn.brain.run("bounded" )).stopped).toBe("turn_cap");
  expect(turn.contexts).toHaveLength(1);
  const usd = setup([cell('await tools.note({text:"never"});')], { usdCap: 0 });
  expect((await usd.brain.run("unfunded")).stopped).toBe("usd_cap");
  expect(usd.contexts).toHaveLength(0);
});
