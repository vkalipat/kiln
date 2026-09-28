import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogCommand } from "../../src/cli/commands/catalog";
import { main } from "../../src/cli/main";
test("catalog status is offline, identifies unknown freshness and never initializes home", async () => {
  const old = process.env.KILN_HOME, dir = mkdtempSync(join(tmpdir(), "kiln-catalog-")), home = join(dir, "absent"); let out = "";
  process.env.KILN_HOME = home;
  try {
    expect(await main(["model", "catalog", "status", "--json"], { write: s => out += s }, { fetchImpl: (() => { throw new Error("network prohibited"); }) as unknown as typeof fetch })).toBe(0);
    const report = JSON.parse(out); expect(report.freshness).toBe("upstream_not_checked"); expect(report.runtimeAdmissionChanged).toBe(false); expect(report.installed.modelCount).toBeGreaterThan(0); expect(existsSync(home)).toBe(false);
  } finally { if (old === undefined) delete process.env.KILN_HOME; else process.env.KILN_HOME = old; rmSync(dir, { recursive: true, force: true }); }
});
test("failed upstream audit does not claim fresh data", async () => {
  let out = "";
  expect(await catalogCommand(["check"], { json: true }, { write: s => out += s }, { fetchImpl: (async () => new Response("error", { status: 502 })) as unknown as typeof fetch })).toBe(2);
  expect(out).not.toContain("checked_upstream_now"); expect(out).toContain("502");
});
test("typos and refresh/admission flags fail closed", async () => {
  for (const flags of [{ auto: true }, { json: "true" }, { snapshot: true }] as Record<string, string | boolean>[]) {
    expect(await catalogCommand(["check"], flags, { write() {} })).toBe(2);
  }
  expect(await catalogCommand(["refresh"], {}, { write() {} })).toBe(2);
});
