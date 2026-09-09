import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { defaultConfig, loadConfig, saveConfig, type KilnConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { runPaths, writeStatus } from "../../src/core/run";
import { applyFrozenRouting, loadFrozenRouting } from "../../src/workflow/routing";
import { DEFAULT_EVIDENCE_SNAPSHOT } from "../../src/routing/adaptive";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function homeFor(mode: "adaptive" | "manual" = "adaptive") {
  const home = mkdtempSync(join(tmpdir(), "kiln-adaptive-test-")); homes.push(home); initHome(home);
  const cfg = defaultConfig(); cfg.routing = { mode }; saveConfig(home, cfg); return home;
}
const io = () => { const output: string[] = []; return { output, write: (s: string) => output.push(s), error: (s: string) => output.push(s) }; };
const apiKeyFor = async (provider: string) => ["anthropic", "openai-codex"].includes(provider) ? "offline-test-key" : undefined;

describe("adaptive run integration", () => {
  test("new runs consume the imported reviewed snapshot, not only previews", async () => {
    const home = homeFor(); const evidence = structuredClone(DEFAULT_EVIDENCE_SNAPSHOT) as any;
    evidence.id = "reviewed-business-update";
    evidence.rankings.find((r: any) => r.category === "business").entries = [
      { modelRef: "anthropic/claude-opus-5", score: 2000 },
      { modelRef: "anthropic/claude-fable-5-1", score: 1600 },
    ];
    mkdirSync(join(home, "routing"), { recursive: true });
    writeFileSync(join(home, "routing", "benchmarks.json"), JSON.stringify(evidence));
    const out = io(); let generator = "";
    expect(await main(["run", "new", "Find a business idea", "--home", home, "--through", "frame", "--json"], out, {
      apiKeyFor, runFrame: async (d) => { generator = d.cfg.roles.generator[0]!; return { outcome: "ok" }; },
    })).toBe(0);
    expect(generator).toBe("anthropic/claude-opus-5");
    expect(JSON.parse(out.output[0]!).routing.evidence.id).toBe("reviewed-business-update");
  });
  test("plans before the first phase, freezes routing, and resumes without replacing model identities", async () => {
    const home = homeFor(); const out = io(); const original = readFileSync(join(home, "config.json"), "utf8");
    let first: KilnConfig | undefined;
    expect(await main(["run", "new", "Find a business idea", "--home", home, "--through", "frame", "--json"], out, {
      apiKeyFor, runFrame: async (d) => { first = d.cfg; writeStatus(d.run, { phase: "discover" }); return { outcome: "ok" }; },
    })).toBe(0);
    const id = readdirSync(join(home, "runs"))[0]!; const run = runPaths(home, id);
    const frozen = loadFrozenRouting(run)!;
    expect(frozen.version).toBe(1); expect(frozen.roles).toEqual(first!.roles);
    expect(frozen.roles.generator[0]).not.toBe(frozen.roles.judge[0]);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(original);
    const cfg = loadConfig(home); cfg.roles.brain = ["anthropic/claude-opus-4-8"]; cfg.routing = { mode: "manual" }; cfg.budgets.usd += 5; saveConfig(home, cfg);
    let resumed: KilnConfig | undefined;
    expect(await main(["run", "resume", id, "--home", home, "--through", "discover", "--json"], out, {
      apiKeyFor, runDiscover: async (d) => { resumed = d.cfg; writeStatus(d.run, { phase: "ideate" }); return { outcome: "ok" }; },
    })).toBe(0);
    expect(resumed!.roles).toEqual(frozen.roles); expect(resumed!.routing?.mode).toBe("adaptive");
    expect(resumed!.budgets.usd).toBe(cfg.budgets.usd);
    expect(resumed!.budgets.phaseBudgetUsd("ideate")).toBe(cfg.budgets.usd * frozen.share.ideate);
    expect(loadFrozenRouting(run)).toEqual(frozen);
    expect(JSON.parse(out.output[0]!).routing).toBeDefined();
  });

  test("manual runs retain configured models and never gain a frozen adaptive plan", async () => {
    const home = homeFor("manual"); const cfg = loadConfig(home); const out = io();
    expect(await main(["run", "new", "A business concept", "--home", home, "--through", "frame", "--json"], out, {
      apiKeyFor, runFrame: async (d) => { expect(d.cfg.roles).toEqual(cfg.roles); return { outcome: "ok" }; },
    })).toBe(0);
    const run = runPaths(home, readdirSync(join(home, "runs"))[0]!);
    expect(loadFrozenRouting(run)).toBeUndefined(); expect(applyFrozenRouting(cfg, run)).toBe(cfg);
  });

  test("budget-fit failure happens before creating a run or invoking a model phase", async () => {
    const home = homeFor(); const cfg = loadConfig(home); cfg.budgets.usd = 0; saveConfig(home, cfg);
    let calls = 0; const out = io();
    expect(await main(["run", "new", "Find a business idea", "--home", home, "--through", "frame", "--json"], out, {
      apiKeyFor, runFrame: async () => { calls++; return { outcome: "ok" }; },
    })).toBe(3);
    expect(calls).toBe(0); expect(readdirSync(join(home, "runs"))).toEqual([]);
    expect(out.output.join("")).toContain("adaptive routing");
  });
});
