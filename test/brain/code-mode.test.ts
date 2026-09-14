import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createCodeModeTool } from "../../src/brain/code-mode";

const tool = (name: string, execute: AgentTool<any>["execute"]): AgentTool<any> => ({
  name, label: name, description: name,
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, execute,
});
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const run = (t: AgentTool<any>, input: string, signal?: AbortSignal) => t.execute("cell", { input }, signal);
const output = (r: Awaited<ReturnType<typeof run>>) => r.content.map((c) => c.type === "text" ? c.text : "").join("\n");

describe("isolated code mode", () => {
  test.each([
    'await tools.stop({value:""}); await tools.tail({value:""});',
    'await Promise.all([tools.stop({value:""}), tools.tail({value:""})]);',
    'await tools.stop({value:""}); while(true) {}',
  ])("terminal completion stops guest continuations without a false error: %s", async (input) => {
    let tails = 0;
    const t = createCodeModeTool({ getTools: () => [tool("stop", async () => ok("done")), tool("tail", async () => { tails++; return ok("bad"); })],
      isTerminal: (event) => event.name === "stop" && event.ok === true, limits: { cpuMs: 20, wallMs: 100 } });
    const result = await run(t, input);
    expect(result.isError).toBe(false);
    expect(result.details.codeMode.terminal).toBe(true);
    expect(tails).toBe(0);
  });

  test("an explicit terminal predicate overrides exit fallback", async () => {
    let tails = 0;
    const t = createCodeModeTool({ getTools: () => [tool("exit", async () => ok("deferred")), tool("tail", async () => { tails++; return ok("done"); })], isTerminal: () => false });
    expect((await run(t, 'await tools.exit({value:""}); await tools.tail({value:""});')).isError).toBe(false);
    expect(tails).toBe(1);
  });

  test("terminal identity is reported even when the after-tool hook also stops", async () => {
    let identified = false;
    const t = createCodeModeTool({ getTools: () => [tool("exit", async () => ok("done"))], onAfterTool: () => true,
      isTerminal: (event) => { identified = event.name === "exit"; return identified; } });
    expect((await run(t, 'await tools.exit({value:""});')).isError).toBe(false);
    expect(identified).toBe(true);
  });

  test("external cancellation takes priority over terminal completion", async () => {
    const controller = new AbortController();
    const t = createCodeModeTool({ getTools: () => [tool("stop", async () => { controller.abort("operator cancelled"); return ok("done"); })], isTerminal: () => true });
    expect((await run(t, 'await tools.stop({value:""});', controller.signal)).isError).toBe(true);
  });

  test("an earlier validation failure cannot be hidden by a queued terminal action", async () => {
    let stops = 0;
    const t = createCodeModeTool({ getTools: () => [tool("first", async () => ok("bad")), tool("stop", async () => { stops++; return ok("done"); })], isTerminal: (event) => event.name === "stop" });
    const result = await run(t, 'await Promise.all([tools.first({}), tools.stop({value:""})]);');
    expect(result.isError).toBe(true);
    expect(stops).toBe(0);
  });
  test("supports asynchronous JSON tools and text without host globals", async () => {
    const t = createCodeModeTool({ getTools: () => [tool("echo", async (_id, p) => ok(p.value))] });
    const result = await run(t, 'text([typeof process, typeof require, typeof fetch, typeof Bun]); text(await tools.echo({value:"hello"}));');
    expect(result.isError).not.toBe(true);
    expect(output(result)).toContain('["undefined","undefined","undefined","undefined"]');
    expect(output(result)).toContain("hello");
    expect(t.customFormat?.syntax).toBe("lark");
    expect(t.concurrency).toBe("exclusive");
  });

  test("Function constructors stay inside the isolated global", async () => {
    const t = createCodeModeTool({ getTools: () => [] });
    const result = await run(t, 'text(({}).constructor.constructor("return typeof process")());');
    expect(output(result)).toContain("undefined");
  });

  test("validates original schemas before invoking a tool", async () => {
    let calls = 0;
    const t = createCodeModeTool({ getTools: () => [tool("echo", async () => { calls++; return ok("bad"); })] });
    const result = await run(t, 'await tools.echo({});');
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test("serializes Promise.all actions and suppresses queued work after terminal", async () => {
    const order: string[] = [];
    const t = createCodeModeTool({ getTools: () => [tool("first", async () => { order.push("first"); await Promise.resolve(); order.push("first-end"); return ok("done"); }),
      tool("stop", async () => { order.push("stop"); return ok("stop"); }), tool("last", async () => { order.push("last"); return ok("bad"); })],
      isTerminal: (e) => e.name === "stop" && e.ok === true });
    await run(t, 'await Promise.all([tools.first({value:"1"}), tools.stop({value:"2"}), tools.last({value:"3"})]);');
    expect(order).toEqual(["first", "first-end", "stop"]);
  });

  test("checks withdrawn tools at dispatch and honors after-tool stop", async () => {
    let allowed: AgentTool<any>[] = [];
    let later = 0;
    allowed = [tool("withdraw", async () => { allowed = []; return ok("withdrawn"); }), tool("later", async () => { later++; return ok("bad"); })];
    const t = createCodeModeTool({ getTools: () => allowed });
    expect((await run(t, 'await Promise.all([tools.withdraw({value:""}), tools.later({value:""})]);')).isError).toBe(true);
    expect(later).toBe(0);
    const stopping = createCodeModeTool({ getTools: () => [tool("later", async () => { later++; return ok("done"); })], onAfterTool: () => true });
    await run(stopping, 'await Promise.all([tools.later({value:""}), tools.later({value:""})]);');
    expect(later).toBe(1);
  });

  test("bounds CPU, memory, unresolved promises, calls and output", async () => {
    const t = createCodeModeTool({ getTools: () => [tool("echo", async () => ok("ok"))], limits: { cpuMs: 20, wallMs: 80, memoryBytes: 4 * 1024 * 1024, calls: 2, outputChars: 100 } });
    for (const code of ['while(true) {}', 'new ArrayBuffer(64 * 1024 * 1024);', 'await new Promise(()=>{});', 'await tools.echo({value:""}); await tools.echo({value:""}); await tools.echo({value:""});', 'async function spin(){await Promise.resolve(); return spin();} await spin();']) {
      expect((await run(t, code)).isError).toBe(true);
    }
    const clipped = await run(t, 'text("x".repeat(1000));');
    expect(output(clipped)).toContain("[output truncated]");
    expect(output(clipped).length).toBeLessThan(200);
    expect((await run(t, 'text("next isolate works");')).isError).not.toBe(true);
  });

  test("reports async exceptions and does not share cell globals", async () => {
    const t = createCodeModeTool({ getTools: () => [] });
    expect((await run(t, 'await Promise.resolve(); throw new Error("async failure");')).isError).toBe(true);
    await run(t, 'globalThis.saved = 42;');
    expect(output(await run(t, 'text(typeof saved);'))).toContain("undefined");
  });

  test("cyclic arguments and import attempts cannot acquire host capabilities", async () => {
    let calls = 0;
    const t = createCodeModeTool({ getTools: () => [tool("echo", async () => { calls++; return ok("bad"); })] });
    expect((await run(t, 'const p={}; p.value=p; await tools.echo(p);')).isError).toBe(true);
    expect((await run(t, 'await import("node:fs");')).isError).toBe(true);
    expect(calls).toBe(0);
  });

  test("handles original tool errors without rewriting them as successful results", async () => {
    const events: boolean[] = [];
    const t = createCodeModeTool({ getTools: () => [tool("failure", async () => ({ ...ok("declined"), isError: true }))], onToolEnd: (e) => events.push(e.ok!) });
    const result = await run(t, 'const result=await tools.failure({value:""}); text(result.isError); text(result.content);');
    expect(output(result)).toContain("true");
    expect(output(result)).toContain("declined");
    expect(events).toEqual([false]);
  });

  test("unawaited calls settle before return and a synchronous failure suppresses queued calls", async () => {
    let calls = 0;
    const t = createCodeModeTool({ getTools: () => [tool("echo", async () => { await Promise.resolve(); calls++; return ok("done"); })] });
    await run(t, 'tools.echo({value:""});');
    expect(calls).toBe(1);
    expect((await run(t, 'tools.echo({value:""}); throw new Error("stop");')).isError).toBe(true);
    expect(calls).toBe(1);
  });

  test("cancellation drains in-flight tools and skips queued side effects before returning", async () => {
    const controller = new AbortController();
    let finished = false, later = false;
    const t = createCodeModeTool({ getTools: () => [tool("waiting", async (_id, _p, signal) => {
      await new Promise<void>((resolve) => { signal!.addEventListener("abort", () => { finished = true; resolve(); }, { once: true }); });
      return ok("stopped");
    }), tool("later", async () => { later = true; return ok("bad"); })] });
    const pending = run(t, 'await Promise.all([tools.waiting({value:""}), tools.later({value:""})]);', controller.signal);
    setTimeout(() => controller.abort("cancel"), 30);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(finished).toBe(true);
    expect(later).toBe(false);
  });
});
