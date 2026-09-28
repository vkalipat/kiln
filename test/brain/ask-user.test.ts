import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import type { Model } from "@oh-my-pi/pi-catalog";
import { askUserTool } from "../../src/brain/tools/ask-user";
import { brainTools, type ToolContext } from "../../src/brain/tools";
import { createBrain } from "../../src/brain/agent";
import { RunCancelledError } from "../../src/core/run-control";
import { clarificationPath, readClarification, CLARIFICATION_MAX_BYTES } from "../../src/brain/clarification";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { initHome } from "../../src/core/home";
import { defaultConfig } from "../../src/core/config";
import { Limiter } from "../../src/core/limiter";
import { runFrame } from "../../src/phases/frame";

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


function durableSetup(answer: string) {
  const home = mkdtempSync(join(tmpdir(), "kiln-clarification-"));
  initHome(home);
  const run = createRun(home, "Build an app");
  const record = new RunRecord(run.record);
  let asked = 0;
  const ctx: ToolContext = { cwd: run.dir, roots: [run.dir], run, record, askUser: async () => { asked++; return answer; } };
  const call = (tool = askUserTool(ctx)) => tool.execute("id", { question: "Which users?" }, undefined as never);
  return { home, run, record, ctx, call, count: () => asked };
}

test("clarification survives a fresh tool and reaches the resumed frame model", async () => {
  const answer = "Serve independent bookshops. " + "Preserve this requirement. ".repeat(30);
  const s = durableSetup(answer);
  await s.call();
  expect(readClarification(s.run)?.answer).toBe(answer);
  expect(statSync(clarificationPath(s.run)).mode & 0o777).toBe(0o600);
  expect((await s.call()).isError).toBe(true);
  expect(s.count()).toBe(1);
  const model = createMockModel({ id: "mock", responses: [{ content: [{ type: "toolCall", name: "exit", arguments: { kind: "cannot_be_satisfied", reasons: ["test terminal"] } }] }] } as never);
  await runFrame({ home: s.home, run: s.run, record: s.record, cfg: defaultConfig(),
    models: () => ({ model: model as unknown as Model, ref: "mock/mock" }), apiKeyFor: async () => "k",
    streamFn: streamMock as never, limiter: new Limiter(2), effort: "medium" });
  const system = JSON.stringify(model.calls[0]!.context.systemPrompt);
  expect(system).toContain(answer);
  expect(system).toContain("canonical brief");
});

test("oversized answers are rejected whole and the question remains consumed", async () => {
  const s = durableSetup("x".repeat(CLARIFICATION_MAX_BYTES + 1));
  const tool = askUserTool(s.ctx);
  await expect(s.call(tool)).rejects.toThrow("no partial answer was saved");
  expect(readClarification(s.run)?.answer).toBeUndefined();
  expect((await s.call(tool)).isError).toBe(true);
  expect(s.count()).toBe(1);
});

test("a reconnected operator may answer only the same interrupted question", async () => {
  const s = durableSetup("unused");
  s.ctx.askUser = async () => { throw new Error("operator disconnected"); };
  await expect(s.call()).rejects.toThrow("operator disconnected");
  expect(readClarification(s.run)).toEqual({ version: 1, question: "Which users?" });
  s.ctx.askUser = async () => "Independent bookshops";
  const resumed = askUserTool(s.ctx);
  expect((await resumed.execute("different", { question: "Which budget?" }, undefined as never)).isError).toBe(true);
  expect((await s.call(resumed)).isError).not.toBe(true);
  expect(readClarification(s.run)?.answer).toBe("Independent bookshops");
  expect((await s.call()).isError).toBe(true);
});

test("known credentials are sanitized without rewriting ordinary requirements", async () => {
  const s = durableSetup("Use blue buttons. Key sk-abcdefghijklmnopqrstuv should not persist.");
  await s.call();
  expect(readClarification(s.run)?.answer).toBe("Use blue buttons. Key [REDACTED] should not persist.");
});
