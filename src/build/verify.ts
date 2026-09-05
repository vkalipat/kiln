import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckPhase } from "../core/events";
import type { FailureClass } from "../core/failure";
import { writeAtomic } from "../core/paths";
import { runProcess } from "../core/process";
import { excerpt, type RunRecord } from "../core/record";
import { throwIfRunCancelled } from "../core/run-control";
import { checkNeeds, predicateMatches } from "../ideation/probe";
import type { Acceptance } from "../formation/features";
import { checkEnv } from "./env";

export interface CheckResult {
  checkId: string;
  ok: boolean;
  kind: Acceptance["type"];
  exitCode?: number;
  durationMs: number;
  overrunMs: number;
  timedOut: boolean;
  predicateMatched?: boolean;
  /** Prompt-sized line excerpt; the complete captured result is retained at outputPath. */
  output: string;
  outputPath: string;
  outputTruncated: boolean;
  notRunReason?: string;
}

export interface RunCheckOptions {
  cwd: string;
  checksDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  needs: string[];
  record: RunRecord;
  featureId?: string;
  attempt: number;
  phase: CheckPhase;
  /** Test/replay seam; production uses a UUID. */
  checkId?: string;
  /** Dependency lookup seam; production uses Bun.which through checkNeeds. */
  which?: (name: string) => string | null;
  /** Environment seam for deterministic embeddings. */
  env?: NodeJS.ProcessEnv;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function physicalPath(path: string, linkHops = 0): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (linkHops >= 16) throw new Error(`too many symbolic links while resolving ${path}`);
        const target = resolve(dirname(current), readlinkSync(current));
        return resolve(physicalPath(target, linkHops + 1), ...missing);
      }
      return resolve(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function outputExcerpt(text: string): string {
  const lines = excerpt(text, 20, 20).text;
  if (lines.length <= 1_000) return lines;
  const notice = "\n... [excerpt capped] ...\n";
  const half = Math.floor((1_000 - notice.length) / 2);
  return `${lines.slice(0, half)}${notice}${lines.slice(-half)}`;
}

function checkPath(o: RunCheckOptions, checkId: string): string {
  if (!SAFE_SEGMENT.test(checkId)) throw new Error(`invalid check id ${checkId}`);
  if (o.featureId !== undefined && !SAFE_SEGMENT.test(o.featureId)) throw new Error(`invalid feature id ${o.featureId}`);
  return join(o.checksDir, `${o.phase}-${o.featureId ?? "init"}-a${o.attempt}-${checkId}.txt`);
}

function declaredNeeds(acceptance: Acceptance, supplied: readonly string[]): string[] {
  const own = acceptance.type === "manual" ? [] : acceptance.needs ?? [];
  return [...new Set([...supplied, ...own])];
}

function recordResult(o: RunCheckOptions, result: CheckResult): CheckResult {
  o.record.append({
    t: "check",
    checkId: result.checkId,
    featureId: o.featureId,
    attempt: o.attempt,
    kind: result.kind,
    phase: o.phase,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    overrunMs: result.overrunMs,
    timedOut: result.timedOut,
    predicateMatched: result.predicateMatched,
    outputPath: result.outputPath,
    outputTruncated: result.outputTruncated,
    notRunReason: result.notRunReason,
  });
  return result;
}

export async function runCheck(acceptance: Acceptance, o: RunCheckOptions): Promise<CheckResult> {
  throwIfRunCancelled();
  const checkId = o.checkId ?? randomUUID();
  const outputPath = checkPath(o, checkId);
  const needs = declaredNeeds(acceptance, o.needs);
  const env = checkEnv(needs, o.env ?? process.env);
  const missing = checkNeeds(needs, { env, which: o.which });
  if (missing.length > 0) {
    const notRunReason = `missing_dependency:${missing[0]}`;
    const full = `not run: ${notRunReason}\n`;
    writeAtomic(outputPath, full);
    return recordResult(o, { checkId, ok: false, kind: acceptance.type, durationMs: 0, overrunMs: 0, timedOut: false, output: outputExcerpt(full), outputPath, outputTruncated: false, notRunReason });
  }

  if (acceptance.type === "manual") {
    const full = `manual verification required:\n${acceptance.instructions}\n`;
    writeAtomic(outputPath, full);
    return recordResult(o, { checkId, ok: false, kind: "manual", durationMs: 0, overrunMs: 0, timedOut: false, output: outputExcerpt(full), outputPath, outputTruncated: false });
  }

  if (acceptance.type === "file") {
    const started = Date.now();
    let ok = false;
    let full: string;
    const displayPath = JSON.stringify(acceptance.path);
    const parentTraversal = acceptance.path.split(/[\\/]/).includes("..");
    if (acceptance.path.includes("\0") || isAbsolute(acceptance.path) || parentTraversal) {
      full = `refused file path outside repo: ${displayPath}\n`;
    } else {
      try {
        const lexical = resolve(o.cwd, acceptance.path);
        const root = physicalPath(o.cwd);
        const target = physicalPath(lexical);
        if (!inside(root, target)) {
          full = `refused file path outside repo: ${displayPath}\n`;
        } else if (!existsSync(lexical)) {
          full = `file not found: ${displayPath}\n`;
        } else if (acceptance.contains === undefined) {
          ok = true;
          full = `file exists: ${displayPath}\n`;
        } else {
          const text = readFileSync(lexical, "utf8");
          ok = text.includes(acceptance.contains);
          full = ok ? `file contains expected text: ${displayPath}\n` : `file does not contain expected text: ${displayPath}\n`;
        }
      } catch (error) {
        full = `file check failed for ${displayPath}: ${(error as Error).message}\n`;
      }
    }
    writeAtomic(outputPath, full);
    return recordResult(o, { checkId, ok, kind: "file", durationMs: Date.now() - started, overrunMs: 0, timedOut: false, output: outputExcerpt(full), outputPath, outputTruncated: false });
  }

  const timeoutMs = Math.min(o.timeoutMs, (acceptance.timeoutSeconds ?? 300) * 1_000);
  const processResult = await runProcess({
    cmd: "sh",
    args: ["-c", acceptance.command],
    cwd: o.cwd,
    env,
    envReplace: true,
    timeoutMs,
    maxOutputBytes: o.maxOutputBytes,
  });
  throwIfRunCancelled();
  const full = processResult.stdout + processResult.stderr;
  const predicateMatched = acceptance.expect === undefined ? undefined : predicateMatches(acceptance.expect, full);
  const ok = processResult.exitCode === 0 && predicateMatched !== false;
  writeAtomic(outputPath, full);
  return recordResult(o, {
    checkId,
    ok,
    kind: "shell",
    exitCode: processResult.exitCode ?? undefined,
    durationMs: processResult.durationMs,
    overrunMs: processResult.overrunMs,
    timedOut: processResult.timedOut,
    predicateMatched,
    output: outputExcerpt(full),
    outputPath,
    outputTruncated: processResult.truncated,
  });
}

export function classifyCheck(result: CheckResult): FailureClass | undefined {
  if (result.notRunReason !== undefined || result.kind === "manual") return undefined;
  if (result.timedOut) return "deadline";
  return result.ok ? undefined : "verify";
}
