import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { writeStatus } from "../../src/core/run";

test("a fresh bio run immediately discloses an unavailable Astra preference without dispatching it", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-workflow-bio-preference-"));
  initHome(home, { plugAndPlay: true });
  const output: string[] = [];
  const code = await main(["run", "new", "Research computational approaches for the Virtual Cell Challenge", "--home", home, "--through", "frame"], {
    write: (text) => output.push(text),
  }, {
    apiKeyFor: async (provider) => provider === "anthropic" ? "synthetic" : undefined,
    runFrame: async (deps) => { writeStatus(deps.run, { phase: "discover" }); return { outcome: "ok" }; },
  });
  expect(code).toBe(0);
  expect(output.join("")).toContain("Workload model preference (unavailable)");
  expect(output.join("")).toContain("openai-codex is not connected");
  expect(output.join("")).toContain("Astra was not used");
});
