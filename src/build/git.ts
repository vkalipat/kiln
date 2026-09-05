import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "../core/paths";
import { runProcess, type ProcessOptions, type ProcessResult } from "../core/process";
import { assertSnapshotPayload, copyExactTree, exactSnapshotStatus, payloadEntries, type SnapshotEntry } from "./git-snapshot";
import { stagePathspecs } from "./git-staging";

export type { SnapshotEntry } from "./git-snapshot";

const GIT_TIMEOUT_MS = 60_000;
const TRAILER_SEPARATOR = "\x1f";

export interface GitCommitOptions {
  message: string;
  trailers?: Readonly<Record<string, string | number>>;
  allowEmpty?: boolean;
  /** Stage only these repository-relative paths. Omission preserves the historical add-all behavior. */
  paths?: readonly string[];
}

export interface GitDiffOptions {
  ref?: string;
  path?: string;
  stat?: boolean;
}

export interface AuditSnapshot {
  producerDir: string;
  tempDir: string;
  indexFile: string;
  payloadDir: string;
  commit: string;
  worktree: string;
  entries: SnapshotEntry[];
}

export interface GitRunner {
  init(dir: string): Promise<void>;
  commit(dir: string, options: GitCommitOptions): Promise<string>;
  log(dir: string, options?: { n?: number }): Promise<string>;
  statusPorcelain(dir: string): Promise<string>;
  /** NUL-delimited raw paths for integrity checks; includes individual untracked files. */
  statusPorcelainZ?(dir: string): Promise<string>;
  diff(dir: string, options?: GitDiffOptions): Promise<string>;
  revParseHead(dir: string): Promise<string>;
  revert(dir: string, sha: string, options: { noCommit: true }): Promise<void>;
  checkoutAndClean(dir: string, restoreRef?: string): Promise<void>;
  hasTrailer(dir: string, key: string, value: string): Promise<boolean>;
  trailerValues?(dir: string, key: string, options?: { n?: number }): Promise<string[]>;
  createAuditSnapshot(dir: string, tempDir: string): Promise<AuditSnapshot>;
  rebuildAuditSnapshot(snapshot: AuditSnapshot): Promise<void>;
  removeAuditSnapshot(snapshot: AuditSnapshot): Promise<void>;
}

export class GitCommandError extends Error {
  readonly command = "git";

  constructor(
    readonly cwd: string,
    readonly args: readonly string[],
    readonly result: ProcessResult,
  ) {
    const reason = result.timedOut
      ? `timed out after ${GIT_TIMEOUT_MS}ms`
      : `exited ${result.exitCode ?? "without a status"}`;
    const detail = (result.stderr || result.stdout).trim();
    super(`git ${args.join(" ")} ${reason}${detail ? `: ${detail}` : ""}`);
    this.name = "GitCommandError";
  }
}

export type GitProcessRunner = (options: ProcessOptions) => Promise<ProcessResult>;

export interface RealGitRunnerOptions {
  run?: GitProcessRunner;
  /** Environment overlay, chiefly useful for proving that local identity works with an empty HOME. */
  env?: Readonly<Record<string, string>>;
}

/** Git operations used by freeze, build recovery, and the detached auditor. */
export class RealGitRunner implements GitRunner {
  private readonly run: GitProcessRunner;
  private readonly env: Readonly<Record<string, string>>;
  private readonly snapshots = new Map<string, AuditSnapshot>();
  private diffCounter = 0;

  constructor(options: RealGitRunnerOptions = {}) {
    this.run = options.run ?? runProcess;
    this.env = options.env ?? {};
  }

  private async command(
    cwd: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
    input?: string,
  ): Promise<ProcessResult> {
    const result = await this.run({
      cmd: "git",
      args: [...args],
      cwd,
      env: { ...this.env, ...env },
      timeoutMs: GIT_TIMEOUT_MS,
      shell: false,
      input,
    });
    if (result.timedOut || result.exitCode !== 0) throw new GitCommandError(cwd, [...args], result);
    return result;
  }

  async init(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".git"))) {
      try {
        await this.command(dir, ["init", "-b", "main"]);
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error;
        await this.command(dir, ["init"]);
        await this.command(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      }
    }
    await this.command(dir, ["config", "--local", "user.name", "kiln"]);
    await this.command(dir, ["config", "--local", "user.email", "kiln@localhost"]);
    this.ensureScratchIgnored(dir);
  }

  async commit(dir: string, options: GitCommitOptions): Promise<string> {
    const paths = options.paths;
    if (paths !== undefined) {
      if (paths.length === 0) throw new TypeError("git commit paths must not be empty");
      for (const path of paths) {
        const segments = path.split(/[\\/]/);
        if (!path || path === "." || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("-") || path.includes("\0") || segments.includes("..")) {
          throw new TypeError(`invalid git commit path ${path}`);
        }
      }
    }
    const pathspecs = paths === undefined ? ["."] : [...new Set(paths)].map((path) => `:(literal)${path}`);
    const args = ["commit"];
    if (options.allowEmpty) args.push("--allow-empty");
    args.push("-m", options.message);
    const trailers = Object.entries(options.trailers ?? {});
    if (trailers.length > 0) {
      for (const [key, value] of trailers) {
        if (!/^[A-Za-z0-9-]+$/.test(key) || /[\r\n]/.test(String(value))) {
          throw new TypeError(`invalid git trailer ${key}`);
        }
      }
      args.push("-m", trailers.map(([key, value]) => `${key}: ${value}`).join("\n"));
    }
    if (paths !== undefined) args.push("--only", "--", ...pathspecs);
    const toStage = await stagePathspecs(dir, paths, (args) => this.command(dir, args));
    if (toStage.length) await this.command(dir, ["add", "-A", "--", ...toStage]);
    await this.command(dir, args);
    return this.revParseHead(dir);
  }

  async log(dir: string, options: { n?: number } = {}): Promise<string> {
    const args = ["log", "-z"];
    if (options.n !== undefined) {
      const n = Math.max(0, Math.floor(options.n));
      if (n === 0) return "";
      args.push("-n", String(n));
    }
    const format = "%H%x00%(trailers:key=Kiln-Feature,valueonly,separator=%x1f)%x00%(trailers:key=Kiln-Run,valueonly)%x00%(trailers:key=Kiln-Check,valueonly)%x00%(trailers:key=Kiln-Attempt,valueonly)";
    args.push(`--format=${format}`);
    return (await this.command(dir, args)).stdout;
  }

  async statusPorcelain(dir: string): Promise<string> {
    const snapshot = this.snapshots.get(resolve(dir));
    if (snapshot) return exactSnapshotStatus(snapshot.worktree, snapshot.entries);
    return (await this.command(dir, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  }

  async statusPorcelainZ(dir: string): Promise<string> {
    return (await this.command(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  }

  async diff(dir: string, options: GitDiffOptions = {}): Promise<string> {
    const snapshot = this.snapshots.get(resolve(dir));
    if (snapshot) return this.snapshotDiff(snapshot, options);
    const args = ["diff"];
    if (options.stat) args.push("--stat");
    if (options.ref !== undefined) {
      if (options.ref.startsWith("-")) throw new TypeError("git diff ref may not start with '-'");
      args.push("--end-of-options", options.ref);
    }
    if (options.path !== undefined) args.push("--", `:(literal)${options.path}`);
    return (await this.command(dir, args)).stdout;
  }

  async revParseHead(dir: string): Promise<string> {
    return (await this.command(dir, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async revert(dir: string, sha: string, options: { noCommit: true }): Promise<void> {
    if (!options.noCommit) throw new TypeError("git revert must leave commit ownership with the caller");
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new TypeError("git revert ref must be a full object id");
    await this.command(dir, ["revert", "--no-commit", sha]);
  }

  async checkoutAndClean(dir: string, restoreRef?: string): Promise<void> {
    if (restoreRef !== undefined) {
      if (!/^[0-9a-f]{40,64}$/i.test(restoreRef)) throw new TypeError("git restore ref must be a full object id");
      await this.command(dir, ["reset", "--hard", restoreRef]);
      await this.command(dir, ["clean", "-fd"]);
      return;
    }
    // Reset the index first: `checkout -- .` alone preserves changes a builder staged itself.
    await this.command(dir, ["reset", "-q", "HEAD", "--", "."]);
    await this.command(dir, ["checkout", "--", "."]);
    await this.command(dir, ["clean", "-fd"]);
  }

  async hasTrailer(dir: string, key: string, value: string): Promise<boolean> {
    if (!/^[A-Za-z0-9-]+$/.test(key) || /[\r\n]/.test(value)) throw new TypeError("invalid git trailer query");
    const format = `%(trailers:key=${key},valueonly)`;
    const output = (await this.command(dir, ["log", "-z", `--format=${format}`])).stdout;
    return output.split("\0").some((item) => item.trim() === value);
  }

  async trailerValues(dir: string, key: string, options: { n?: number } = {}): Promise<string[]> {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new TypeError("invalid git trailer query");
    const args = ["log", "-z"];
    if (options.n !== undefined) {
      const n = Math.max(0, Math.floor(options.n));
      if (n === 0) return [];
      args.push("-n", String(n));
    }
    args.push(`--format=%(trailers:key=${key},valueonly,separator=%x1f)`);
    const output = (await this.command(dir, args)).stdout;
    return output.split(/[\0\x1f\r\n]+/).map((value) => value.trim()).filter(Boolean);
  }

  async createAuditSnapshot(dir: string, tempDir: string): Promise<AuditSnapshot> {
    const producer = resolve(dir);
    const temporary = resolve(tempDir);
    const relation = relative(producer, temporary);
    if (relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`))) {
      throw new TypeError("audit snapshot tempDir must be outside the producer repository");
    }
    mkdirSync(tempDir, { recursive: true });
    const snapshot: AuditSnapshot = {
      producerDir: producer,
      tempDir: temporary,
      indexFile: join(temporary, "audit.index"),
      payloadDir: join(temporary, "payload"),
      commit: "",
      worktree: join(temporary, "worktree"),
      entries: [],
    };
    const indexEnv = { GIT_INDEX_FILE: snapshot.indexFile };
    try {
      copyExactTree(producer, snapshot.payloadDir);
      await this.command(producer, ["read-tree", "HEAD"], indexEnv);
      // `read-tree` can inherit an already tracked scratch path. Remove it before rebuilding the
      // index from the captured payload; ignored paths elsewhere remain deliberately included.
      await this.command(producer, ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", ".kiln-scratch"], indexEnv);
      snapshot.entries = await this.replaceIndexFromDirectory(snapshot, snapshot.payloadDir, indexEnv);
      const tree = (await this.command(producer, ["write-tree"], indexEnv)).stdout.trim();
      const head = await this.revParseHead(producer);
      snapshot.commit = (await this.command(producer, ["commit-tree", tree, "-p", head, "-m", "kiln audit snapshot"])).stdout.trim();
      await this.addExactWorktree(snapshot);
      return snapshot;
    } catch (error) {
      await this.removeAuditSnapshot(snapshot);
      throw error;
    }
  }

  async rebuildAuditSnapshot(snapshot: AuditSnapshot): Promise<void> {
    if (!snapshot.commit) throw new Error("cannot rebuild an audit snapshot without a commit");
    assertSnapshotPayload(snapshot.payloadDir, snapshot.entries);
    await this.removeWorktree(snapshot);
    await this.addExactWorktree(snapshot);
  }

  async removeAuditSnapshot(snapshot: AuditSnapshot): Promise<void> {
    await this.removeWorktree(snapshot);
    this.snapshots.delete(resolve(snapshot.worktree));
    rmSync(snapshot.tempDir, { recursive: true, force: true });
  }

  private ensureScratchIgnored(dir: string): void {
    const path = join(dir, ".gitignore");
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = before.split(/\r?\n/);
    if (lines.includes(".kiln-scratch/")) return;
    const prefix = before.length === 0 || before.endsWith("\n") ? before : `${before}\n`;
    writeAtomic(path, `${prefix}.kiln-scratch/\n`);
  }

  private async removeWorktree(snapshot: AuditSnapshot): Promise<void> {
    this.snapshots.delete(resolve(snapshot.worktree));
    try {
      await this.command(snapshot.producerDir, ["worktree", "remove", "--force", snapshot.worktree]);
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
    }
    rmSync(snapshot.worktree, { recursive: true, force: true });
    try {
      await this.command(snapshot.producerDir, ["worktree", "prune"]);
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
    }
  }

  private async replaceIndexFromDirectory(
    snapshot: AuditSnapshot,
    sourceDir: string,
    indexEnv: Readonly<Record<string, string>>,
    excludeRootMetadata = false,
  ): Promise<SnapshotEntry[]> {
    const wanted = payloadEntries(sourceDir, excludeRootMetadata);
    const wantedPaths = new Set(wanted.map((entry) => entry.path));
    const inherited = (await this.command(snapshot.producerDir, ["ls-files", "-z"], indexEnv)).stdout.split("\0").filter(Boolean);
    for (const path of inherited) {
      if (!wantedPaths.has(path)) await this.command(snapshot.producerDir, ["update-index", "--force-remove", "--", path], indexEnv);
    }
    const entries: SnapshotEntry[] = [];
    for (const entry of wanted) {
      const payloadPath = join(sourceDir, ...entry.path.split("/"));
      const oid = entry.type === "link"
        ? (await this.command(snapshot.producerDir, ["hash-object", "-w", "--stdin"], {}, readlinkSync(payloadPath))).stdout.trim()
        : (await this.command(snapshot.producerDir, ["hash-object", "-w", "--no-filters", "--", payloadPath])).stdout.trim();
      await this.command(snapshot.producerDir, ["update-index", "--add", "--cacheinfo", entry.gitMode, oid, entry.path], indexEnv);
      entries.push({ ...entry, oid });
    }
    return entries;
  }

  private async snapshotDiff(snapshot: AuditSnapshot, options: GitDiffOptions): Promise<string> {
    if (options.ref?.startsWith("-")) throw new TypeError("git diff ref may not start with '-'");
    this.diffCounter += 1;
    const indexFile = join(snapshot.tempDir, `diff-${this.diffCounter}.index`);
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    try {
      await this.command(snapshot.producerDir, ["read-tree", snapshot.commit], indexEnv);
      await this.command(snapshot.producerDir, ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", ".kiln-scratch"], indexEnv);
      await this.replaceIndexFromDirectory(snapshot, snapshot.worktree, indexEnv, true);
      const currentTree = (await this.command(snapshot.producerDir, ["write-tree"], indexEnv)).stdout.trim();
      const base = options.ref === undefined ? snapshot.commit : await this.resolveSnapshotRef(snapshot, options.ref);
      const emptyAttributes = (await this.command(snapshot.producerDir, ["mktree"], {}, "")).stdout.trim();
      const args = ["-c", "core.attributesFile=/dev/null", "diff-tree", "--no-commit-id", "-r", options.stat ? "--stat" : "-p", "--no-ext-diff", "--no-textconv", base, currentTree];
      if (options.path !== undefined) {
        if (options.path === ".kiln-scratch" || options.path.startsWith(".kiln-scratch/")) return "";
        args.push("--", `:(literal)${options.path}`);
      } else {
        args.push("--", ".", ":(exclude).kiln-scratch", ":(exclude).kiln-scratch/**");
      }
      return (await this.command(snapshot.producerDir, args, { GIT_ATTR_NOSYSTEM: "1", GIT_ATTR_SOURCE: emptyAttributes })).stdout;
    } finally {
      rmSync(indexFile, { force: true });
    }
  }

  private async resolveSnapshotRef(snapshot: AuditSnapshot, ref: string): Promise<string> {
    const sha = (await this.command(snapshot.worktree, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`git resolved ${ref} to an invalid object id`);
    return sha;
  }

  private async addExactWorktree(snapshot: AuditSnapshot): Promise<void> {
    await this.command(snapshot.producerDir, ["worktree", "add", "--detach", "--no-checkout", snapshot.worktree, snapshot.commit]);
    copyExactTree(snapshot.payloadDir, snapshot.worktree);
    this.snapshots.set(resolve(snapshot.worktree), snapshot);
  }
}

export interface FeatureCommitTrailer { featureId: string; sha: string; runId?: string; checkId?: string; attempt?: number }

/** Extract authenticated fields from the NUL-delimited, trailer-only log format; legacy pairs remain readable. */
export function parseTrailers(log: string): FeatureCommitTrailer[] {
  const out: FeatureCommitTrailer[] = [];
  const fields = log.split("\0");
  const looksLikeSha = (value: string | undefined) => /^[0-9a-f]{40,64}$/i.test(value?.trim() ?? "");
  if (fields.at(-1) === "") fields.pop();
  // The current log has five fields; inspect record boundaries rather than a run id's content.
  // Historic four- and two-field logs remain readable when their whole framing is valid.
  const width = [5, 2, 4].find((size) => fields.length > 0 && fields.length % size === 0
    && fields.every((value, index) => index % size !== 0 || looksLikeSha(value)));
  if (width === undefined) return out;
  for (let i = 0; i + 1 < fields.length; i += width) {
    const sha = fields[i]!.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const runId = width >= 4 ? fields[i + 2]!.trim() : "";
    const checkId = width >= 4 ? fields[i + 3]!.trim() : "";
    const attemptRaw = width === 5 ? Number(fields[i + 4]!.trim()) : Number.NaN;
    for (const featureId of fields[i + 1]!.split(TRAILER_SEPARATOR).map((value) => value.trim()).filter(Boolean)) {
      if (!/\s/.test(featureId)) out.push({ featureId, sha, ...(runId ? { runId } : {}), ...(checkId ? { checkId } : {}), ...(Number.isInteger(attemptRaw) && attemptRaw > 0 ? { attempt: attemptRaw } : {}) });
    }
  }
  return out;
}
