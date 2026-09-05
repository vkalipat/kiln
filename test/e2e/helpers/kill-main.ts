import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import { main } from "../../../src/cli/main";
import type { Role } from "../../../src/core/config";

type MockContext = {
  systemPrompt?: string[];
  messages?: Array<{ role?: string; content?: unknown }>;
};

function appendMarker(path: string, value: string): void {
  appendFileSync(path, `${value}\n`, { encoding: "utf8", flush: true });
}

function featureId(context: MockContext): "f01" | "f02" {
  // Model-practices A1 appends each new contract as a user turn. Read the latest invocation prompt
  // instead of assuming the contract is rewritten into the system prompt.
  const messages = JSON.stringify(context.messages ?? []);
  const matches = [...messages.matchAll(/Implement exactly (f01|f02):/g)];
  const latest = matches.at(-1)?.[1];
  if (latest === "f01" || latest === "f02") return latest;
  throw new Error("kill helper could not identify the active feature");
}

function hasToolResult(context: MockContext): boolean {
  return (context.messages ?? []).some((message) => message.role === "toolResult");
}

function mockModels(markerPath: string, mode: "kill" | "resume"): Partial<Record<Role, Model>> {
  const builder = createMockModel({
    id: "kill-builder",
    provider: "producer",
    handler: async (context: MockContext) => {
      const id = featureId(context);
      if (hasToolResult(context)) return { content: ["implemented"] };
      appendMarker(markerPath, `builder:${id}:start`);
      if (mode === "kill" && id === "f02") await new Promise<never>(() => {});
      return {
        content: [{
          type: "toolCall",
          name: "write",
          arguments: { path: `${id}.txt`, content: `${id} completed\n` },
        }],
      };
    },
  } as never);
  const auditor = createMockModel({
    id: "kill-auditor",
    provider: "other",
    handler: async () => ({
      content: [{
        type: "toolCall",
        name: "audit",
        arguments: {
          verified: ["the harness file check passed"],
          claimedUnverified: [],
          regressions: [],
          nextSessionNotes: "continue with the next frozen feature",
          checkQuality: { adequate: true, reason: "the file-existence check directly covers acceptance" },
          verdict: "agree",
        },
      }],
    }),
  } as never);
  const reflector = createMockModel({
    id: "kill-reflector",
    provider: "producer",
    handler: async () => ({ content: ["This run adds no general playbook lesson."] }),
  } as never);
  return { builder: builder as never, auditor: auditor as never, reflector: reflector as never };
}

async function run(): Promise<void> {
  const [home, runId, markerPath, rawMode] = process.argv.slice(2);
  if (!home || !runId || !markerPath || (rawMode !== "kill" && rawMode !== "resume")) {
    throw new Error("usage: bun kill-main.ts HOME RUN_ID MARKERS kill|resume");
  }
  const mode = rawMode;
  if (mode === "kill") {
    // Bun exits after delivering SIGTERM even with a listener. Keep one process in the same
    // detached group alive so the test proves its subsequent SIGKILL reaches the whole group.
    const sentinel = spawn("sh", ["-c", "trap '' TERM\nwhile :; do sleep 1; done"], { stdio: "ignore" });
    sentinel.unref();
    process.on("SIGTERM", () => appendMarker(markerPath, "signal:SIGTERM"));
  }
  appendMarker(markerPath, `worker:${mode}:start`);
  const output: string[] = [];
  const errors: string[] = [];
  const code = await main(
    ["project", "build", runId, "--home", home, "--autonomous", "--yes", "--json"],
    { write: (text) => output.push(text), error: (text) => errors.push(text) },
    {
      streamFn: streamMock as never,
      models: mockModels(markerPath, mode),
      apiKeyFor: async (provider) => provider === "producer" || provider === "other" ? "mock-key" : undefined,
      fetchUsage: async () => ({ used: 0, limit: 1 }),
    },
  );
  appendMarker(markerPath, `worker:${mode}:exit:${code}`);
  if (output.length > 0) process.stdout.write(output.join(""));
  if (errors.length > 0) process.stderr.write(errors.join(""));
  process.exitCode = code;
}

if (import.meta.main) {
  await run();
}
