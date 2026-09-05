import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSnapshotPayload, copyExactTree, exactSnapshotStatus, payloadEntries } from "../../src/build/git-snapshot";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("exact snapshot filesystem helpers", () => {
  test("copy and status preserve bytes, executable modes and symlinks while excluding metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-snapshot-helper-"));
    roots.push(root);
    const source = join(root, "source");
    const copy = join(root, "copy");
    mkdirSync(join(source, ".git"), { recursive: true });
    mkdirSync(join(source, ".kiln-scratch"));
    writeFileSync(join(source, ".git", "config"), "metadata");
    writeFileSync(join(source, ".kiln-scratch", "x"), "scratch");
    writeFileSync(join(source, "binary"), Buffer.from([0, 255, 10, 13]));
    writeFileSync(join(source, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(source, "run.sh"), 0o755);
    symlinkSync("binary", join(source, "link"));

    copyExactTree(source, copy);
    const entries = payloadEntries(copy).map((entry) => ({ ...entry, oid: "a".repeat(40) }));
    expect(entries.map((entry) => [entry.path, entry.gitMode])).toEqual([
      ["binary", "100644"], ["link", "120000"], ["run.sh", "100755"],
    ]);
    expect(existsSync(join(copy, ".git"))).toBe(false);
    expect(existsSync(join(copy, ".kiln-scratch"))).toBe(false);
    expect(exactSnapshotStatus(copy, entries)).toBe("");
    assertSnapshotPayload(copy, entries);

    writeFileSync(join(copy, "binary"), "changed");
    expect(exactSnapshotStatus(copy, entries)).toContain(" M binary");
    expect(() => assertSnapshotPayload(copy, entries)).toThrow("payload no longer matches");
  });
});
