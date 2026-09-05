import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { main } from "../src/cli/main";

describe("cli", () => {
  test("--version prints a version and exits 0", async () => {
    const out: string[] = [];
    const code = await main(["--version"], { write: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^kiln \d+\.\d+\.\d+/);
  });

  test("the declared bin is directly executable and reaches main", () => {
    const result = spawnSync(join(import.meta.dir, "..", "bin", "kiln.ts"), ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^kiln \d+\.\d+\.\d+/);
  });
});
