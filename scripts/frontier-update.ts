#!/usr/bin/env bun
/** Dependency-only update bot. This file deliberately imports no installed packages. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, lstat, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";

export const PACKAGES = ["pi-agent-core", "pi-ai", "pi-catalog", "pi-coding-agent", "pi-tui", "pi-utils"].map(name => `@oh-my-pi/${name}`);
export const AUTH_PATCH_SHA256 = "425a835a0f563761f0629172486f47ce5cfed3019a37a298035dbe678b8972c7";
export const SHELL_PATCH_SHA256 = "f032d6c3d67b051d51a0e4a9231f4e71d99573110c1fc3ead6c365965b09c5fd";
const REVIEWED_PATCHES = [
  { name: "@oh-my-pi/pi-ai", label: "Auth", sha256: AUTH_PATCH_SHA256,
    targets: ["src/registry/oauth/types.ts", "dist/types/registry/oauth/types.d.ts", "src/registry/oauth/callback-server.ts"] },
  { name: "@oh-my-pi/pi-coding-agent", label: "Shell", sha256: SHELL_PATCH_SHA256,
    targets: ["src/exec/bash-executor.ts", "src/tools/bash.ts", "dist/types/exec/bash-executor.d.ts", "src/eval/js/context-manager.ts", "src/eval/py/runtime.ts"] },
] as const;
export const GATES = [
  ["bun", "install", "--ignore-scripts", "--registry", "https://registry.npmjs.org"],
  ["bun", "run", "typecheck"], ["bun", "run", "docs:check"], ["bun", "test"],
  ["bun", "bin/kiln.ts", "evals", "verify", "--home", ".", "--json"],
  ["bun", "bin/kiln.ts", "evals", "leakcheck", "--home", ".", "--json"],
] as const;
const REGISTRY = "https://registry.npmjs.org/";
const LIMIT = 8 * 1024 * 1024;
const stable = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split(".").every(part => Number.isSafeInteger(Number(part)));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
class FrontierUpdateError extends Error {}
function fail(message: string): never { throw new FrontierUpdateError(message); }
const compare = (a: string, b: string) => { const aa = a.split(".").map(Number), bb = b.split(".").map(Number); return aa[0]! - bb[0]! || aa[1]! - bb[1]! || aa[2]! - bb[2]!; };
export interface Manifest { dependencies: Record<string, string>; patchedDependencies?: Record<string, string>; [key: string]: unknown }
interface Release { name: string; version: string; deprecated?: string; dist?: { integrity?: string; tarball?: string } }
export interface Packument { name: string; versions: Record<string, Release> }
export interface Plan { current: string; version: string; changed: boolean }
export type Runner = (args: readonly string[], cwd: string, capture?: boolean) => Promise<string>;
export const runCommand: Runner = async (args, cwd, capture = false) => {
  const process = Bun.spawn([...args], { cwd, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: capture ? "ignore" : "inherit" });
  const output = capture ? new Response(process.stdout).text() : Promise.resolve("");
  const [code, text] = await Promise.all([process.exited, output]);
  if (code !== 0) fail(`Command failed: ${args.slice(0, 3).join(" ")}`);
  return text.trim();
};

export async function registryMetadata(name: string, fetchImpl: typeof fetch = fetch): Promise<Packument> {
  if (!PACKAGES.includes(name)) fail("Unexpected registry package");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(REGISTRY + encodeURIComponent(name), { signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/vnd.npm.install-v1+json" } });
    if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > LIMIT) fail("Registry response rejected");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > LIMIT) fail("Registry response too large"); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Packument;
    if (data?.name !== name || !data.versions || typeof data.versions !== "object" || Array.isArray(data.versions)) fail("Invalid registry metadata");
    return data;
  } catch { return fail(`Official npm metadata unavailable or invalid for ${name}`); }
  finally { clearTimeout(timer); }
}

export function selectUpdate(manifest: Manifest, metadata: readonly Packument[]): Plan {
  const pins = PACKAGES.map(name => manifest.dependencies?.[name]);
  if (!pins.every(stable) || new Set(pins).size !== 1) fail("All six native packages must have one identical exact stable pin; aliases and ranges are rejected");
  if (metadata.length !== PACKAGES.length || new Set(metadata.map(item => item.name)).size !== PACKAGES.length) fail("Incomplete registry metadata");
  const documents = PACKAGES.map(name => metadata.find(item => item.name === name) ?? fail("Missing registry package"));
  const versions = Object.keys(documents[0]!.versions).filter(version => stable(version) && documents.every(document => {
    const item = document.versions[version]; if (!item || item.name !== document.name || item.version !== version || item.deprecated) return false;
    try { const url = new URL(item.dist?.tarball ?? ""); return url.origin === REGISTRY.slice(0, -1) && !url.username && !url.password && /^sha512-[A-Za-z0-9+/]{86}==$/.test(item.dist?.integrity ?? ""); }
    catch { return false; }
  })).sort(compare);
  const version = versions.at(-1) ?? fail("No common stable release with official tarballs and integrity metadata");
  const current = pins[0]!;
  if (compare(version, current) < 0) fail("Registry would downgrade the installed release");
  return { current, version, changed: version !== current };
}

export function migrateManifest(manifest: Manifest, plan: Plan): Manifest {
  if (!stable(plan.version) || !stable(plan.current)) fail("Invalid exact update version");
  const patches = { ...manifest.patchedDependencies };
  for (const reviewed of REVIEWED_PATCHES) {
    const key = `${reviewed.name}@${plan.current}`, path = patches[key];
    if (!path || Object.keys(patches).some(other => other.startsWith(`${reviewed.name}@`) && other !== key)) fail(`Expected one reviewed native ${reviewed.label.toLowerCase()} patch`);
    if (!/^patches\/[A-Za-z0-9@%._-]+\.patch$/.test(path)) fail(`Unexpected ${reviewed.label.toLowerCase()} patch path`);
    delete patches[key]; patches[`${reviewed.name}@${plan.version}`] = path;
  }
  return { ...manifest, dependencies: { ...manifest.dependencies, ...Object.fromEntries(PACKAGES.map(name => [name, plan.version])) }, patchedDependencies: patches };
}

async function readManifest(cwd: string): Promise<Manifest> { return JSON.parse(await readFile(join(cwd, "package.json"), "utf8")); }
async function assertPatch(cwd: string, manifest: Manifest, current: string): Promise<void> {
  for (const reviewed of REVIEWED_PATCHES) {
    const path = manifest.patchedDependencies?.[`${reviewed.name}@${current}`];
    if (!path || !/^patches\/[A-Za-z0-9@%._-]+\.patch$/.test(path)) fail(`Missing reviewed ${reviewed.label.toLowerCase()} patch`);
    if ((await lstat(join(cwd, path))).isSymbolicLink() || sha(await readFile(join(cwd, path))) !== reviewed.sha256) fail(`${reviewed.label} patch differs from reviewed baseline; manual review required`);
  }
}
export async function assertInstalledPatch(cwd: string, manifest: Manifest, version: string): Promise<void> {
  for (const reviewed of REVIEWED_PATCHES) {
    const patch = await readFile(join(cwd, manifest.patchedDependencies![`${reviewed.name}@${version}`]!), "utf8");
    const expected = new Set<string>(reviewed.targets);
    for (const section of patch.split("diff --git ").slice(1)) {
      const path = /^a\/([^ ]+) b\//.exec(section)?.[1];
      if (!path || !expected.delete(path)) fail("Unexpected reviewed patch target");
      const installed = await readFile(join(cwd, "node_modules", reviewed.name, path), "utf8");
      // Bun can accept a patch with shifted/fuzzy context. Text presence alone cannot
      // establish which interface or handler received the hook. Require every reviewed
      // post-image, including its surrounding context, exactly once at any line offset.
      const hunks = section.split(/^@@ .* @@.*\n/m).slice(1);
      if (!hunks.length) fail("Missing reviewed patch context");
      for (const hunk of hunks) {
        const inserted = hunk.split("\n").filter(line => line.startsWith("+")).map(line => line.slice(1));
        if (!inserted.length || inserted.some(line => !installed.includes(line))) fail("Reviewed hook was not installed exactly once; manual compatibility review required");
        const lines = hunk.split("\n").filter(line => line.startsWith(" ") || line.startsWith("+"));
        const postimage = lines.map(line => line.slice(1)).join("\n");
        if (!postimage || installed.split(postimage).length !== 2) fail("Reviewed hook context differs; manual compatibility review required");
      }
    }
    if (expected.size) fail("Missing reviewed patch target");
  }
}
async function assertClean(cwd: string, run: Runner): Promise<void> {
  if (await run(["git", "status", "--porcelain", "--untracked-files=all"], cwd, true)) fail("Update requires a clean disposable checkout");
}
const safeArtifactDir = (cwd: string, output: string) => {
  const directory = resolve(output), child = relative(resolve(cwd), directory);
  if (!child || (!(child === ".." || child.startsWith("../")) && !isAbsolute(child))) fail("Artifacts must be outside the checkout");
  return directory;
};
interface Receipt { version: 1; base: string; current: string; target: string; patchSha256: string; shellPatchSha256: string; packageSha256: string; lockSha256: string; gates: readonly (readonly string[])[] }

export async function applyUpdate(options: { cwd: string; artifacts: string; env?: Record<string, string | undefined>; run?: Runner; fetchImpl?: typeof fetch }): Promise<Plan> {
  const { cwd } = options, run = options.run ?? runCommand, env = options.env ?? process.env;
  if (env.GITHUB_ACTIONS !== "true" || env.KILN_FRONTIER_DISPOSABLE !== "1") fail("Apply is restricted to an explicitly disposable CI checkout");
  await assertClean(cwd, run);
  if (!/^automation\/frontier-[A-Za-z0-9.-]+$/.test(await run(["git", "branch", "--show-current"], cwd, true))) fail("Apply requires an automation/frontier- branch");
  const artifacts = safeArtifactDir(cwd, options.artifacts), manifest = await readManifest(cwd);
  const plan = selectUpdate(manifest, await Promise.all(PACKAGES.map(name => registryMetadata(name, options.fetchImpl))));
  await assertPatch(cwd, manifest, plan.current);
  if (!plan.changed) return plan;
  const base = await run(["git", "rev-parse", "HEAD"], cwd, true); if (!/^[a-f0-9]{40}$/.test(base)) fail("Invalid base commit");
  await writeFile(join(cwd, "package.json"), JSON.stringify(migrateManifest(manifest, plan), null, 2) + "\n");
  for (const [index, gate] of GATES.entries()) {
    await run(gate, cwd);
    if (index === 0) await assertInstalledPatch(cwd, await readManifest(cwd), plan.version);
  }
  await assertPatch(cwd, await readManifest(cwd), plan.version);
  const changed = (await run(["git", "diff", "--name-only", "HEAD"], cwd, true)).split("\n").filter(Boolean);
  if (changed.some(path => !["package.json", "bun.lock"].includes(path))) fail("Validation modified files outside the dependency update");
  const packageBytes = await readFile(join(cwd, "package.json")), lockBytes = await readFile(join(cwd, "bun.lock"));
  if (packageBytes.length > LIMIT || lockBytes.length > LIMIT) fail("Update artifact exceeds limit");
  const receipt: Receipt = { version: 1, base, current: plan.current, target: plan.version, patchSha256: AUTH_PATCH_SHA256, shellPatchSha256: SHELL_PATCH_SHA256,
    packageSha256: sha(packageBytes), lockSha256: sha(lockBytes), gates: GATES };
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "package.json"), packageBytes); await writeFile(join(artifacts, "bun.lock"), lockBytes);
  // Advisory only: no finding here admits a remote model or bypasses the gates above.
  const catalog = await run(["bun", "bin/kiln.ts", "model", "catalog", "check", "--json"], cwd, true);
  if (Buffer.byteLength(catalog) > LIMIT) fail("Catalog audit exceeds artifact limit");
  await writeFile(join(artifacts, "catalog-check.json"), catalog + "\n");
  await writeFile(join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return plan;
}

/** Validate untrusted artifacts using only trusted repository code; never import upgraded dependencies. */
export async function validateArtifacts(cwd: string, artifacts: string, base: string): Promise<{ receipt: Receipt; manifest: Uint8Array; lock: Uint8Array }> {
  if (JSON.stringify((await readdir(artifacts)).sort()) !== JSON.stringify(["bun.lock", "catalog-check.json", "package.json", "receipt.json"])) fail("Unexpected update artifact files");
  for (const name of await readdir(artifacts)) { const stat = await lstat(join(artifacts, name)); if (!stat.isFile() || stat.size > LIMIT) fail("Invalid update artifact"); }
  const receipt = JSON.parse(await readFile(join(artifacts, "receipt.json"), "utf8")) as Receipt;
  if (receipt.version !== 1 || receipt.base !== base || !/^[a-f0-9]{40}$/.test(base) || !stable(receipt.current) || !stable(receipt.target)
    || compare(receipt.target, receipt.current) <= 0 || receipt.patchSha256 !== AUTH_PATCH_SHA256 || receipt.shellPatchSha256 !== SHELL_PATCH_SHA256 || JSON.stringify(receipt.gates) !== JSON.stringify(GATES)) fail("Invalid verification receipt");
  const original = await readManifest(cwd); await assertPatch(cwd, original, receipt.current);
  if (!PACKAGES.every(name => original.dependencies[name] === receipt.current)) fail("Receipt does not match base pins");
  const manifest = await readFile(join(artifacts, "package.json")), lock = await readFile(join(artifacts, "bun.lock"));
  if (sha(manifest) !== receipt.packageSha256 || sha(lock) !== receipt.lockSha256) fail("Update artifact digest mismatch");
  const expected = migrateManifest(original, { current: receipt.current, version: receipt.target, changed: true });
  if (JSON.stringify(JSON.parse(manifest.toString("utf8"))) !== JSON.stringify(expected)) fail("Update changed package fields beyond exact native pins and patch mapping");
  return { receipt, manifest, lock };
}

export async function publishUpdate(cwd: string, artifacts: string, run: Runner = runCommand, env = process.env): Promise<void> {
  if (env.GITHUB_ACTIONS !== "true" || env.KILN_FRONTIER_PUBLISH !== "1") fail("Publishing is restricted to the isolated CI publication job");
  await assertClean(cwd, run);
  const base = await run(["git", "rev-parse", "HEAD"], cwd, true);
  const { receipt, manifest, lock } = await validateArtifacts(cwd, artifacts, base);
  const branch = `automation/frontier-${receipt.target}`;
  const defaultBranch = await run(["gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], cwd, true);
  if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) fail("Cannot determine the default branch");
  const assertBase = async () => {
    const remote = await run(["git", "ls-remote", "origin", `refs/heads/${defaultBranch}`], cwd, true);
    if (remote.split(/\s+/)[0] !== base) fail("Default branch advanced after verification; retry on the current base");
  };
  await assertBase();
  const existing = JSON.parse(await run(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number"], cwd, true));
  if (!Array.isArray(existing)) fail("Cannot determine existing update review");
  await run(["gh", "auth", "setup-git"], cwd);
  const mergeVerified = async () => {
    const pr = JSON.parse(await run(["gh", "pr", "view", branch, "--json", "headRefOid,baseRefName,isDraft"], cwd, true));
    if (!/^[a-f0-9]{40}$/.test(pr.headRefOid) || pr.baseRefName !== defaultBranch) fail("Update PR identity mismatch");
    await run(["git", "fetch", "--no-tags", "origin", `refs/heads/${branch}`], cwd);
    const paths = (await run(["git", "diff", "--name-only", base, pr.headRefOid], cwd, true)).split("\n").filter(Boolean).sort();
    if (JSON.stringify(paths) !== JSON.stringify(["bun.lock", "package.json"])) fail("Update PR contains unverified changes");
    // Git blob identities compare exact bytes without importing or executing artifacts.
    for (const [path, bytes] of [["package.json", manifest], ["bun.lock", lock]] as const) {
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (await run(["git", "rev-parse", `${pr.headRefOid}:${path}`], cwd, true) !== blob) fail("Update PR differs from verified artifacts");
    }
    await assertBase();
    if (pr.isDraft) await run(["gh", "pr", "ready", branch], cwd);
    // Respect repository protections. Never use an administrative bypass or force push.
    await run(["gh", "pr", "merge", branch, "--squash", "--match-head-commit", pr.headRefOid], cwd);
  };
  if (existing.length) { await mergeVerified(); return; }
  // A pre-existing branch without an open PR is never reset or force-pushed.
  if (await run(["git", "ls-remote", "--heads", "origin", `refs/heads/${branch}`], cwd, true)) fail("Update branch already exists; manual review required");
  await run(["git", "checkout", "-b", branch], cwd);
  await writeFile(join(cwd, "package.json"), manifest); await writeFile(join(cwd, "bun.lock"), lock);
  await run(["git", "add", "--", "package.json", "bun.lock"], cwd);
  await run(["git", "-c", "user.name=kiln-update-bot", "-c", "user.email=kiln-update-bot@users.noreply.github.com", "commit", "-m", `Update native harness dependencies to ${receipt.target}`], cwd);
  await run(["git", "push", "origin", `HEAD:refs/heads/${branch}`], cwd);
  const body = join(artifacts, "pr-body.md");
  await writeFile(body, `Updates all six native OMP dependencies from ${receipt.current} to ${receipt.target}, the latest common stable release observed on the official npm registry. Preserves the reviewed OAuth callback and session shell patches under their new version keys.\n\nValidation on base ${receipt.base}: install with lifecycle scripts disabled, typecheck, documentation links, full test suite, evaluator manifest verification, and leakcheck passed. The workflow artifact includes an advisory catalog check; metadata findings do not prove provider availability or refresh benchmark rankings.\n\nThe isolated publication job checks the current base, exact PR files, and commit identity before merging. A failed check stops publication.\n`);
  await run(["gh", "pr", "create", "--base", defaultBranch, "--head", branch, "--title", `Update native harness dependencies to ${receipt.target}`, "--body-file", body], cwd);
  await mergeVerified();
}

export async function main(args = process.argv.slice(2), options: { cwd?: string; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const mode = args[0] ?? "--check";
  if (!["--check", "--apply", "--publish"].includes(mode) || (mode === "--check" ? args.length > 1 : args.length !== 3 || args[1] !== "--artifacts")) fail("usage: bun scripts/frontier-update.ts [--check | --apply --artifacts PATH | --publish --artifacts PATH]");
  const cwd = await realpath(options.cwd ?? process.cwd());
  if (mode === "--publish") { await publishUpdate(cwd, args[2]!); return; }
  const plan = mode === "--apply" ? await applyUpdate({ cwd, artifacts: args[2]! })
    : selectUpdate(await readManifest(cwd), await Promise.all(PACKAGES.map(name => registryMetadata(name, options.fetchImpl))));
  console.log(JSON.stringify({ ...plan, registry: REGISTRY, mutation: mode === "--apply" && plan.changed }));
  if (mode === "--apply" && process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `changed=${plan.changed}\n`, { flag: "a" });
}
if (import.meta.main) main().catch(error => {
  console.error(error instanceof FrontierUpdateError ? `Frontier update stopped: ${error.message}` : "Frontier update stopped: invalid local data or unavailable operation; inspect the failed gate.");
  process.exitCode = 1;
});
