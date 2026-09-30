import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bundledManifest from "../../evals/manifest.json";
import { buildEvalsManifest, verifyEvalsManifest } from "../../src/evals/manifest";

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "kiln-manifest-"));
  mkdirSync(join(home, "evals", "seeds", "dev"), { recursive: true });
  writeFileSync(join(home, "evals", "README.md"), "rubric\n");
  writeFileSync(join(home, "evals", "seeds", "dev", "one.md"), "seed bytes\n");
  const manifest = buildEvalsManifest(home, { generatedAt: "2026-09-05T00:00:00.000Z" });
  writeFileSync(join(home, "evals", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return home;
}

describe("eval manifest", () => {
  test("hashes exact covered files and ignores the three mutable verdict locations", () => {
    const home = fixture();
    expect(verifyEvalsManifest(home)).toEqual({ ok: true, changed: [], missing: [], extra: [] });
    mkdirSync(join(home, "evals", "calibration"));
    writeFileSync(join(home, "evals", "calibration.json"), "{}\n");
    writeFileSync(join(home, "evals", "calibration", "run.jsonl"), "{}\n");
    writeFileSync(join(home, "evals", "effort.json"), "{}\n");
    expect(verifyEvalsManifest(home)).toEqual({ ok: true, changed: [], missing: [], extra: [] });
  });

  test("reports changed, missing, extra, and symlink material deterministically", () => {
    const changed = fixture();
    writeFileSync(join(changed, "evals", "README.md"), "changed\n");
    expect(verifyEvalsManifest(changed).changed).toEqual(["README.md"]);

    const extra = fixture();
    writeFileSync(join(extra, "evals", "extra.md"), "extra\n");
    expect(verifyEvalsManifest(extra).extra).toEqual(["extra.md"]);

    const missing = fixture();
    unlinkSync(join(missing, "evals", "README.md"));
    expect(verifyEvalsManifest(missing).missing).toEqual(["README.md"]);

    const linked = fixture();
    symlinkSync(join(linked, "evals", "README.md"), join(linked, "evals", "linked.md"));
    expect(verifyEvalsManifest(linked).extra).toEqual(["linked.md"]);
  });

  test("rejects a symlink in place of expected material and a symlinked manifest", () => {
    const home = fixture();
    const target = join(home, "target.md");
    writeFileSync(target, "seed bytes\n");
    const expected = join(home, "evals", "seeds", "dev", "one.md");
    unlinkSync(expected);
    symlinkSync(target, expected);
    expect(verifyEvalsManifest(home).changed).toEqual(["seeds/dev/one.md"]);

    const manifestLink = fixture();
    const manifest = join(manifestLink, "evals", "manifest.json");
    const manifestTarget = join(manifestLink, "manifest-copy.json");
    writeFileSync(manifestTarget, readFileSync(manifest));
    unlinkSync(manifest);
    symlinkSync(manifestTarget, manifest);
    expect(verifyEvalsManifest(manifestLink)).toEqual({ ok: false, changed: ["manifest.json"], missing: [], extra: [] });
  });
});

function legacyFixture(version = "0.1.0") {
  const home = mkdtempSync(join(tmpdir(), "kiln-legacy-manifest-"));
  for (const file of Object.keys(bundledManifest.files)) {
    const target = join(home, "evals", file);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(new URL(`../../evals/${file}`, import.meta.url), target);
  }
  const manifest = { ...structuredClone(bundledManifest), kilnVersion: version };
  const path = join(home, "evals", "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return { home, manifest, path };
}

test("accepts only the unchanged legacy corpus without rewriting its manifest or files", () => {
  const { home, path } = legacyFixture();
  const before = readFileSync(path), modified = statSync(path).mtimeMs;
  expect(verifyEvalsManifest(home)).toEqual({ ok: true, changed: [], missing: [], extra: [] });
  expect(readFileSync(path)).toEqual(before);
  expect(statSync(path).mtimeMs).toBe(modified);
  writeFileSync(join(home, "evals", "README.md"), "changed legacy corpus");
  expect(verifyEvalsManifest(home)).toEqual({ ok: false, changed: ["README.md"], missing: [], extra: [] });
});

test("legacy compatibility rejects changed, removed, added digest mappings and unknown versions", () => {
  const mutations = [
    (m: ReturnType<typeof legacyFixture>["manifest"]) => { m.files["README.md"] = "0".repeat(64); },
    (m: ReturnType<typeof legacyFixture>["manifest"]) => { delete (m.files as Record<string, string>)["README.md"]; },
    (m: ReturnType<typeof legacyFixture>["manifest"]) => { (m.files as Record<string, string>)["extra.md"] = "0".repeat(64); },
    (m: ReturnType<typeof legacyFixture>["manifest"]) => { m.kilnVersion = "0.0.9"; },
  ];
  for (const mutate of mutations) {
    const { home, manifest, path } = legacyFixture(); mutate(manifest);
    writeFileSync(path, JSON.stringify(manifest));
    expect(verifyEvalsManifest(home)).toEqual({ ok: false, changed: ["manifest.json"], missing: [], extra: [] });
  }
});


test("0.1.2 accepts both known unchanged home versions and the shipped corpus", () => {
  for (const version of ["0.1.0", "0.1.1"]) {
    const { home, path } = legacyFixture(version);
    const before = readFileSync(path);
    expect(verifyEvalsManifest(home).ok).toBe(true);
    expect(readFileSync(path)).toEqual(before);
    const manifest = JSON.parse(before.toString());
    manifest.files["README.md"] = "0".repeat(64);
    writeFileSync(path, JSON.stringify(manifest));
    expect(verifyEvalsManifest(home).ok).toBe(false);
  }
  expect(verifyEvalsManifest(new URL("../../", import.meta.url).pathname).ok).toBe(true);
});

test("shipped CLI and plugin release versions agree with package metadata", async () => {
  const { default: pkg } = await import("../../package.json");
  const { VERSION } = await import("../../src/cli/main");
  expect(VERSION).toBe(pkg.version);
  const site = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  expect(site).toContain(`class="version">v${pkg.version}</a>`);
  expect(site).toContain(`Documentation · v${pkg.version}`);
  for (const kind of [".claude-plugin", ".codex-plugin"]) {
    const plugin = JSON.parse(readFileSync(new URL(`../../plugins/kiln/${kind}/plugin.json`, import.meta.url), "utf8"));
    expect(plugin.version).toBe(pkg.version);
  }
});
