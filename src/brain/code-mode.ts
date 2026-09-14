import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";

export interface CodeModeToolEvent {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: AgentToolResult<any>;
  ok?: boolean;
}
export interface CodeModeOptions {
  getTools: () => AgentTool<any>[];
  onToolStart?: (event: CodeModeToolEvent) => void;
  onToolEnd?: (event: CodeModeToolEvent) => void;
  onAfterTool?: (event: CodeModeToolEvent) => boolean | void;
  isTerminal?: (event: CodeModeToolEvent) => boolean;
  limits?: Partial<{ memoryBytes: number; cpuMs: number; wallMs: number; calls: number; outputChars: number; inputChars: number; resultChars: number }>;
}
// Allow the existing ten-minute shell maximum plus cleanup overhead. Native tool/phase/run
// deadlines still apply; this cell watchdog must not shorten an otherwise authorized tool call.
const DEFAULTS = { memoryBytes: 16 * 1024 * 1024, cpuMs: 1_000, wallMs: 660_000, calls: 64, outputChars: 32_000, inputChars: 128_000, resultChars: 1_000_000 };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A fresh WASM heap per cell. The only host capabilities are the supplied, rechecked tools. */
export function createCodeModeTool(options: CodeModeOptions): AgentTool<any> {
  const limits = { ...DEFAULTS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid code-mode limit ${key}`);
  return {
    name: "exec", label: "Execute JavaScript", intent: "omit", concurrency: "exclusive",
    customFormat: { syntax: "lark", definition: "start: SOURCE\nSOURCE: /[\\s\\S]+/" },
    description: "Execute a fresh isolated JavaScript cell. Await tools.<name>(JSON arguments) to use the available tools; text(value) emits results. Tool results contain content and isError. Nested actions run serially, including Promise.all. No filesystem, network or process APIs exist except supplied tools. No globals survive cells. Terminal decisions suppress later actions. Print only useful findings; output is bounded.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    async execute(cellId, params: { input: string }, externalSignal, _onUpdate, context) {
      const failure = (message: string) => ({ content: [{ type: "text" as const, text: `Code-mode error: ${message}` }], isError: true });
      if (typeof params.input !== "string" || params.input.length > limits.inputChars) return failure("cell source exceeds input limit or is not a string");
      if (externalSignal?.aborted) return failure("cancelled before execution");
      const module = await getQuickJS();
      if (externalSignal?.aborted) return failure("cancelled before execution");
      const runtime = module.newRuntime();
      runtime.setMemoryLimit(limits.memoryBytes);
      runtime.setMaxStackSize(256 * 1024);
      const vm = runtime.newContext();
      const abort = new AbortController();
      const cancel = () => abort.abort(externalSignal?.reason ?? new Error("code-mode cancelled"));
      externalSignal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => abort.abort(new Error("code-mode wall limit exceeded")), limits.wallMs);
      let cpuMs = 0, sliceStart = performance.now(), calls = 0, dispatched = 0, pending = 0, terminal = false, closing = false;
      let output = "", truncated = false, error: string | undefined;
      let queue = Promise.resolve();
      const deferred: QuickJSDeferredPromise[] = [];
      let promise: QuickJSHandle | undefined;
      const slice = <T>(fn: () => T): T => {
        sliceStart = performance.now();
        try { return fn(); } finally { cpuMs += performance.now() - sliceStart; }
      };
      runtime.setInterruptHandler(() => abort.signal.aborted || cpuMs + performance.now() - sliceStart > limits.cpuMs);
      const emit = (text: string) => {
        const remaining = limits.outputChars - output.length;
        if (text.length + 1 > remaining) truncated = true;
        output += `${text}\n`.slice(0, Math.max(0, remaining));
      };
      try {
        const bridge = vm.newFunction("invoke", (nameHandle, argsHandle) => {
          const number = ++calls;
          if (number > limits.calls) throw new Error("code-mode tool-call limit exceeded");
          const name = vm.getString(nameHandle), json = vm.getString(argsHandle);
          if (json.length > limits.inputChars) throw new Error("tool arguments exceed bridge limit");
          const task = vm.newPromise();
          deferred.push(task);
          pending += 1;
          queue = queue.then(async () => {
            try {
              if (abort.signal.aborted) throw new Error("queued tool suppressed after cancellation");
              if (terminal) {
                const value = vm.newString(JSON.stringify({ content: [{ type: "text", text: "Tool suppressed after terminal decision." }], isError: true }));
                try { task.resolve(value); } finally { value.dispose(); }
                return;
              }
              if (closing || cpuMs > limits.cpuMs) throw new Error("queued tool suppressed after stop or resource limit");
              const tool = options.getTools().find((candidate) => candidate.name === name && name !== "exec");
              if (!tool) throw new Error(`tool is unavailable: ${name}`);
              const id = `${cellId}:${number}`;
              const args = validateToolArguments(tool, { type: "toolCall", id, name, arguments: JSON.parse(json) });
              const event: CodeModeToolEvent = { toolCallId: id, name, args };
              options.onToolStart?.(event);
              dispatched += 1;
              let result: AgentToolResult<any>;
              try { result = await tool.execute(id, args, abort.signal, undefined, context); }
              catch (e) { result = { content: [{ type: "text", text: errorText(e) }], isError: true }; }
              const completed = { ...event, result, ok: result.isError !== true };
              options.onToolEnd?.(completed);
              const stopAfter = options.onAfterTool?.(completed) === true;
              const terminalDecision = options.isTerminal
                ? options.isTerminal(completed) : name === "exit" && completed.ok;
              terminal = stopAfter || terminalDecision;
              const serialized = JSON.stringify(result);
              if (serialized.length > limits.resultChars) throw new Error("tool result exceeds bridge limit; request a smaller result");
              const value = vm.newString(serialized);
              try { task.resolve(value); } finally { value.dispose(); }
            } catch (e) {
              // A host/validation failure must not be hidden by a later queued terminal action.
              // Original tool isError results remain data; bridge failures end this cell.
              error ??= errorText(e);
              closing = true;
              const value = vm.newError(errorText(e));
              try { task.reject(value); } finally { value.dispose(); }
            } finally { pending -= 1; }
          }).catch((e) => {
            // Even failure to allocate a guest rejection must not strand a live queue or heap.
            error ??= errorText(e);
            closing = true;
            abort.abort(e);
          });
          return task.handle;
        });
        const print = vm.newFunction("print", (value) => { emit(vm.getString(value)); });
        vm.setProp(vm.global, "__invoke", bridge);
        vm.setProp(vm.global, "__print", print);
        bridge.dispose(); print.dispose();
        const names = options.getTools().map((tool) => tool.name).filter((name) => name !== "exec");
        const setup = slice(() => vm.evalCode(`(() => {
          const invoke = __invoke, print = __print, stringify = JSON.stringify, parse = JSON.parse;
          delete globalThis.__invoke; delete globalThis.__print;
          const tools = Object.create(null);
          for (const name of ${JSON.stringify(names)}) tools[name] = async (args) => {
            const json = stringify(args);
            if (json === undefined) throw new Error("tool arguments must be JSON");
            return parse(await invoke(name, json));
          };
          Object.defineProperty(globalThis, "tools", {value: Object.freeze(tools)});
          Object.defineProperty(globalThis, "text", {value: (value) => print(typeof value === "string" ? value : stringify(value) ?? String(value))});
        })()`));
        vm.unwrapResult(setup).dispose();
        promise = slice(() => vm.unwrapResult(vm.evalCode(`(async () => {\n${params.input}\n})()`, "cell.js")));
        for (;;) {
          if (abort.signal.aborted) throw abort.signal.reason;
          if (error) throw new Error(error);
          // A completed terminal action ends the cell before guest continuations can issue more
          // effects (or spin). The finally block drains already queued host work before disposal.
          if (terminal) break;
          if (cpuMs > limits.cpuMs) throw new Error("code-mode CPU limit exceeded");
          const jobs = slice(() => runtime.executePendingJobs(128));
          if (jobs.error) { const message = vm.dump(jobs.error); jobs.error.dispose(); throw new Error(JSON.stringify(message)); }
          const state = vm.getPromiseState(promise);
          if (state.type === "rejected") { const message = vm.dump(state.error); state.error.dispose(); throw new Error(JSON.stringify(message)); }
          if (state.type === "fulfilled") {
            state.value.dispose();
            if (pending === 0) break;
          }
          // Yield for host tools and deadline/cancellation delivery; all guest jobs remain bounded.
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      } catch (e) {
        error = errorText(e);
      } finally {
        closing = true;
        if (!terminal) abort.abort(new Error("cell finished"));
        // Existing tool adapters must honor cancellation. Never dispose or return while one is active.
        await queue;
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", cancel);
        promise?.dispose();
        for (const task of deferred) task.dispose();
        vm.dispose(); runtime.dispose();
      }
      if (error) emit(`Code-mode error: ${error}`);
      return { content: [{ type: "text", text: `${output}${truncated ? "\n[output truncated]" : ""}` || (terminal ? "Terminal tool completed; remaining actions suppressed." : "Cell completed without text output.") }],
        isError: error !== undefined, details: { codeMode: { calls, dispatched, truncated, terminal, cpuMs, ...(error ? { error } : {}) } } };
    },
  };
}
