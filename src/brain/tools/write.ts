import { lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { homeProtectedDirs } from "../../core/home";
import { fail, ok } from "./shape";
import type { ToolContext } from "./index";

const MAX_LINK_HOPS = 16;

/**
 * The real location a path names, symlinks resolved. Textual `resolve` is not
 * enough: a link inside a root can point anywhere, so the root check has to see
 * where a write would actually land. Resolves as much of the path as exists,
 * follows a dangling final link by hand, and re-appends the not-yet-created tail.
 */
export function realPath(path: string, hops = 0): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    // Not fully resolvable yet — fall through and resolve what does exist.
  }
  if (hops >= MAX_LINK_HOPS) return abs;
  try {
    if (lstatSync(abs).isSymbolicLink()) return realPath(resolve(dirname(abs), readlinkSync(abs)), hops + 1);
  } catch {
    // No directory entry at all; treat it as a plain not-yet-created name.
  }
  const parent = dirname(abs);
  return parent === abs ? abs : join(realPath(parent, hops + 1), basename(abs));
}

/** True when `path` really lands on a writable root or something under one. */
export function insideRoots(ctx: ToolContext, path: string): boolean {
  const abs = realPath(resolve(ctx.cwd, path));
  return ctx.roots.some((r) => {
    const root = realPath(r);
    return abs === root || abs.startsWith(`${root}/`);
  });
}

export function refuseOutsideRoots(ctx: ToolContext, action: string, path: string) {
  ctx.record.append({ t: "failure", class: "policy", message: `${action} outside allowed roots: ${path}` });
  return fail(`policy: ${path} is outside the allowed roots`);
}

/**
 * True for the run's own bookkeeping (record §10): the journal, the status file, the lock, the
 * spilled tool output, and every artifact the ideate loop owns — the tournament, the frontier, the
 * metrics, the criteria and render directories, the raw island files, the evidence sidecars, and
 * the `ideas/<id>.md` of any idea the archive has already inserted. All of these live inside the
 * run directory (a writable root) but are the harness's account of what happened; an agent that
 * could rewrite them could rewrite its own history. Ideas not yet inserted stay writable, because
 * writing them is how an island produces one.
 */
export function isProtectedRunFile(ctx: ToolContext, path: string): boolean {
  const abs = realPath(resolve(ctx.cwd, path));
  const run = ctx.run;
  for (const f of [run.record, run.status, run.tournament, run.frontier, run.metrics, run.lock, run.features, run.acceptanceLock, run.featureState, ...(ctx.protectedPaths ?? [])]) {
    if (abs === realPath(f)) return true;
  }
  // `run.dir` is `<home>/runs/<id>` for ordinary and staged eval homes. Deriving the home here
  // makes the defense ambient for every phase, including future ToolContext construction sites.
  const home = dirname(dirname(run.dir));
  for (const d of [
    run.toolOutputDir, run.criteriaDir, run.renderedDir, run.rawIdeasDir,
    ...homeProtectedDirs(home), ...(ctx.protectedDirs ?? []),
  ]) {
    const dir = realPath(d);
    if (abs === dir || abs.startsWith(`${dir}/`)) return true;
  }
  const ideas = realPath(run.ideasDir);
  if (abs.startsWith(`${ideas}/`)) {
    const name = abs.slice(ideas.length + 1);
    if (name.endsWith(".evidence.json")) return true;
    if (name.endsWith(".md") && ctx.protectedIdeas?.has(name.slice(0, -3)) === true) return true;
  }
  return false;
}

export function refuseProtected(ctx: ToolContext, action: string, path: string) {
  ctx.record.append({ t: "failure", class: "policy", message: `${action} of a run state file: ${path}` });
  return fail(`policy: ${path} is part of the run's own record and cannot be written`);
}

/** The shared write-path policy: inside a writable root, and not one of the run's state files. */
export function refuseIfNotWritable(ctx: ToolContext, action: string, path: string) {
  if (!insideRoots(ctx, path)) return refuseOutsideRoots(ctx, action, path);
  if (isProtectedRunFile(ctx, path)) return refuseProtected(ctx, action, path);
  return undefined;
}

export function writeTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: "write",
    label: "Write",
    intent: "omit",
    description: "Create or overwrite a text file. Parent directories are created. Only paths under the run or project are allowed.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    examples: [{ caption: "Write the brief", call: { path: "brief.md", content: "# Brief\n..." } }],
    async execute(_id, p: { path: string; content: string }) {
      const refused = refuseIfNotWritable(ctx, "write", p.path);
      if (refused) return refused;
      const abs = resolve(ctx.cwd, p.path);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, p.content);
      } catch (e) {
        return fail(`cannot write ${abs}: ${(e as Error).message}`);
      }
      return ok(`wrote ${abs} (${p.content.length} chars)`);
    },
  };
}
