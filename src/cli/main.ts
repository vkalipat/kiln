import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { Role } from "../core/config";
import type { IslandModels } from "../ideation/islands";
import { authCommand } from "./commands/auth";
import { ideasCommand, judgeCommand } from "./commands/ideas";
import { runCommand } from "./commands/run";
import { projectCommand } from "./commands/project";
import { inspectCommand } from "./commands/inspect";
import { controlledCommand } from "./controlled-command";
import { pauseCommand } from "./commands/pause";
import { tuiCommand } from "./commands/tui";
import { evalsCommand, type EvalsCommandDeps } from "./commands/evals";
import { evolveCommand, type EvolveCommandDeps } from "./commands/evolve";
import type { OperatorApplyDeps } from "../evolution/operator";
import type { RunPaths } from "../core/run";
import type { runBuild, runBuildSingleSession, BuildDeps } from "../phases/build";
import type { runForm } from "../phases/form";
import type { runReflect } from "../phases/reflect";
import type { runFrame } from "../phases/frame";
import type { runDiscover } from "../phases/discover";
import type { runIdeate } from "../phases/ideate";
import type { runBare } from "../ideation/bare";
import type { runCheckpoint } from "../phases/checkpoint";
import type { AuthStore } from "../providers/auth";

export interface CliIo {
  write: (s: string) => void;
  error?: (s: string) => void;
  ask?: (prompt: string) => Promise<string>;
  /** Sensitive input path. TTY implementations mask it; TUI implementations never journal it. */
  askSecret?: (prompt: string) => Promise<string>;
}

/** Test/embedding seams: skip network auth and role resolution, and never block on real stdin. */
export interface CliDeps {
  /** Staged evaluators disable this because their per-seat effort table is already frozen. */
  runtimeEffort?: { enabled?: boolean; profile?: string };
  /** Eval runner injection and vehicle seams; production defaults remain available. */
  evals?: EvalsCommandDeps;
  /** Evolution lifecycle injection seams. */
  evolve?: EvolveCommandDeps;
  operatorApply?: OperatorApplyDeps;
  /** Announces the authoritative run before any phase starts (UI and cooperative pause). */
  onRun?: (run: RunPaths) => void;
  launchTui?: (options: { home: string; runId?: string }) => Promise<void>;
  /** Authentication seams used by embeddings and network-free tests. */
  authStoreFactory?: (path: string) => AuthStore;
  openUrl?: (url: string) => void;
  authAbortController?: AbortController;
  streamFn?: StreamFn;
  brainModel?: Model;
  scoutModel?: Model;
  apiKeyFor?: (provider: string) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  stdin?: () => Promise<string>;
  /** Role-complete model injection for ideate/checkpoint tests and embeddings. */
  models?: Partial<Record<Role, Model>>;
  islandModels?: IslandModels;
  /** Usage-window seam; production constructs it from stored OAuth credentials. */
  fetchUsage?: (provider: string) => Promise<{ used: number; limit?: number; resetAt?: string } | undefined>;
  /** Phase seams for CLI routing tests and embedded harnesses. */
  runForm?: typeof runForm;
  runBuild?: typeof runBuild;
  runBuildSingleSession?: typeof runBuildSingleSession;
  runReflect?: typeof runReflect;
  runFrame?: typeof runFrame;
  runDiscover?: typeof runDiscover;
  runIdeate?: typeof runIdeate;
  runBare?: typeof runBare;
  runCheckpoint?: typeof runCheckpoint;
  /** Build-only test hooks; authoritative CLI dependencies always win. */
  buildDeps?: Partial<Pick<BuildDeps, "git" | "stepHook" | "now" | "runCheck" | "runBuilder" | "createDriver" | "runAuditor" | "runSweep" | "initHook">>;
}

export const VERSION = "0.1.0";

const USAGE = 'usage: kiln [tui] | kiln auth login|key|status|logout ... | kiln run new|resume|list|show|record ... | kiln project form|build|status|audit|relock ... | kiln build start|pause ... | kiln ideas frontier|pick|reject|another ... | kiln judge pair ... | kiln model roles | kiln mode show|set|toggle ... | kiln evals verify|leakcheck|metrics|calibrate|effort|m1|m2 ... | kiln evolve list|propose|eval|promote|rollback|archive|apply ...\n';

/** `--k v` and `--k=v` set string flags; a bare `--k` sets `true`. Everything else is a command word. */
export function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | boolean> } {
  const cmd: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flags[a.slice(2)] = argv[++i]!;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      cmd.push(a);
    }
  }
  return { cmd, flags };
}

export async function main(
  argv: string[],
  io: CliIo = { write: (s) => process.stdout.write(s), error: (s) => process.stderr.write(s) },
  deps: CliDeps = {},
): Promise<number> {
  const err = io.error ?? io.write;
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") { io.write(USAGE); return 0; }
  if (argv[0] === "--version" || argv[0] === "-v") {
    io.write(`kiln ${VERSION}\n`);
    return 0;
  }
  const { cmd, flags } = parseArgs(argv);
  if (cmd.length === 0 || cmd[0] === "tui") return tuiCommand(flags, io, deps);
  if (cmd[0] === "evals") return evalsCommand(cmd.slice(1), flags, io, { ...(deps.evals ?? {}), cli: deps.evals?.cli ?? deps });
  if (cmd[0] === "evolve") return evolveCommand(cmd.slice(1), flags, io, { ...(deps.evolve ?? {}), cli: deps.evolve?.cli ?? deps });
  if (cmd[0] === "build" && cmd[1] === "pause") return pauseCommand(cmd[2], flags, io);
  if (cmd[0] === "model" || cmd[0] === "mode" || (cmd[0] === "run" && cmd[1] === "record")) return inspectCommand(cmd, flags, io);
  if (cmd[0] === "build" && cmd[1] === "start") return controlledCommand(deps, (scoped) => projectCommand(["build", ...cmd.slice(2)], flags, io, scoped));
  if (cmd[0] === "auth") return authCommand(cmd.slice(1), flags, io, deps);
  if (cmd[0] === "run") return controlledCommand(deps, (scoped) => runCommand(cmd.slice(1), flags, io, scoped));
  if (cmd[0] === "project") return controlledCommand(deps, (scoped) => projectCommand(cmd.slice(1), flags, io, scoped));
  if (cmd[0] === "ideas") return ideasCommand(cmd.slice(1), flags, io);
  if (cmd[0] === "judge") return judgeCommand(cmd.slice(1), flags, io, deps);
  err(`kiln: unknown command ${argv.join(" ")}\n${USAGE}`);
  return 2;
}
