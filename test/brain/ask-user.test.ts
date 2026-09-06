import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { createBrain } from "../../src/brain/agent";
import { brainTools, type ToolContext } from "../../src/brain/tools";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { RunCancelledError } from "../../src/core/run-control";

function setup(askUser?: ToolContext["askUser"]) {
  const run = createRun(mkdtempSync(join(tmpdir(), "kiln-ask-")), "A useful idea");
  const record = new RunRecord(run.record);
  const tools = brainTools({ cwd: run.dir, roots: [run.dir], run, record, askUser }, "frame");
  return { run, record, tools, tool: tools.find((tool) => tool.name === "ask_user")! };
}

test("a decisive answer reaches the native agent context through the real tool", async () => {
  const { tools, record } = setup(async () => "Use the existing public dataset; no new patient data.");
  const model = createMockModel({ responses: [{ content: [{ type: "toolCall", name: "ask_user", arguments: { question: "Which existing dataset should the analysis use?" } }] }, { content: ["I will use the supplied constraint."] }] });
  const brain = createBrain({ model, tools, role: "brain", phase: "frame", turnCap: 3, record, systemPrompt: ["Use tools to clarify only a blocking fact."], pinned: "Write a bounded analysis plan.", streamFn: streamMock });
  await brain.run("Go");
  expect(model.calls[1]?.context.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("existing public dataset"))).toBe(true);
  expect(record.read().filter((event) => event.t === "tool.call" && event.name === "ask_user")).toHaveLength(1);
});

test("headless clarification is explicit non-answer and one question cannot become a loop", async () => {
  const { tool } = setup();
  const first = await tool.execute("one", { question: "Which required file?" }, new AbortController().signal, undefined as never, undefined as never);
  expect(JSON.stringify(first)).toContain("No answer was supplied");
  const second = await tool.execute("two", { question: "Which required file?" }, new AbortController().signal, undefined as never, undefined as never);
  expect(second.isError).toBe(true);
});

test("cancelling an unanswered question records neither an answer nor a false tool result", async () => {
  const { tool, record } = setup(() => new Promise(() => {})); const control = new AbortController();
  const pending = tool.execute("one", { question: "Which required file?" }, control.signal, undefined as never, undefined as never);
  control.abort(); await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
  expect(record.read().filter((event) => event.t === "tool.call")).toHaveLength(0);
});
