import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeSuggestCommand } from "../../src/cli/commands/route-suggest";
import type { AuthStore } from "../../src/providers/auth";
test("default advisor is local-only and does not expose input or authorize a dispatch", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-suggest-")); let out = "";
  try {
    const code = await routeSuggestCommand(["private supplied summary"], { home, step: "implement", json: true }, { write: s => out += s }, {
      authStoreFactory: () => ({ configuredProviders: () => [] }) as unknown as AuthStore,
      fetchImpl: (() => { throw new Error("unexpected request"); }) as unknown as typeof fetch,
    });
    expect(code).toBe(0); expect(out).not.toContain("private supplied summary");
    expect(JSON.parse(out)).toMatchObject({ advisory: true, route: null, decision: { choice: "implement", reason: "disabled" } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("review is excluded because advisor has no actual producer context", async () => {
  let out = "";
  expect(await routeSuggestCommand(["Review change"], { step: "review" }, { write: s => out += s })).toBe(2);
  expect(out).toContain("explicit producer");
});
test("misspelled opt-in and inapplicable flags are rejected", async () => {
  for (const flags of [{ jve: true }, { producer: "unverified" }, { home: true }] as Record<string, string | boolean>[]) {
    expect(await routeSuggestCommand(["task"], flags, { write: () => {} })).toBe(2);
  }
});
test("explicit Jev opt-in classifies one step and returns an admitted model without dispatch", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-suggest-")); let out = "", calls = 0;
  const originalKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  try {
    const code = await routeSuggestCommand(["Implement a bounded feature"], { home, jev: true, json: true }, { write: s => out += s }, {
      authStoreFactory: () => ({ configuredProviders: () => ["anthropic", "openai"] }) as unknown as AuthStore,
      fetchImpl: (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        calls++;
        const payload = JSON.parse(init!.body as string);
        expect(Object.keys(payload.questions.route.criteria)).not.toContain("review");
        return Response.json({ model: "jev-1.13.0", answers: { route: { type: "choice", choice: "implement", confidence: 0.99,
          probabilities: { research: 0.01, ideate: 0.01, implement: 0.97, synthesize: 0.01 } } } });
      }) as unknown as typeof fetch,
    });
    expect(code).toBe(0); expect(calls).toBe(1);
    const result = JSON.parse(out);
    expect(result.decision).toMatchObject({ choice: "implement", source: "jev" });
    expect(result.route?.role).toBe("builder");
    expect(result.note).toContain("no model was switched or dispatched");
    expect(out).not.toContain("offline-test-key"); expect(out).not.toContain("Implement a bounded feature");
  } finally {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
    rmSync(home, { recursive: true, force: true });
  }
});
