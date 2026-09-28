import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";

test("public memory status dispatch stays local and does not initialize a model home", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-memory-entry-"));
  const oldHome = process.env.KILN_HOME;
  const home = join(root, "unused-model-home");
  let output = "", calls = 0;
  process.env.KILN_HOME = home;
  try {
    const result = await main(["memory", "status", "--url", "http://127.0.0.1:8888", "--bank", "test-project", "--json"],
      { write: text => { output += text; } }, { fetchImpl: (async () => { calls++; throw new Error("unexpected network"); }) as unknown as typeof fetch });
    expect(result).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ configured: true, serviceChecked: false, automaticRetention: false, bank: "test-project" });
    expect(calls).toBe(0);
    expect(existsSync(home)).toBe(false);
  } finally {
    if (oldHome === undefined) delete process.env.KILN_HOME; else process.env.KILN_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("public route advisor parses flags, returns a local fallback, and never dispatches", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-route-entry-"));
  let output = "", calls = 0;
  try {
    expect(await main(["model", "suggest", "Implement a parser", "--step", "implement", "--home", home, "--json"],
      { write: text => { output += text; } }, {
        authStoreFactory: (() => ({ configuredProviders: () => [] })) as never,
        fetchImpl: (async () => { calls++; throw new Error("unexpected network"); }) as unknown as typeof fetch,
      })).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ advisory: true, decision: { choice: "implement", source: "fallback", reason: "disabled" }, route: null });
    expect(calls).toBe(0);
    output = "";
    expect(await main(["model", "suggest", "Implement a parser", "--jve", "--home", home], { write: text => { output += text; } })).toBe(2);
    expect(output).toContain("usage:");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
