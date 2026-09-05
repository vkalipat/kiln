import { kilnHome } from "../../core/paths";
import { loadConfig, type KilnConfig, type Role } from "../../core/config";
import { leakcheck } from "../../evals/leakcheck";
import { verifyEvalsManifest } from "../../evals/manifest";
import { verifySplit } from "../../evals/seeds";
import { collectMetrics } from "../../evals/metrics";
import { projectM1, runM1, type M1Arm, type RunM1Deps, type RunM1Options } from "../../evals/m1";
import { defaultM2Projection, runM2, type RunM2Deps, type RunM2Options } from "../../evals/m2";
import { NoModelError, type EffortName } from "../../providers/models";
import type { CliDeps, CliIo } from "../main";
import { printJson, table } from "../output";
import { askCli } from "../runtime";
import { createCliRuntime } from "../runtime";
import { calibrate, CALIBRATION_GROUP_FLOOR_USD, CalibrationError, type CalibrateDeps } from "../../evals/calibrate";
import { RealGitRunner, type GitRunner } from "../../build/git";
import { printMetricsReport } from "../metrics-output";
import { printM1Report, printM2Report } from "../evals-output";
import { runEffortSweep, projectedSweepBudget, EffortSweepError, type EffortSweepTarget, type RunEffortSweepDeps } from "../../evals/effort";
import { createProductionEffortSweepDeps } from "../../evals/effort-runner";
import { derivedCaps } from "../../formation/features";
import { projectedRoundCost, type ModelResolver } from "../../ideation/budget";

const USAGE = "usage: kiln evals verify [--json] [--home DIR] | kiln evals leakcheck [--json] [--home DIR] | kiln evals metrics [--since VALUE] [--evals] [--json] | kiln evals calibrate [--labels human|agent] [--groups N] --budget USD [--yes] [--json] | kiln evals effort <role> --budget USD [--json] | kiln evals m1 --budget USD [--rounds N] [--no-fable-low] [--no-frontier] [--yes] [--json] | kiln evals m2 --projects N --budget USD [--yes] [--json]\n";
const NO_MODEL_HINT = "hint: configure authenticated eval seats before starting a paid runner\n";

export interface EvalsCommandDeps {
  cli?: CliDeps;
  runM1?: typeof runM1;
  runM2?: typeof runM2;
  m1?: RunM1Deps;
  m2?: RunM2Deps;
  calibrate?: typeof calibrate;
  calibration?: Partial<CalibrateDeps>;
  git?: GitRunner;
  runEffort?: typeof runEffortSweep;
  effort?: RunEffortSweepDeps;
  createEffortDeps?: typeof createProductionEffortSweepDeps;
}

function lines(label: string, values: readonly string[]): string[] {
  return values.map((value) => `${label}: ${value}`);
}

function positive(value: string | boolean | undefined, name: string, integer = false): number {
  if (typeof value !== "string") throw new Error(`${name} requires a value`);
  const parsed = Number(value.replace(/^\$/, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
  return parsed;
}

async function confirm(rows: string[][], prompt: string, io: CliIo, deps: EvalsCommandDeps): Promise<boolean> {
  table(io, rows);
  const answer = (await askCli(prompt, io, deps.cli ?? {})).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

const M1_STRONG: readonly Role[] = ["brain", "builder", "reflector", "generator"];
const M1_SCORED: readonly Role[] = ["brain", "generator", "judge"];

function requestedEffort(cfg: KilnConfig, role: Role): string { return cfg.effortByRole?.[role] ?? cfg.effort; }
function m1Arms(options: Pick<RunM1Options, "fableLow" | "frontier">): M1Arm[] {
  return ["A0", "B0", ...(options.fableLow === false ? [] : ["A1" as const]), ...(options.frontier === false ? [] : ["A2" as const])];
}
function m1Config(cfg: KilnConfig, arm: M1Arm): KilnConfig {
  const roles = arm === "A1" ? Object.fromEntries(M1_STRONG.map((role) => [role, ["anthropic/claude-fable-5-1"]]))
    : arm === "A2" ? cfg.seating.frontier.roles : cfg.seating.default;
  return { ...cfg, roles: { ...cfg.roles, ...roles }, build: { ...cfg.build, ...(arm === "A2" ? cfg.seating.frontier.caps : {}) } };
}
function m1InputRows(cfg: KilnConfig, options: Pick<RunM1Options, "fableLow" | "frontier">): string[][] {
  return m1Arms(options).flatMap((arm) => {
    const armCfg = m1Config(cfg, arm);
    return M1_SCORED.map((role) => [
      `${arm} ${role}`,
      armCfg.roles[role].join(","),
      arm === "A1" && M1_STRONG.includes(role) ? "low" : requestedEffort(armCfg, role),
    ]);
  });
}
async function liveM1Projection(home: string, cfg: KilnConfig, options: Pick<RunM1Options, "rounds" | "fableLow" | "frontier">, deps: EvalsCommandDeps) {
  const models: Partial<Record<M1Arm, ModelResolver>> = {};
  for (const arm of m1Arms(options)) {
    const armCfg = m1Config(cfg, arm);
    try {
      const runtime = await createCliRuntime(home, armCfg, deps.cli ?? {});
      projectedRoundCost(armCfg, runtime.models as ModelResolver);
      models[arm] = runtime.models as ModelResolver;
    } catch (error) { if (!(error instanceof NoModelError)) throw error; }
  }
  return projectM1(cfg, options, 12, models);
}
async function liveM2Projection(home: string, cfg: KilnConfig, deps: EvalsCommandDeps) {
  try {
    const armCfg = { ...cfg, roles: { ...cfg.roles, ...cfg.seating.default } };
    const runtime = await createCliRuntime(home, armCfg, deps.cli ?? {});
    projectedRoundCost(armCfg, runtime.models as ModelResolver);
    return defaultM2Projection(cfg, runtime.models as ModelResolver);
  } catch (error) {
    if (!(error instanceof NoModelError)) throw error;
    return defaultM2Projection(cfg);
  }
}

export async function evalsCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: EvalsCommandDeps = {}): Promise<number> {
  const action = cmd[0];
  if (!action || !["verify", "leakcheck", "metrics", "calibrate", "effort", "m1", "m2"].includes(action)
    || ((action === "effort" ? cmd.length !== 2 : cmd.length !== 1))) {
    (io.error ?? io.write)(USAGE);
    return 2;
  }
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  const json = flags.json === true;

  if (action === "verify") {
    const manifest = verifyEvalsManifest(home);
    const split = verifySplit(home);
    const result = { ok: manifest.ok && split.ok, manifest, split };
    if (json) printJson(io, result);
    else {
      io.write(`evals verify: ${result.ok ? "ok" : "failed"}\n`);
      const problems = [
        ...lines("manifest changed", manifest.changed), ...lines("manifest missing", manifest.missing), ...lines("manifest extra", manifest.extra),
        ...split.errors, ...lines("split changed", split.changed), ...lines("split missing", split.missing), ...lines("split extra", split.extra),
      ];
      for (const problem of [...new Set(problems)]) io.write(`- ${problem}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (action === "leakcheck") {
    const result = leakcheck(home);
    if (json) printJson(io, result);
    else {
      io.write(`evals leakcheck: ${result.ok ? "ok" : "failed"}\n`);
      if (result.rows.length > 0) table(io, [["kind", "source", "seed", "score"], ...result.rows.map((row) => [row.kind, row.source, row.seedId || "-", row.score.toFixed(4)])]);
    }
    return result.ok ? 0 : 1;
  }

  const manifest = verifyEvalsManifest(home);
  if (!manifest.ok) {
    const result = { ok: false, manifest };
    if (json) printJson(io, result); else io.write(`eval manifest mismatch: ${[...manifest.changed, ...manifest.missing, ...manifest.extra].join(", ")}\n`);
    return 1;
  }
  if (action === "metrics") {
    try {
      const report = collectMetrics(home, { since: typeof flags.since === "string" ? flags.since : undefined, evals: flags.evals === true });
      if (json) printJson(io, report);
      else printMetricsReport(io, report);
      return 0;
    } catch (error) { (io.error ?? io.write)(`${error instanceof Error ? error.message : String(error)}\n`); return 2; }
  }

  const cfg = loadConfig(home);
  try {
    const budgetUsd = positive(flags.budget, "--budget");
    if (action === "calibrate") {
      const labels = flags.labels === undefined ? "agent" : flags.labels;
      if (labels !== "human" && labels !== "agent") throw new Error("--labels must be human or agent");
      const groups = flags.groups === undefined ? 20 : positive(flags.groups, "--groups", true);
      const expected = groups * CALIBRATION_GROUP_FLOOR_USD;
      if (!json && flags.yes !== true && !await confirm([["calibration", "groups", "projected floor"], [labels, String(groups), `$${expected.toFixed(2)}`]], "Run calibration? [y/N] ", io, deps)) return 0;
      const runner = deps.calibrate ?? calibrate;
      let calibrationDeps: CalibrateDeps;
      if (deps.calibrate && !(deps.calibration?.models && deps.calibration.apiKeyFor && deps.calibration.availableProviders)) {
        calibrationDeps = { cfg, git: deps.git ?? new RealGitRunner(), ...deps.calibration } as CalibrateDeps;
      } else if (deps.calibration?.models && deps.calibration.apiKeyFor && deps.calibration.availableProviders) {
        calibrationDeps = { cfg, git: deps.git ?? new RealGitRunner(), ...deps.calibration } as CalibrateDeps;
      } else {
        const runtime = await createCliRuntime(home, cfg, deps.cli ?? {});
        calibrationDeps = {
          cfg, git: deps.git ?? new RealGitRunner(), models: runtime.models, modelsOn: runtime.modelsOn,
          availableProviders: runtime.available, apiKeyFor: runtime.apiKeyFor, streamFn: deps.cli?.streamFn,
          ...(labels === "human" ? { io: { ask: (prompt: string) => askCli(prompt, io, deps.cli ?? {}) } } : {}),
          ...deps.calibration,
        };
      }
      const report = await runner(home, { labels, groups, budgetUsd }, calibrationDeps);
      if (json) printJson(io, report);
      else table(io, [["groups", "agreement", "order", "status", "cost"], [String(report.groups), report.agreement.toFixed(3), report.orderAgreement.toFixed(3), report.calibrated ? "calibrated" : report.provisional ? "provisional" : "not calibrated", `$${report.costUsd.toFixed(2)}`]]);
      return 0;
    }
    if (action === "effort") {
      const requested = cmd[1];
      if (!["judge", "generator", "brain", "generator+brain", "builder", "auditor"].includes(requested ?? "")) throw new Error("effort target must be judge, generator, brain, generator+brain, builder, or auditor");
      const target: EffortSweepTarget = requested === "generator" || requested === "brain" ? "generator+brain" : requested as EffortSweepTarget;
      const rounds = flags.rounds === undefined ? 1 : positive(flags.rounds, "--rounds", true);
      const levels = typeof flags.levels === "string" ? flags.levels.split(",").map((level) => level.trim()).filter(Boolean) as EffortName[] : undefined;
      if (levels?.some((level) => !["minimal", "low", "medium", "high", "xhigh", "max"].includes(level))) throw new Error("--levels must be comma-separated effort levels");
      const projected = projectedSweepBudget(target, levels ? new Set(levels).size : 4);
      if (!json && flags.yes !== true && !await confirm([["effort sweep", "rounds", "projected"], [target, String(rounds), `$${projected.toFixed(2)}`], ["requested levels", levels?.join(",") ?? "low,medium,high,xhigh", ""]], "Run effort sweep? [y/N] ", io, deps)) return 0;
      const effortDeps = deps.effort ?? await (deps.createEffortDeps ?? createProductionEffortSweepDeps)(home, cfg, deps.cli ?? {});
      const report = await (deps.runEffort ?? runEffortSweep)(home, cfg, target, {
        budgetUsd, rounds, ...(levels ? { levels } : {}), ...(typeof flags.profile === "string" ? { profile: flags.profile } : {}),
        ...(typeof flags.eval === "string" ? { evalId: flags.eval } : {}),
      }, effortDeps);
      if (json) printJson(io, report);
      else table(io, [["cell", "wins", "n", "quality", "usd/success"], ...report.cells.map((cell) => [cell.id, String(cell.wins), String(cell.n), cell.quality.toFixed(3), cell.usdPerSuccess === null ? "-" : `$${cell.usdPerSuccess.toFixed(2)}`]), ["winner", report.winner ?? "-", report.verdict, report.reason ?? "-", `$${report.spentUsd.toFixed(2)}`]]);
      return report.verdict === "ok" ? 0 : 1;
    }
    if (action === "m1") {
      const options: RunM1Options = {
        budgetUsd, ...(flags.rounds === undefined ? {} : { rounds: positive(flags.rounds, "--rounds", true) }),
        fableLow: flags["no-fable-low"] !== true, frontier: flags["no-frontier"] !== true,
        ...(typeof flags.eval === "string" ? { evalId: flags.eval } : {}),
      };
      if (!json && flags.yes !== true) {
        const projection = await liveM1Projection(home, cfg, options, deps);
        if (!await confirm([
        ["M1 projection / input", "expected / models", "ceiling / effort"],
        ["per seed", `$${projection.perSeedCell.expectedUsd.toFixed(2)}`, `$${projection.perSeedCell.ceilingUsd.toFixed(2)}`],
        ["total", `$${projection.total.expectedUsd.toFixed(2)}`, `$${projection.total.ceilingUsd.toFixed(2)}`],
        ...m1InputRows(cfg, options),
      ], "Run M1? [y/N] ", io, deps)) return 0;
      }
      const report = await (deps.runM1 ?? runM1)(home, cfg, options, { ...(deps.m1 ?? {}), cli: deps.m1?.cli ?? deps.cli });
      if (json) printJson(io, report);
      else printM1Report(io, report);
      return report.status === "complete" ? 0 : 1;
    }

    const options: RunM2Options = {
      projects: positive(flags.projects, "--projects", true), budgetUsd,
      ...(typeof flags.eval === "string" ? { evalId: flags.eval } : {}),
    };
    if (!json && flags.yes !== true) {
      const projection = await liveM2Projection(home, cfg, deps); const caps = derivedCaps(cfg);
      if (!await confirm([
      ["M2 projection / input", "expected / models", "ceiling / effort"],
      ["per project", `$${projection.expectedUsd.toFixed(2)}`, `$${projection.ceilingUsd.toFixed(2)}`],
      ["total", `$${(projection.expectedUsd * options.projects).toFixed(2)}`, `$${(projection.ceilingUsd * options.projects).toFixed(2)}`],
      ["derived max features", String(caps.maxFeatures), ""],
      ["build assumptions", `${cfg.build.expectedAttempts} attempts`, `$${cfg.build.expectedAttemptUsd.toFixed(3)}/attempt`],
      ...(["builder", "auditor"] as const).map((role) => [role, (cfg.seating.default[role] ?? cfg.roles[role]).join(","), requestedEffort(cfg, role)]),
    ], "Run M2? [y/N] ", io, deps)) return 0;
    }
    const report = await (deps.runM2 ?? runM2)(home, cfg, options, { ...(deps.m2 ?? {}), cli: deps.m2?.cli ?? deps.cli });
    if (json) printJson(io, report);
    else printM2Report(io, report);
    return report.status === "complete" ? 0 : 1;
  } catch (error) {
    if (error instanceof NoModelError) { (io.error ?? io.write)(`${error.message}\n${NO_MODEL_HINT}`); return 3; }
    (io.error ?? io.write)(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof CalibrationError) return error.reason === "usage" ? 2 : 1;
    if (error instanceof EffortSweepError) return error.reason === "usage" ? 2 : 1;
    return /requires a value|must be a positive|must be human or agent|effort target must/.test(error instanceof Error ? error.message : String(error)) ? 2 : 1;
  }
}
