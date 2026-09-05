import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RunPaths, RunStatus } from "../core/run";
import { projectPaths } from "../formation/paths";

/** Record §13: a 24 kB size-selected bundle of the run's markdown files. */
export const BUNDLE_CAP_BYTES = 24_576;

export interface Bundle {
  text: string;
  bytes: number;
  /** Relative labels of the files that made it in, in bundle order. */
  included: string[];
  /** Allowlisted files that exist but were left out: a symlink, or a file that did not fit. */
  omitted: string[];
}

interface Entry { label: string; path: string }

/** Names that never reach the reflector, even if an allowlisted label were ever to point at them. */
const EXCLUDED_SEGMENTS = new Set(["repo", "record.jsonl", "evals", "prompts", "checks", "blocked"]);
const IDEA_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The formed project: `status.projectDir`, else the real target of the run's `project` entry. */
export function bundleProjectDir(paths: RunPaths, status: Pick<RunStatus, "projectDir">): string | undefined {
  if (status.projectDir) return status.projectDir;
  try { return existsSync(paths.project) ? realpathSync(paths.project) : undefined; } catch { return undefined; }
}

function allowed(label: string): boolean {
  return label.split("/").every((segment) => !EXCLUDED_SEGMENTS.has(segment));
}

/** `lstat`, never `stat`: a symlinked entry is skipped rather than followed anywhere. */
function regularFile(path: string): boolean | undefined {
  try { return lstatSync(path).isFile(); } catch { return undefined; }
}

function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(label: string, content: string, note?: string): string {
  const fence = fenceFor(content);
  return [`## ${label}`, ...(note ? [note] : []), fence, content.endsWith("\n") ? content.slice(0, -1) : content, fence].join("\n");
}

/** The last `bytes` of `content`, starting at a line boundary; empty when no whole line fits. */
function lineAlignedTail(content: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buffer = Buffer.from(content, "utf8");
  const start = Math.max(0, buffer.length - bytes);
  if (start === 0) return content;
  const newline = buffer.indexOf(0x0a, start);
  return newline < 0 ? "" : buffer.subarray(newline + 1).toString("utf8");
}

function entries(paths: RunPaths, projectDir: string | undefined, chosenIdeaId: string | undefined): { files: Entry[]; progress?: Entry } {
  const files: Entry[] = [
    { label: "seed.md", path: paths.seed }, { label: "brief.md", path: paths.brief },
    { label: "landscape.md", path: paths.landscape }, { label: "notes.md", path: paths.notes },
  ];
  if (chosenIdeaId && IDEA_ID.test(chosenIdeaId)) files.push({ label: `ideas/${chosenIdeaId}.md`, path: join(paths.ideasDir, `${chosenIdeaId}.md`) });
  if (!projectDir) return { files };
  const project = projectPaths(projectDir);
  files.push({ label: "spec.md", path: project.spec }, { label: "audit.md", path: project.audit });
  return { files, progress: { label: "progress.md", path: project.progress } };
}

/**
 * An explicit allowlist of run- and project-side markdown, in a fixed order, each fenced under its
 * relative path so a `file` evidence ref can name it. A file that does not fit is omitted whole;
 * `progress.md` alone is taken as a tail of whatever room is left.
 */
export function bundleMarkdown(paths: RunPaths, projectDir: string | undefined): Bundle {
  let chosenIdeaId: string | undefined;
  try { chosenIdeaId = (JSON.parse(readFileSync(paths.status, "utf8")) as RunStatus).chosenIdeaId; } catch { chosenIdeaId = undefined; }
  const plan = entries(paths, projectDir, chosenIdeaId);
  const included: string[] = []; const omitted: string[] = [];
  let text = "";
  const fits = (candidate: string): boolean => Buffer.byteLength(candidate) <= BUNDLE_CAP_BYTES;
  const append = (section: string): boolean => {
    const candidate = text ? `${text}\n\n${section}\n` : `${section}\n`;
    if (!fits(candidate)) return false;
    text = candidate.slice(0, -1);
    return true;
  };
  for (const entry of plan.files) {
    if (!allowed(entry.label)) continue;
    const regular = regularFile(entry.path);
    if (regular === undefined) continue;
    if (regular && append(fenced(entry.label, readFileSync(entry.path, "utf8")))) included.push(entry.label); else omitted.push(entry.label);
  }
  const progress = plan.progress;
  if (progress && allowed(progress.label) && regularFile(progress.path) !== undefined) {
    const content = regularFile(progress.path) ? readFileSync(progress.path, "utf8") : undefined;
    if (content !== undefined && append(fenced(progress.label, content))) included.push(progress.label);
    else if (content !== undefined) {
      const total = Buffer.byteLength(content);
      const room = BUNDLE_CAP_BYTES - Buffer.byteLength(text) - Buffer.byteLength(fenced(progress.label, "", `(tail: last ${total} of ${total} bytes)`)) - 4;
      let tail = lineAlignedTail(content, room);
      while (tail !== "" && !append(fenced(progress.label, tail, `(tail: last ${Buffer.byteLength(tail)} of ${total} bytes)`))) {
        const newline = tail.indexOf("\n");
        tail = newline < 0 ? "" : tail.slice(newline + 1);
      }
      if (tail !== "") included.push(progress.label); else omitted.push(progress.label);
    } else omitted.push(progress.label);
  }
  return { text: text ? `${text}\n` : "", bytes: Buffer.byteLength(text ? `${text}\n` : ""), included, omitted };
}
