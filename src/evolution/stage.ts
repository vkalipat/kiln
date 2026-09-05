import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PromptName } from "../brain/prompts";
import { PROMPT_FILES } from "../brain/prompts";
import type { CliDeps } from "../cli/main";
import { createCliRuntime, type CliRuntime } from "../cli/runtime";
import { loadConfig, type BuildConfig, type KilnConfig, type Role } from "../core/config";
import { writeAtomic } from "../core/paths";

export interface StageSeating {
  roles?: Partial<Record<Role, string[]>>;
  caps?: Partial<Pick<BuildConfig, "builderUsdCap" | "auditorUsdCap" | "expectedAttemptUsd" | "maxFeatures">>;
  runBudgetUsd?: number;
  runWallSeconds?: number;
}

export interface StageHomeOptions {
  playbook?: string;
  prompts?: Partial<Record<PromptName, string>>;
  seating?: StageSeating;
}

export interface StagedHome {
  home: string;
  evalId: string;
  arm: string;
  config: KilnConfig;
}

function safeSegment(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} must be one safe path segment`);
  }
}

function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function assertDirectory(path: string): boolean {
  const held = entry(path);
  if (!held) return false;
  if (held.isSymbolicLink() || !held.isDirectory()) throw new Error(`staged path must be a real directory: ${path}`);
  return true;
}

function assertRegularOrMissing(path: string): void {
  const held = entry(path);
  if (held && (held.isSymbolicLink() || !held.isFile())) throw new Error(`staged path must be a regular file: ${path}`);
}

function inspectTarget(target: string): boolean {
  if (!assertDirectory(target)) return false;
  const known = new Set(["config.json", "playbook", "prompts", "runs"]);
  const extra = readdirSync(target).filter((name) => !known.has(name));
  if (extra.length > 0) throw new Error(`staged home contains unexpected entries: ${extra.sort().join(", ")}`);
  assertRegularOrMissing(join(target, "config.json"));
  for (const name of ["playbook", "prompts", "runs"]) assertDirectory(join(target, name));
  return true;
}

function ensureStageDirectories(root: string, evalId: string, arm: string): void {
  const paths = [join(root, "evolution"), join(root, "evolution", "work"), join(root, "evolution", "work", evalId), join(root, "evolution", "work", evalId, arm)];
  for (const path of paths) if (!assertDirectory(path)) mkdirSync(path);
  for (const name of ["prompts", "playbook", "runs"]) {
    const path = join(paths.at(-1)!, name);
    if (!assertDirectory(path)) mkdirSync(path);
  }
}

function renderedConfig(config: KilnConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function frozenDrift(target: string, desired: ReadonlyMap<string, string>): string[] {
  return [...desired].flatMap(([relative, text]) => {
    const path = join(target, relative);
    const held = entry(path);
    if (!held || held.isSymbolicLink() || !held.isFile()) return [relative];
    return readFileSync(path, "utf8") === text ? [] : [relative];
  });
}

/** Materialize an isolated arm home without initializing Git or copying auth/evaluator state. */
export function stageHome(home: string, evalId: string, arm: string, options: StageHomeOptions = {}): StagedHome {
  safeSegment("evalId", evalId); safeSegment("arm", arm);
  const promptOverrides = Object.entries(options.prompts ?? {}).filter((entry): entry is [PromptName, string] => entry[1] !== undefined);
  const championPlaybook = readFileSync(join(home, "playbook", "playbook.md"), "utf8");
  if (promptOverrides.length > 1 || (options.playbook !== undefined && options.playbook !== championPlaybook && promptOverrides.length > 0)) {
    throw new Error("one staged arm may change one playbook or one prompt, not both");
  }
  const root = realpathSync(resolve(home));
  const target = join(root, "evolution", "work", evalId, arm);
  const config = loadConfig(home);
  const seating = options.seating ?? {};
  const staged: KilnConfig = {
    ...config,
    roles: { ...config.roles, ...(seating.roles ?? {}) },
    build: { ...config.build, ...(seating.caps ?? {}) },
    evals: {
      ...config.evals,
      ...(seating.runBudgetUsd === undefined ? {} : { runBudgetUsd: seating.runBudgetUsd }),
      ...(seating.runWallSeconds === undefined ? {} : { runWallSeconds: seating.runWallSeconds }),
    },
  };
  const playbook = options.playbook ?? championPlaybook;
  const desired = new Map<string, string>([["config.json", renderedConfig(staged)], [join("playbook", "playbook.md"), playbook]]);
  for (const name of PROMPT_FILES) {
    const text = options.prompts?.[name] ?? readFileSync(join(home, "prompts", `${name}.md`), "utf8");
    desired.set(join("prompts", `${name}.md`), text);
  }
  const existed = inspectTarget(target);
  const runs = entry(join(target, "runs"));
  const hasRuns = existed && runs?.isDirectory() === true && readdirSync(join(target, "runs")).length > 0;
  if (hasRuns) {
    const drift = frozenDrift(target, desired);
    if (drift.length > 0) throw new Error(`staged home frozen input drift: ${drift.sort().join(", ")}`);
  } else {
    ensureStageDirectories(root, evalId, arm);
    for (const [relative, text] of desired) writeAtomic(join(target, relative), text);
  }
  return { home: target, evalId, arm, config: staged };
}

/** Build an arm runtime with staged configuration while keeping credentials in the real home. */
export function runtimeFor(realHome: string, staged: StagedHome, deps: CliDeps): Promise<CliRuntime> {
  return createCliRuntime(realHome, loadConfig(staged.home), { ...deps, runtimeEffort: { enabled: false } });
}
