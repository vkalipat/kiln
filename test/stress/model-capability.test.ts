import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import type { Model } from "@oh-my-pi/pi-catalog";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { readStatus, runPaths } from "../../src/core/run";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model capability admission", () => {
  test("an injected text-only model is rejected before a tool-bearing stream and leaves no false running state", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-stress-tool-capability-"));
    roots.push(root);
    const home = join(root, ".kiln");
    initHome(home);
    let modelCalls = 0;
    const base = createMockModel({ id: "text-only", provider: "mock-text", handler: () => {
      modelCalls += 1;
      return { content: ["I cannot call tools."] };
    } } as never);
    const model = { ...base, supportsTools: false } as Model;
    const output: string[] = [];

    const code = await main([
      "run", "new", "Create a bounded utility concept", "--id", "stress-text-only", "--through", "frame", "--home", home, "--json",
    ], { write: (text) => output.push(text), error: (text) => output.push(text) }, {
      brainModel: model,
      streamFn: streamMock as never,
      apiKeyFor: async () => "provider-free-stress",
    });

    expect(code).not.toBe(0);
    expect(modelCalls).toBe(0);
    expect(output.join("").toLowerCase()).toMatch(/tool|compatible|support/);
    const ids = existsSync(join(home, "runs")) ? readdirSync(join(home, "runs")) : [];
    if (ids.includes("stress-text-only")) expect(readStatus(runPaths(home, "stress-text-only")).state).not.toBe("running");
  }, 10_000);
});
