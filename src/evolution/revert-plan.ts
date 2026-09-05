import { runProcess } from "../core/process";
import type { FileTransition } from "./transaction";

interface Entry { mode: string; blob: string }
async function git(home: string, args: string[]): Promise<string> {
  const result = await runProcess({ cmd: "git", args, cwd: home, shell: false, timeoutMs: 60_000, maxOutputBytes: 16_000_000 });
  if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.truncated) throw new Error(`cannot prepare exact rollback: git ${args[0]} failed or returned incomplete output`);
  return result.stdout;
}
function tree(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const item of text.split("\0").filter(Boolean)) {
    const tab = item.indexOf("\t"); const [mode, type, blob] = item.slice(0, tab).split(" ");
    if (tab < 0 || type !== "blob" || !blob || !mode) throw new Error("rollback cannot inspect a non-blob tree entry");
    entries.set(item.slice(tab + 1), { mode, blob });
  }
  return entries;
}
function owned(path: string): boolean {
  return /^(playbook|prompts|evolution)\//.test(path) && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => !part || part === "." || part === "..");
}

export async function readEvolutionFile(home: string, head: string, path: string): Promise<string | null> {
  if (!/^[a-f0-9]{40,64}$/i.test(head) || !owned(path)) throw new Error("invalid rollback object path");
  const entries = tree(await git(home, ["ls-tree", "-r", "-z", head, "--", `:(literal)${path}`]));
  const entry = entries.get(path);
  if (!entry) return null;
  if (!["100644", "100755"].includes(entry.mode)) throw new Error("rollback metadata is not a regular file");
  const text = await git(home, ["cat-file", "blob", entry.blob]);
  if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("rollback metadata is not UTF-8 text");
  return text;
}

/** Compute a HEAD inverse before changing the worktree, rejecting unknown paths and binary blobs. */
export async function prepareRevert(home: string, head: string): Promise<FileTransition[]> {
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("rollback requires a full commit id");
  const [current, parent] = await Promise.all([git(home, ["ls-tree", "-r", "-z", head]), git(home, ["ls-tree", "-r", "-z", `${head}^`])]);
  const after = tree(current); const before = tree(parent); const changed = [...new Set([...after.keys(), ...before.keys()])].filter((path) => {
    const a = after.get(path); const b = before.get(path); return a?.blob !== b?.blob || a?.mode !== b?.mode;
  }).sort();
  for (const path of changed) {
    if (!owned(path)) throw new Error(`rollback commit includes an unowned path: ${path}`);
    for (const entry of [after.get(path), before.get(path)]) if (entry && !["100644", "100755"].includes(entry.mode)) throw new Error(`rollback refuses a non-regular file: ${path}`);
  }
  const read = async (entry: Entry | undefined): Promise<string | null> => {
    if (!entry) return null;
    const text = await git(home, ["cat-file", "blob", entry.blob]);
    if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("rollback refuses non-UTF-8 evolution material");
    return text;
  };
  const transitions: FileTransition[] = [];
  for (const path of changed) transitions.push({ path, before: await read(after.get(path)), after: await read(before.get(path)) });
  return transitions;
}
