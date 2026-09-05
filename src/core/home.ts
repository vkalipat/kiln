import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultConfig, saveConfig, configPath } from "./config";
import { writeAtomic } from "./paths";

/** Package root: `src/core/home.ts` → `kiln/`, where the bundled `prompts/` and `playbook/` live. */
const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HOME_IGNORE_LINES = [
  "runs/",
  "auth.json",
  "evolution/candidates/",
  "evolution/work/",
  "evolution/evolve.lock",
] as const;
const EVAL_MIGRATION_OPERATION = "home-evals-corpus-v1";
const EVAL_MIGRATION_MARKER = `${JSON.stringify({ version: 1, operationId: EVAL_MIGRATION_OPERATION }, null, 2)}\n`;

/** Harness-owned trees that a phase may read but must never mutate through write/edit tools. */
export function homeProtectedDirs(home: string): string[] {
  return ["evals", "evolution", "playbook", "prompts"].map((name) => join(home, name));
}

/** Append ignore entries without rewriting user-owned lines or changing their order. */
export function ensureIgnored(home: string, lines: readonly string[]): void {
  const path = join(home, ".gitignore");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const held = new Set(before.split(/\r?\n/));
  const missing = lines.filter((line) => line.trim() !== "" && !held.has(line));
  if (missing.length === 0) return;
  const prefix = before === "" || before.endsWith("\n") ? before : `${before}\n`;
  writeFileSync(path, `${prefix}${missing.join("\n")}\n`);
}

/**
 * A loose-ref check is intentionally enough for the hot startup path. Repositories containing
 * only packed refs take the harmless slow path through `git init` and `rev-parse` once.
 */
function hasLooseHead(home: string): boolean {
  const heads = join(home, ".git", "refs", "heads");
  if (!existsSync(join(home, ".git", "HEAD")) || !existsSync(heads)) return false;
  try { return readdirSync(heads, { recursive: true }).some((entry) => String(entry) !== ""); }
  catch { return false; }
}

function git(home: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", [...args], { cwd: home, encoding: "utf8" });
}

function assertGit(result: ReturnType<typeof spawnSync>, action: string): void {
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "unknown git error").trim();
    throw new Error(`cannot ${action}${detail ? `: ${detail}` : ""}`);
  }
}

function copyBundledTree(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name); const to = join(target, entry.name);
    if (entry.isDirectory()) copyBundledTree(from, to);
    else if (entry.isFile() && !existsSync(to)) copyFileSync(from, to);
  }
}

function treeHasFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && treeHasFiles(join(path, entry.name))) return true;
  }
  return false;
}

function bundledEvalFiles(): string[] {
  const root = join(BUNDLED, "evals"); const files: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit(root, ""); return files.sort();
}

function validatePartialEvalMigration(home: string, bundled: readonly string[]): void {
  const expected = new Set(bundled); const root = join(home, "evals");
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const target = join(dir, entry.name);
      if (entry.isDirectory()) visit(target, relative);
      else if (!entry.isFile() || !expected.has(relative)
        || !readFileSync(target).equals(readFileSync(join(BUNDLED, "evals", relative)))) {
        throw new Error(`cannot resume eval corpus migration: evals/${relative} is not an owned bundled file`);
      }
    }
  };
  visit(root, "");
}

function hasOperation(home: string, operationId: string): boolean {
  const result = git(home, ["log", "-z", `--format=%(trailers:key=Kiln-Operation,valueonly)`]);
  assertGit(result, "inspect kiln home migrations");
  return String(result.stdout).split(/[\0\r\n]+/).some((value) => value.trim() === operationId);
}

/** Resume an owned copy, but never infer ownership from a partial corpus alone. */
function migrateBundledEvals(home: string, begin: boolean): void {
  const marker = join(home, "evolution", "work", "home-evals-corpus-v1.json");
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8") !== EVAL_MIGRATION_MARKER) throw new Error("cannot resume eval corpus migration: invalid durable intent");
  } else {
    if (!begin) return;
    const history = git(home, ["log", "--all", "--format=%H", "--", "evals"]);
    assertGit(history, "inspect prior eval corpus history");
    if (String(history.stdout).trim()) return;
    writeAtomic(marker, EVAL_MIGRATION_MARKER, { mode: 0o600 });
  }
  const bundled = bundledEvalFiles(); validatePartialEvalMigration(home, bundled);
  copyBundledTree(join(BUNDLED, "evals"), join(home, "evals"));
  const paths = bundled.map((path) => `evals/${path}`);
  if (hasOperation(home, EVAL_MIGRATION_OPERATION)) {
    const status = git(home, ["status", "--porcelain=v1", "--", ...paths]);
    assertGit(status, "verify the committed eval corpus migration");
    if (String(status.stdout).trim()) throw new Error("completed eval corpus migration has uncommitted corpus files");
    unlinkSync(marker); return;
  }
  assertGit(git(home, ["config", "--local", "user.name", "kiln"]), "set the kiln home Git user name");
  assertGit(git(home, ["config", "--local", "user.email", "kiln@localhost"]), "set the kiln home Git email");
  assertGit(git(home, ["add", "-A", "--", ...paths]), "stage the bundled eval corpus");
  assertGit(git(home, ["commit", "-q", "-m", "chore(home): install eval corpus", "-m",
    `Kiln-Operation: ${EVAL_MIGRATION_OPERATION}`, "--only", "--", ...paths]), "commit the bundled eval corpus");
  if (!hasOperation(home, EVAL_MIGRATION_OPERATION)) throw new Error("eval corpus migration commit was not recorded");
  const status = git(home, ["status", "--porcelain=v1", "--", ...paths]);
  assertGit(status, "verify the committed eval corpus migration");
  if (String(status.stdout).trim()) throw new Error("eval corpus migration left uncommitted corpus files");
  unlinkSync(marker);
}

/**
 * Sets up a kiln home directory and its local Git baseline. An initialized loose-ref repository is
 * detected entirely through the filesystem, so ordinary startups spawn no Git process.
 */
export function initHome(home: string): { created: boolean } {
  const fresh = !existsSync(configPath(home));
  const evals = join(home, "evals");
  const resumeEvalMigration = existsSync(join(home, "evolution", "work", "home-evals-corpus-v1.json"));
  const beginEvalMigration = !fresh && !existsSync(join(evals, "manifest.json")) && !treeHasFiles(evals);
  for (const d of [
    "prompts", "playbook", "evals/seeds", "evolution/candidates", "evolution/archive",
    "evolution/reports", "evolution/promoted", "evolution/work", "runs",
  ]) mkdirSync(join(home, d), { recursive: true });
  const bundled = ["prompts/kernel.md", "prompts/brain.md", "prompts/scout.md", "prompts/judge.md", "prompts/generator.md", "prompts/prober.md", "prompts/arbiter.md", "prompts/critic.md", "prompts/builder.md", "prompts/auditor.md", "prompts/reflector.md", "playbook/playbook.md"];
  for (const f of bundled) if (!existsSync(join(home, f))) copyFileSync(join(BUNDLED, f), join(home, f));
  if (fresh) {
    copyBundledTree(join(BUNDLED, "prompts", "blocks"), join(home, "prompts", "blocks"));
    if (!existsSync(join(home, "evolution", "deltas.jsonl"))) copyFileSync(join(BUNDLED, "evolution", "deltas.jsonl"), join(home, "evolution", "deltas.jsonl"));
  }
  // Once a manifest exists, absence is integrity evidence. Restoring a deleted corpus file here
  // would hide that drift before `verifyEvalsManifest` can report it.
  if (fresh) copyBundledTree(join(BUNDLED, "evals"), evals);
  if (fresh) saveConfig(home, defaultConfig());
  ensureIgnored(home, HOME_IGNORE_LINES);

  if (!hasLooseHead(home)) {
    assertGit(git(home, ["init", "-q"]), "initialize the kiln home repository");
    assertGit(git(home, ["config", "--local", "user.name", "kiln"]), "set the kiln home Git user name");
    assertGit(git(home, ["config", "--local", "user.email", "kiln@localhost"]), "set the kiln home Git email");
    const head = git(home, ["rev-parse", "--verify", "HEAD"]);
    if (head.status !== 0) {
      assertGit(git(home, ["add", "--", "playbook", "prompts", "evals", "evolution/deltas.jsonl", "config.json", ".gitignore"]), "stage the kiln home baseline");
      assertGit(git(home, ["commit", "-q", "-m", "chore(home): initial commit", "--only", "--", "playbook", "prompts", "evals", "evolution/deltas.jsonl", "config.json", ".gitignore"]), "commit the kiln home baseline");
    }
  }
  if (!fresh && (resumeEvalMigration || beginEvalMigration)) migrateBundledEvals(home, beginEvalMigration);
  return { created: fresh };
}
