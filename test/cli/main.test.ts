import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../../src/cli/main";
import { initHome } from "../../src/core/home";

describe("parseArgs", () => {
  test("splits commands and flags", () => {
    expect(parseArgs(["run", "new", "seed text", "--json", "--out=/x", "--through", "frame"])).toEqual({ cmd: ["run", "new", "seed text"], flags: { json: true, out: "/x", through: "frame" } });
  });
});
describe("main", () => {
  test("bare kiln launches the TUI without starting a model run", async () => {
    const launches: Array<{ home: string; runId?: string }> = [];
    expect(await main([], { write: () => {} }, { launchTui: async (options) => { launches.push(options); } })).toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.runId).toBeUndefined();
  });
  test("bare kiln retains the TUI's non-interactive guard", async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    const errors: string[] = [];
    expect(await main([], { write: () => {}, error: (text) => errors.push(text) })).toBe(2);
    expect(errors.join("")).toContain("interactive terminal");
  });
  test("unknown command exits 2", async () => {
    const err: string[] = [];
    expect(await main(["bogus"], { write: () => {}, error: (s) => err.push(s) })).toBe(2);
    expect(err.join("")).toMatch(/unknown command/);
    expect(err.join("")).toContain("kiln project");
  });
  test("run new with no providers exits 3 with a hint", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    const err: string[] = [];
    const code = await main(["run", "new", "x", "--home", home], { write: () => {}, error: (s) => err.push(s) }, { apiKeyFor: async () => undefined });
    expect(code).toBe(3); expect(err.join("")).toMatch(/kiln auth login/);
  });
  test("dispatches read-only eval verify and leakcheck", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home);
    for (const action of ["verify", "leakcheck"]) {
      const out: string[] = [];
      expect(await main(["evals", action, "--home", home, "--json"], { write: (text) => out.push(text) })).toBe(0);
      expect(JSON.parse(out.join("")).ok).toBe(true);
    }
  });
  test("forwards embedded dependencies to paid eval runners", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-")); initHome(home); let calls = 0; const out: string[] = [];
    expect(await main(["evals", "m1", "--home", home, "--budget", "1000", "--rounds", "1", "--json"], { write: (text) => out.push(text) }, {
      evals: { runM1: async () => { calls++; return { status: "complete", comparisons: [] } as never; } },
    })).toBe(0);
    expect(calls).toBe(1); expect(JSON.parse(out.join("")).status).toBe("complete");
  });
  test("dispatches operator apply usage without entering provider work", async () => {
    const errors: string[] = [];
    expect(await main(["evolve", "apply", "--op", "add"], { write: () => {}, error: (text) => errors.push(text) })).toBe(2);
    expect(errors.join("")).toContain("--op edit|retire");
  });
});
