import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SnapshotEntry {
  path: string;
  type: "file" | "link";
  gitMode: "100644" | "100755" | "120000";
  fsMode: number;
  digest: string;
  oid: string;
}

/** Copy a repository tree without invoking Git's clean, smudge, text, or EOL machinery. */
export function copyExactTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const visit = (src: string, dst: string, root: boolean) => {
    for (const name of readdirSync(src).sort()) {
      if (root && (name === ".git" || name === ".kiln-scratch")) continue;
      const from = join(src, name);
      const to = join(dst, name);
      const stat = lstatSync(from);
      if (stat.isDirectory()) {
        mkdirSync(to, { recursive: true });
        chmodSync(to, stat.mode & 0o777);
        visit(from, to, false);
      } else if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(from), to);
      } else if (stat.isFile()) {
        copyFileSync(from, to);
        chmodSync(to, stat.mode & 0o777);
      } else {
        throw new Error(`cannot snapshot unsupported filesystem entry ${from}`);
      }
    }
  };
  visit(source, destination, true);
}

export function payloadEntries(rootDir: string, excludeRootMetadata = false): Array<Omit<SnapshotEntry, "oid">> {
  const entries: Array<Omit<SnapshotEntry, "oid">> = [];
  const visit = (dir: string, root: boolean) => {
    for (const name of readdirSync(dir).sort()) {
      if (root && excludeRootMetadata && (name === ".git" || name === ".kiln-scratch")) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path, false);
        continue;
      }
      const relativePath = relative(rootDir, path).split(sep).join("/");
      const fsMode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        entries.push({ path: relativePath, type: "link", gitMode: "120000", fsMode, digest: digest(Buffer.from(target)) });
      } else {
        entries.push({ path: relativePath, type: "file", gitMode: (fsMode & 0o111) === 0 ? "100644" : "100755", fsMode, digest: digest(readFileSync(path)) });
      }
    }
  };
  visit(rootDir, true);
  return entries;
}

export function assertSnapshotPayload(payloadDir: string, entries: readonly SnapshotEntry[]): void {
  const actual = payloadEntries(payloadDir);
  if (actual.length !== entries.length) throw changedPayload();
  for (let i = 0; i < actual.length; i += 1) {
    const expected = entries[i]!;
    const found = actual[i]!;
    if (found.path !== expected.path || found.type !== expected.type || found.gitMode !== expected.gitMode || found.fsMode !== expected.fsMode || found.digest !== expected.digest) throw changedPayload();
  }
}

/** Attribute-neutral porcelain used to detect auditor mutations in an exact snapshot worktree. */
export function exactSnapshotStatus(worktree: string, entries: readonly SnapshotEntry[]): string {
  let actual: Array<Omit<SnapshotEntry, "oid">>;
  try { actual = payloadEntries(worktree, true); } catch { return " M .\n"; }
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  const found = new Map(actual.map((entry) => [entry.path, entry]));
  const lines: string[] = [];
  for (const [path, entry] of expected) {
    const current = found.get(path);
    if (!current) lines.push(` D ${path}`);
    else if (current.type !== entry.type || current.gitMode !== entry.gitMode || current.fsMode !== entry.fsMode || current.digest !== entry.digest) lines.push(` M ${path}`);
  }
  for (const path of found.keys()) if (!expected.has(path)) lines.push(`?? ${path}`);
  return lines.length === 0 ? "" : `${lines.sort().join("\n")}\n`;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function changedPayload(): Error {
  return new Error("audit snapshot payload no longer matches its temporary commit");
}
