import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { main } from "../../src/cli/main";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";
import { readStatus, runPaths } from "../../src/core/run";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// This verifies orchestration and durable boundaries, not provider output quality.
describe("plug-and-play budget boundaries across benign use cases", () => {
  test.each([
    ["business", "Research scheduling software opportunities for independent repair shops"],
    ["software", "Build a local command-line utility that counts words in text files"],
    ["literature", "Summarize published literature on urban tree canopy and summer shade"],
  ])("%s never dispatches a provider at zero budget, including repeated resume", async (industry, seed) => {
    const home = mkdtempSync(join(tmpdir(), `kiln-plug-play-${industry}-`));
    roots.push(home);
    initHome(home);
    const config = defaultConfig();
    config.budgets.usd = 0;
    saveConfig(home, config);
    let calls = 0;
    const model = createMockModel({ id: "budget-boundary", handler: async (context: { systemPrompt?: string[] }) => {
      calls += 1;
      const target = /Output file: (\S+)/.exec((context.systemPrompt ?? []).join("\n"))?.[1];
      if (target && !existsSync(target)) return { content: [{ type: "toolCall", name: "write", arguments: {
        path: target,
        content: `# Brief\n\n## Problem\n${seed}\n\n## Constraints\n- use local fixture evidence only\n\n## Search success\n- an inspectable result\n\n## Non-goals\n- hosted deployment\n\n## Shape\nproduct\n\n## Axes\n- audience: researcher | operator | developer\n\n## Discovery questions\n- What can be verified locally?\n- Which evidence would falsify the proposed result?\n`,
      } }] };
      return { content: ["done"] };
    } } as never);
    const deps = { brainModel: model as never, streamFn: streamMock as never, apiKeyFor: async () => "mock-only" };
    const id = `zero-${industry}`;
    const invoke = async (args: string[]) => {
      const output: string[] = [];
      const errors: string[] = [];
      const code = await main([...args, "--home", home, "--json", "--yes"], {
        write: (value) => output.push(value), error: (value) => errors.push(value),
      }, deps);
      expect(errors).toEqual([]);
      expect({ code, output: code === 0 ? "" : output.join("") }).toEqual({ code: 0, output: "" });
      return JSON.parse(output.join(""));
    };
    await invoke(["run", "new", seed!, "--id", id]);
    const run = runPaths(home, id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(readStatus(run)).toMatchObject({ phase: "frame", state: "stopped", outcome: { kind: "stopped", stopKind: "budget" } });
      await invoke(["run", "resume", id]);
    }
    expect(calls).toBe(0);
    expect(existsSync(run.brief)).toBe(false);
    const events = new RunRecord(run.record).read();
    expect(events.filter((event) => event.t === "run.created")).toHaveLength(1);
    expect(events.filter((event) => event.t === "model.call")).toHaveLength(0);
    expect(events.filter((event) => event.t === "tool.call")).toHaveLength(0);
    expect(readStatus(run)).toMatchObject({ state: "stopped", outcome: { stopKind: "budget" } });
    config.budgets.usd = 5;
    saveConfig(home, config);
    await invoke(["run", "resume", id, "--through", "frame"]);
    expect(calls).toBe(1); // The validated artifact write ends frame without a narration call.
    expect(existsSync(run.brief)).toBe(true);
    expect(readStatus(run)).toMatchObject({ state: "running" });
    expect(new RunRecord(run.record).read().filter((event) => event.t === "phase.end" && event.phase === "frame" && event.outcome === "ok")).toHaveLength(1);
  }, 15_000);
});
