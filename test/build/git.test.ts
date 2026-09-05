import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { GitCommandError, RealGitRunner, parseTrailers, type GitProcessRunner } from "../../src/build/git";
import { runProcess, type ProcessResult } from "../../src/core/process";
import { FakeGitRunner } from "./fake-git";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function result(exitCode = 0, stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, timedOut: false, durationMs: 1, overrunMs: 0, truncated: false };
}

async function gitCommand(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await runProcess({ cmd: "git", args, cwd, env, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

type TreeEntry = { type: "file"; mode: number; bytes: string } | { type: "link"; target: string };

function tree(root: string): Record<string, TreeEntry> {
  const out: Record<string, TreeEntry> = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel === ".git" || rel.startsWith(".git/") || rel === ".kiln-scratch" || rel.startsWith(".kiln-scratch/")) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink()) out[rel] = { type: "link", target: readlinkSync(path) };
      else out[rel] = { type: "file", mode: stat.mode & 0o777, bytes: readFileSync(path).toString("hex") };
    }
  };
  visit(root);
  return out;
}

describe("RealGitRunner command boundary", () => {
  test("uses fixed argument arrays and falls back when init -b is unavailable", async () => {
    const calls: Array<{ args: string[]; shell: boolean | undefined; timeoutMs: number }> = [];
    const run: GitProcessRunner = async (options) => {
      calls.push({ args: [...(options.args ?? [])], shell: options.shell, timeoutMs: options.timeoutMs });
      return options.args?.[0] === "init" && options.args[1] === "-b" ? result(129, "unknown option") : result();
    };
    const dir = join(temp("kiln-git-fallback-"), "repo");
    await new RealGitRunner({ run }).init(dir);

    expect(calls.map((call) => call.args)).toEqual([
      ["init", "-b", "main"],
      ["init"],
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["config", "--local", "user.name", "kiln"],
      ["config", "--local", "user.email", "kiln@localhost"],
    ]);
    expect(calls.every((call) => call.shell === false && call.timeoutMs === 60_000)).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".kiln-scratch/\n");
  });

  test("throws a structured command error", async () => {
    const dir = temp("kiln-git-error-");
    const git = new RealGitRunner({ run: async () => result(7, "broken") });
    let thrown: unknown;
    try { await git.statusPorcelain(dir); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GitCommandError);
    const error = thrown as GitCommandError;
    expect(error.cwd).toBe(dir);
    expect(error.args).toEqual(["status", "--porcelain=v1", "--untracked-files=all"]);
    expect(error.result.exitCode).toBe(7);
    expect(error.result.stderr).toBe("broken");
  });

  test("keeps diff refs and metacharacter paths as individual arguments", async () => {
    const calls: string[][] = [];
    const git = new RealGitRunner({ run: async (options) => {
      calls.push([...(options.args ?? [])]);
      return { ...result(), stdout: "safe" };
    } });
    expect(await git.diff("/repo", { ref: "HEAD~1; echo nope", path: "a;$(echo nope).ts", stat: true })).toBe("safe");
    expect(calls).toEqual([["diff", "--stat", "--end-of-options", "HEAD~1; echo nope", "--", ":(literal)a;$(echo nope).ts"]]);
  });

  test("stages an explicit literal path set and reads typed trailer values", async () => {
    const calls: string[][] = [];
    const git = new RealGitRunner({ run: async (options) => {
      const args = [...(options.args ?? [])]; calls.push(args);
      if (args[0] === "ls-files") return { ...result(), stdout: "playbook/playbook.md\0path with spaces/file\0" };
      if (args[0] === "rev-parse") return { ...result(), stdout: `${"a".repeat(40)}\n` };
      if (args[0] === "log") return { ...result(), stdout: "candidate-a\x1fcandidate-b\0" };
      return result();
    } });
    await git.commit("/repo", { message: "scoped", paths: ["playbook/playbook.md", "path with spaces/file", "playbook/playbook.md"] });
    expect(calls.find((call) => call[0] === "add")).toEqual(["add", "-A", "--", ":(literal)playbook/playbook.md", ":(literal)path with spaces/file"]);
    expect(await git.trailerValues("/repo", "Kiln-Candidate", { n: 1 })).toEqual(["candidate-a", "candidate-b"]);
    expect(calls.at(-1)).toEqual(["log", "-z", "-n", "1", "--format=%(trailers:key=Kiln-Candidate,valueonly,separator=%x1f)"]);
    for (const path of ["", ".", "../escape", "safe/../escape", "/absolute", "C:\\absolute", "-option", "nul\0byte"]) {
      await expect(git.commit("/repo", { message: "bad", paths: [path] })).rejects.toThrow(/git commit path/);
    }
  });
});

describe("GitRunner contract", () => {
  test("scoped commits exclude and preserve unrelated staged and unstaged bytes", async () => {
    const repo = temp("kiln-git-scoped-"); const git = new RealGitRunner(); await git.init(repo);
    writeFileSync(join(repo, "target [1].txt"), "old target\n");
    writeFileSync(join(repo, "operator-note.md"), "base\n");
    await git.commit(repo, { message: "baseline" });
    writeFileSync(join(repo, "operator-note.md"), "staged\n");
    writeFileSync(join(repo, "unrelated-new.txt"), "new staged\n");
    await gitCommand(repo, ["add", "--", "operator-note.md", "unrelated-new.txt"]);
    writeFileSync(join(repo, "operator-note.md"), "unstaged\n");
    writeFileSync(join(repo, "target [1].txt"), "new target\n");
    const sha = await git.commit(repo, { message: "exact target", paths: ["target [1].txt"] });
    expect(await gitCommand(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).toBe("target [1].txt");
    expect(await gitCommand(repo, ["show", "HEAD:operator-note.md"])).toBe("base");
    expect(await gitCommand(repo, ["show", ":operator-note.md"])).toBe("staged");
    expect(readFileSync(join(repo, "operator-note.md"), "utf8")).toBe("unstaged\n");
    expect(await gitCommand(repo, ["diff", "--cached", "--name-only"])).toBe("operator-note.md\nunrelated-new.txt");
  });

  test("scoped commits include selected deletions and additions without swallowing a staged neighbor", async () => {
    const repo = temp("kiln-git-scoped-delete-"); const git = new RealGitRunner(); await git.init(repo);
    writeFileSync(join(repo, "old.txt"), "old\n"); await git.commit(repo, { message: "baseline" });
    writeFileSync(join(repo, "neighbor.txt"), "outside\n"); await gitCommand(repo, ["add", "neighbor.txt"]);
    unlinkSync(join(repo, "old.txt")); writeFileSync(join(repo, "new.txt"), "new\n");
    await git.commit(repo, { message: "replace", paths: ["old.txt", "new.txt"] });
    expect(await gitCommand(repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("neighbor.txt");
    expect(await gitCommand(repo, ["diff", "--cached", "--name-only"])).toBe("neighbor.txt");
    expect(await gitCommand(repo, ["show", "HEAD:new.txt"])).toBe("new");
  });

  test("NUL status preserves spaces, line breaks and quoted protected paths", async () => {
    const repo = temp("kiln-git-status-z-"); const git = new RealGitRunner(); await git.init(repo);
    await git.commit(repo, { message: "baseline" });
    mkdirSync(join(repo, "prompts"));
    for (const name of ["x y.md", "line\nbreak.md", 'quote".md']) writeFileSync(join(repo, "prompts", name), "dirty\n");
    const raw = await git.statusPorcelainZ(repo);
    expect(raw.split("\0").filter(Boolean).sort()).toEqual(['?? prompts/quote".md', "?? prompts/line\nbreak.md", "?? prompts/x y.md"].sort());
  });

  test("hexadecimal run ids cannot change trailer record framing", () => {
    const sha = "a".repeat(40); const runId = "b".repeat(40);
    const log = [sha, "f01", runId, "check-1", "1", ""].join("\0");
    expect(parseTrailers(log)).toEqual([{ sha, featureId: "f01", runId, checkId: "check-1", attempt: 1 }]);
    expect(parseTrailers(`${sha}\0f01\0${"c".repeat(40)}\0f02\0`)).toEqual([
      { sha, featureId: "f01" }, { sha: "c".repeat(40), featureId: "f02" },
    ]);
    expect(parseTrailers(`${sha}\0f01\0bad-framing`)).toEqual([]);
  });
  test("fake commits produce the same trailer format consumed from real logs", async () => {
    const fake = new FakeGitRunner();
    const sha = await fake.commit("/repo", {
      message: "feat(f07): ship it",
      trailers: { "Kiln-Feature": "f07", "Kiln-Run": "run-1", "Kiln-Attempt": 2 },
    });
    expect(parseTrailers(await fake.log("/repo", { n: 20 }))).toEqual([{ featureId: "f07", sha, runId: "run-1", attempt: 2 }]);
    expect(parseTrailers(`${"a".repeat(40)}\n__KILN_COMMIT__${"b".repeat(40)}\nKiln-Feature: forged\n`)).toEqual([]);

    await fake.revert("/repo", sha, { noCommit: true });
    expect(fake.calls.at(-1)).toEqual({ method: "revert", dir: "/repo", sha, options: { noCommit: true } });
    expect(fake.status).toContain("reverted-file");
  });

  test("reverts a full object id without committing it", async () => {
    const repo = temp("kiln-git-revert-");
    const git = new RealGitRunner();
    await git.init(repo);
    writeFileSync(join(repo, "held.txt"), "before\n");
    await git.commit(repo, { message: "before" });
    writeFileSync(join(repo, "held.txt"), "after\n");
    const changed = await git.commit(repo, { message: "after" });
    const head = await git.revParseHead(repo);

    await git.revert(repo, changed, { noCommit: true });
    expect(await git.revParseHead(repo)).toBe(head);
    expect(readFileSync(join(repo, "held.txt"), "utf8")).toBe("before\n");
    expect(await git.statusPorcelain(repo)).toContain("held.txt");
    await expect(git.revert(repo, "HEAD", { noCommit: true })).rejects.toThrow(/full object id/);
  });

  test("initializes, commits, snapshots exact worktree state, rebuilds, and cleans producer work", async () => {
    const root = temp("kiln-git-integration-");
    const emptyHome = join(root, "empty home");
    const repo = join(root, "repo ; $(not-a-command)");
    mkdirSync(emptyHome);
    mkdirSync(repo);
    writeFileSync(join(repo, ".gitignore"), "ignored.log\ncustom/\n");
    const git = new RealGitRunner({ env: { HOME: emptyHome } });

    await git.init(repo);
    await git.init(repo);
    expect(await gitCommand(repo, ["symbolic-ref", "--short", "HEAD"], { HOME: emptyHome })).toBe("main");
    expect(await gitCommand(repo, ["config", "--local", "user.name"], { HOME: emptyHome })).toBe("kiln");
    expect(await gitCommand(repo, ["config", "--local", "user.email"], { HOME: emptyHome })).toBe("kiln@localhost");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("ignored.log\ncustom/\n.kiln-scratch/\n");

    writeFileSync(join(repo, "tracked.txt"), "base\n");
    writeFileSync(join(repo, "mode.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo, "mode.sh"), 0o644);
    writeFileSync(join(repo, "deleted.txt"), "delete me\n");
    writeFileSync(join(repo, ".gitattributes"), "filtered.bin filter=lossy\neol.txt text eol=lf\n");
    writeFileSync(join(repo, "filtered.bin"), "ORIGINAL-base\n");
    writeFileSync(join(repo, "eol.txt"), "base\n");
    const snapshotWeird = "feature;$(touch snapshot-pwned).txt";
    writeFileSync(join(repo, snapshotWeird), "before\n");
    mkdirSync(join(repo, ".kiln-scratch"));
    writeFileSync(join(repo, ".kiln-scratch", "tracked"), "tracked scratch\n");
    await gitCommand(repo, ["add", "-f", ".kiln-scratch/tracked"], { HOME: emptyHome });
    await git.commit(repo, { message: "initial" });
    await git.commit(repo, {
      message: `body marker must not frame a commit\n\n__KILN_COMMIT__${"f".repeat(40)}\nKiln-Feature: forged\nnot a trailer`,
      allowEmpty: true,
    });
    const featureSha = await git.commit(repo, {
      message: "feat(f01): first",
      trailers: { "Kiln-Feature": "f01", "Kiln-Run": "run-a", "Kiln-Attempt": 1 },
      allowEmpty: true,
    });
    expect(parseTrailers(await git.log(repo, { n: 20 }))).toEqual([{ featureId: "f01", sha: featureSha, runId: "run-a", attempt: 1 }]);
    await gitCommand(repo, ["config", "--local", "filter.lossy.clean", "sed 's/ORIGINAL/CLEANED/g'"], { HOME: emptyHome });
    await gitCommand(repo, ["config", "--local", "filter.lossy.smudge", "sed 's/CLEANED/SMUDGED/g'"], { HOME: emptyHome });

    writeFileSync(join(repo, "tracked.txt"), "modified\0bytes\n");
    writeFileSync(join(repo, "filtered.bin"), "ORIGINAL-current\n");
    writeFileSync(join(repo, "eol.txt"), Buffer.from("one\r\ntwo\r\n"));
    writeFileSync(join(repo, snapshotWeird), "after\n");
    chmodSync(join(repo, "mode.sh"), 0o755);
    unlinkSync(join(repo, "deleted.txt"));
    writeFileSync(join(repo, "ordinary.txt"), "ordinary\n");
    writeFileSync(join(repo, "ignored.log"), "ignored but included\n");
    mkdirSync(join(repo, "custom"));
    writeFileSync(join(repo, "custom", "ignored-too.txt"), "ignored directory member\n");
    symlinkSync("tracked.txt", join(repo, "link-to-tracked"));
    writeFileSync(join(repo, ".kiln-scratch", "tracked"), "tracked scratch modified\n");
    writeFileSync(join(repo, ".kiln-scratch", "x"), "untracked scratch\n");
    await gitCommand(repo, ["add", "tracked.txt"], { HOME: emptyHome });

    const beforeTree = tree(repo);
    const beforeStatus = await git.statusPorcelain(repo);
    const beforeIndex = readFileSync(join(repo, ".git", "index"));
    const auditRoot = join(root, "audit ; $(still-not-a-command)");
    const snapshot = await git.createAuditSnapshot(repo, auditRoot);

    expect(tree(snapshot.worktree)).toEqual(beforeTree);
    expect(existsSync(join(snapshot.worktree, "deleted.txt"))).toBe(false);
    expect(existsSync(join(snapshot.worktree, "ignored.log"))).toBe(true);
    expect(existsSync(join(snapshot.worktree, ".kiln-scratch"))).toBe(false);
    expect(readFileSync(join(snapshot.worktree, "filtered.bin"), "utf8")).toBe("ORIGINAL-current\n");
    expect(readFileSync(join(snapshot.worktree, "eol.txt")).equals(Buffer.from("one\r\ntwo\r\n"))).toBe(true);
    expect(await gitCommand(repo, ["ls-tree", "-r", "--name-only", snapshot.commit, "--", ".kiln-scratch"], { HOME: emptyHome })).toBe("");
    expect(lstatSync(join(snapshot.worktree, "mode.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(snapshot.worktree, "link-to-tracked")).isSymbolicLink()).toBe(true);
    expect(tree(repo)).toEqual(beforeTree);
    expect(await git.statusPorcelain(repo)).toBe(beforeStatus);
    expect(readFileSync(join(repo, ".git", "index")).equals(beforeIndex)).toBe(true);
    expect(await git.statusPorcelain(snapshot.worktree)).toBe("");
    expect(await git.diff(snapshot.worktree)).toBe("");
    const featureDiff = await git.diff(snapshot.worktree, { ref: "HEAD^" });
    expect(featureDiff).toContain("-ORIGINAL-base");
    expect(featureDiff).toContain("+ORIGINAL-current");
    expect(featureDiff).toContain("+one\r");
    expect(featureDiff).not.toContain("CLEANED");
    expect(featureDiff).not.toContain("SMUDGED");
    expect(featureDiff).not.toContain(".kiln-scratch");
    expect(await git.diff(snapshot.worktree, { ref: "HEAD^", stat: true })).toContain("filtered.bin");
    expect(await git.diff(snapshot.worktree, { ref: "HEAD^", path: snapshotWeird })).toContain("+after");
    expect(await git.diff(snapshot.worktree, { ref: "HEAD^", path: "not-present" })).toBe("");
    expect(existsSync(join(repo, "snapshot-pwned"))).toBe(false);

    writeFileSync(join(snapshot.worktree, "tracked.txt"), "auditor mutation\n");
    writeFileSync(join(snapshot.worktree, "filtered.bin"), "auditor mutation\n");
    writeFileSync(join(snapshot.worktree, "auditor-junk"), "junk\n");
    expect(await git.statusPorcelain(snapshot.worktree)).toContain("auditor-junk");
    const workingDiff = await git.diff(snapshot.worktree);
    expect(workingDiff).toContain("+auditor mutation");
    expect(workingDiff).not.toContain("CLEANED");
    expect(workingDiff).not.toContain("SMUDGED");
    expect(await git.diff(snapshot.worktree, { ref: "HEAD" })).toBe(workingDiff);
    expect(await git.diff(snapshot.worktree, { stat: true })).toContain("auditor-junk");
    await git.rebuildAuditSnapshot(snapshot);
    expect(tree(snapshot.worktree)).toEqual(beforeTree);
    expect(await git.statusPorcelain(snapshot.worktree)).toBe("");
    await git.removeAuditSnapshot(snapshot);
    await git.removeAuditSnapshot(snapshot);
    expect(existsSync(snapshot.worktree)).toBe(false);

    const weird = "semi;$(touch should-not-exist).txt";
    writeFileSync(join(repo, weird), "before\n");
    await git.commit(repo, { message: "add weird path" });
    writeFileSync(join(repo, weird), "after\n");
    expect(await git.diff(repo, { path: weird })).toContain(weird);
    expect(existsSync(join(repo, "should-not-exist"))).toBe(false);

    writeFileSync(join(repo, "tracked.txt"), "discard staged\n");
    await gitCommand(repo, ["add", "tracked.txt"], { HOME: emptyHome });
    writeFileSync(join(repo, "discard-me"), "untracked\n");
    await git.checkoutAndClean(repo);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("modified\0bytes\n");
    expect(existsSync(join(repo, "discard-me"))).toBe(false);
    expect(existsSync(join(repo, ".kiln-scratch", "x"))).toBe(true);
    expect(await git.statusPorcelain(repo)).toBe("");
  }, 30_000);
});
