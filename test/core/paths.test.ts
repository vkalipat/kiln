import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, candidatePath, kilnHome, writeAtomic } from "../../src/core/paths";

describe("paths", () => {
  test("KILN_HOME overrides", () => {
    process.env.KILN_HOME = "/tmp/kh";
    expect(kilnHome()).toBe("/tmp/kh");
    delete process.env.KILN_HOME;
    expect(kilnHome().endsWith("/.kiln")).toBe(true);
  });
  test("writeAtomic and appendLine", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    writeAtomic(join(d, "a.txt"), "one");
    appendLine(join(d, "log.jsonl"), '{"a":1}');
    appendLine(join(d, "log.jsonl"), '{"a":2}');
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one");
    expect(readFileSync(join(d, "log.jsonl"), "utf8")).toBe('{"a":1}\n{"a":2}\n');
  });
  test("writeAtomic honors mode from the first byte written and leaves no temp file", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = join(d, "secret.json");
    writeAtomic(p, "{}", { mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  test("writeAtomic re-applies mode when overwriting an existing world-readable file", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = join(d, "secret.json");
    writeFileSync(p, "old", { mode: 0o644 });
    writeAtomic(p, "new", { mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf8")).toBe("new");
  });
  test("writeAtomic unlinks the temp file when the rename fails", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = join(d, "occupied");
    mkdirSync(p);
    writeFileSync(join(p, "child"), "x"); // non-empty: rename onto it must fail
    expect(() => writeAtomic(p, "text")).toThrow();
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("appendLine after a torn write", () => {
  test("starts a fresh line when the file does not end in a newline", () => {
    const d = mkdtempSync(join(tmpdir(), "kiln-"));
    const p = join(d, "log.jsonl");
    appendLine(p, '{"a":1}');
    writeFileSync(p, '{"torn', { flag: "a" }); // crash mid-append, no trailing newline
    appendLine(p, '{"a":2}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n{"torn\n{"a":2}\n');
  });
});

describe("candidatePath", () => {
  test("names the run's playbook-delta candidate under evolution/candidates", () => {
    expect(candidatePath("/home/k", "20260904-120000-abcd")).toBe(join("/home/k", "evolution", "candidates", "20260904-120000-abcd.json"));
  });
});
