import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { initHome } from "../../src/core/home";
import { createRun, runPaths } from "../../src/core/run";
import { createMockModel } from "@oh-my-pi/pi-ai";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const value = mkdtempSync(join(tmpdir(), "kiln-operator-id-")); homes.push(value); initHome(value); return value; }

test("operator run IDs are explicit and repeated launches cannot overwrite or dispatch twice", async () => {
  const h = home(); let calls = 0;
  const model = createMockModel({ id: "unused", responses: [] });
  const deps = { brainModel: model, apiKeyFor: async () => "test", runFrame: async () => { calls++; return { outcome: "ok" as const }; } };
  const out: string[] = []; const io = { write: (s: string) => out.push(s), error: (s: string) => out.push(s) };
  const args = ["run", "new", "seed", "--id", "operator-demo", "--home", h, "--through", "frame", "--json"];
  expect(await main(args, io, deps)).toBe(0);
  const run = runPaths(h, "operator-demo"); const seed = readFileSync(run.seed, "utf8"); const record = readFileSync(run.record, "utf8");
  expect(await main(args, io, deps)).toBe(2); expect(calls).toBe(1);
  expect(readFileSync(run.seed, "utf8")).toBe(seed); expect(readFileSync(run.record, "utf8")).toBe(record);
  expect(out.join("")).toContain("already exists");
});

test("exclusive reservation refuses an existing directory before writing state", () => {
  const h = home(); const run = createRun(h, "original", { id: "operator-once", exclusive: true });
  expect(() => createRun(h, "replacement", { id: "operator-once", exclusive: true })).toThrow();
  expect(readFileSync(run.seed, "utf8")).toBe("original\n");
  expect(() => createRun(h, "bad", { id: "../outside", exclusive: true })).toThrow("invalid run id");
});

test("invalid or resume-only IDs fail before any phase work", async () => {
  const h = home(); const io = { write: () => {} }; let calls = 0;
  const deps = { runFrame: async () => { calls++; return { outcome: "ok" as const }; } };
  for (const id of ["../escape", "/absolute", "a/b", "a".repeat(129)]) {
    expect(await main(["run", "new", "seed", "--id", id, "--home", h], io, deps)).toBe(2);
  }
  expect(readdirSync(join(h, "runs"))).toEqual([]); expect(calls).toBe(0);
});
