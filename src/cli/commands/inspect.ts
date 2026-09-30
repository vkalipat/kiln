import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES, defaultConfig, loadConfig, saveConfig, type Effort, type RoutingMode } from "../../core/config";
import { initHome } from "../../core/home";
import { kilnHome, writeAtomic } from "../../core/paths";
import { RunRecord } from "../../core/record";
import { runExists, runPaths } from "../../core/run";
import { localAuthState } from "../../onboarding/auth";
import {
  DEFAULT_EVIDENCE_SNAPSHOT, loadEvidenceSnapshot, planAdaptiveRouting, validateEvidenceSnapshot,
  type AdaptiveRoutingReport, type EvidenceSnapshot,
} from "../../routing/adaptive";
import type { CliIo } from "../main";
import { printJson, table } from "../output";
import { compileWorkflow, planWorkflow } from "../../workflow/plan";
import { applyWorkflowProfile } from "../../workflow/profile";
import { buildResourceCatalog } from "../../operator/resource-routing";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];
const ROUTING_MODES: readonly RoutingMode[] = ["adaptive", "manual"];
const INSPECT_USAGE = "usage: kiln model roles | kiln model routing [adaptive|manual] | kiln model plan <seed text> [--json] | kiln model benchmarks show|import <path> --reviewed | kiln mode show|set|toggle | kiln run record <id>\n";

function printPlan(io: CliIo, report: AdaptiveRoutingReport): void {
  io.write(`adaptive routing preview: ${report.status} · domain: ${report.domain}\n`);
  io.write(`evidence: ${report.evidence.id} (as of ${report.evidence.asOf}, ${report.evidence.sources.length} sources)\n`);
  table(io, [["role", "selected model"], ...ROLES.map((role) => [role, report.selectedRoleRefs[role]])]);
  for (const role of ROLES) {
    const why = report.roleReasons[role];
    io.write(`${role}: ${why.category} · ${why.selection} · effort ${report.effectiveEffort[role] ?? "not applicable"} · ${why.reason}\n`);
  }
  const b = report.budget;
  io.write(`budget: $${b.totalUsd.toFixed(2)} total · $${b.ideateUsd.toFixed(2)} ideate · $${b.buildUsd.toFixed(2)} build · ${b.affordableRounds}/${b.requestedRounds} round(s) · up to ${b.maxBuildFeatures} feature(s)\n`);
  for (const warning of report.warnings) io.write(`warning: ${warning}\n`);
}

function printEvidenceSnapshot(io: CliIo, snapshot: EvidenceSnapshot, imported: boolean): void {
  io.write(`${imported ? "Imported" : "Bundled"} benchmark snapshot: ${snapshot.id}\n`);
  io.write(`as of: ${snapshot.asOf} · verification: ${snapshot.verification.status}\n`);
  io.write(`sources: ${snapshot.sources.length} · categories: ${snapshot.rankings.map((ranking) => ranking.category).join(", ")}\n`);
}

function evidenceSnapshotPath(home: string): string { return join(home, "routing", "benchmarks.json"); }
function homeEvidenceSnapshot(home: string, now: Date): EvidenceSnapshot {
  const path = evidenceSnapshotPath(home);
  return existsSync(path) ? loadEvidenceSnapshot(path, now) : validateEvidenceSnapshot(DEFAULT_EVIDENCE_SNAPSHOT, now);
}

/** Disk-only inspection and explicit operator effort changes; no provider is resolved. */
export function inspectCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo): number {
  const home = typeof flags.home === "string" ? flags.home : kilnHome();
  initHome(home);
  const err = io.error ?? io.write;
  if (cmd[0] === "run" && cmd[1] === "record") {
    const id = cmd[2];
    if (!id || !runExists(home, id)) { err(`unknown run ${id ?? ""}\n`); return 2; }
    const record = new RunRecord(runPaths(home, id).record);
    const events = record.read();
    if (flags.json) printJson(io, events);
    else for (const event of events) io.write(`${JSON.stringify(event)}\n`);
    return 0;
  }
  const cfg = loadConfig(home);
  if (cmd[0] === "model" && cmd[1] === "roles") {
    const roles = ROLES.map((role) => ({ role, refs: cfg.roles[role], effort: cfg.effortByRole?.[role] ?? cfg.effort }));
    if (flags.json) printJson(io, roles);
    else {
      io.write("Reusable model defaults for bootstrap and legacy workflows; native task teams use task-specific responsibilities and assignments.\n");
      table(io, [["default seat", "effort", "configured models"], ...roles.map((row) => [row.role, row.effort, row.refs.join(", ")])]);
    }
    return 0;
  }
  if (cmd[0] === "model" && cmd[1] === "routing") {
    const requested = cmd[2];
    if (requested !== undefined && !ROUTING_MODES.includes(requested as RoutingMode)) {
      err("usage: kiln model routing [adaptive|manual]\n"); return 2;
    }
    if (requested !== undefined) {
      cfg.routing = { ...cfg.routing, mode: requested as RoutingMode, resources: requested === "adaptive" ? "jev" : "legacy" };
      saveConfig(home, cfg);
    }
    const mode = cfg.routing?.mode ?? "manual";
    if (flags.json) printJson(io, { mode, resources: cfg.routing?.resources ?? "legacy", effort: cfg.routing?.effort ?? "fixed" });
    else io.write(`routing: ${mode} · model selection: ${cfg.routing?.resources ?? "legacy"} · effort: ${cfg.routing?.effort ?? "fixed"}\n`);
    return 0;
  }
  if (cmd[0] === "model" && cmd[1] === "plan") {
    const seed = cmd.slice(2).join(" ").trim();
    if (!seed) { err("usage: kiln model plan <seed text> [--json]\n"); return 2; }
    try {
      const now = new Date();
      const available = new Set<string>(localAuthState(home).configured);
      if (cfg.routing?.resources === "jev") {
        const models = buildResourceCatalog(available, homeEvidenceSnapshot(home, now));
        const preview = { policy: "jev", status: "awaiting_task_decision", offline: true, liveChecked: false,
          effortPolicy: cfg.routing.effort ?? "fixed", models,
          message: "Jev selects task-specific responsibilities and model/effort pairs at dispatch; this is an eligible catalog, not preset assignments." };
        if (flags.json) printJson(io, preview);
        else {
          io.write(preview.message + "\n");
          table(io, [["eligible model", "supported effort", "input/output USD per million tokens"],
            ...models.map(model => [model.modelRef, model.efforts.join(", "), `${model.cost.input}/${model.cost.output}`])]);
        }
        return 0;
      }
      const workflow = planWorkflow(seed);
      const execution = compileWorkflow(workflow, { ...(cfg.autonomous ? { autonomous: true } : {}) });
      const planned = planAdaptiveRouting(applyWorkflowProfile(cfg, workflow), available, seed, now, homeEvidenceSnapshot(home, now), { phases: execution.phases });
      if (flags.json) printJson(io, planned.report);
      else printPlan(io, planned.report);
      return 0;
    } catch (error) {
      err(`adaptive routing preview failed: ${(error as Error).message}\n`);
      return 2;
    }
  }
  if (cmd[0] === "model" && cmd[1] === "benchmarks") {
    const action = cmd[2];
    if (action === "show") {
      try {
        const path = evidenceSnapshotPath(home);
        const snapshot = homeEvidenceSnapshot(home, new Date());
        if (flags.json) printJson(io, snapshot);
        else printEvidenceSnapshot(io, snapshot, existsSync(path));
        return 0;
      } catch (error) {
        err(`benchmark snapshot is unusable: ${(error as Error).message}\n`);
        return 2;
      }
    }
    if (action === "import") {
      const source = cmd[3];
      if (!source || flags.reviewed !== true) {
        err("usage: kiln model benchmarks import <path> --reviewed\n"); return 2;
      }
      try {
        const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));
        const snapshot = validateEvidenceSnapshot(parsed, new Date());
        writeAtomic(evidenceSnapshotPath(home), `${JSON.stringify(snapshot, null, 2)}\n`);
        io.write("Imported the operator-reviewed benchmark snapshot. Structural checks do not independently verify its benchmark claims.\n");
        return 0;
      } catch (error) {
        err(`benchmark import failed: ${(error as Error).message}\n`);
        return 2;
      }
    }
    err("usage: kiln model benchmarks show|import <path> --reviewed\n");
    return 2;
  }
  if (cmd[0] === "mode" && ["show", "set", "toggle"].includes(cmd[1] ?? "show")) {
    const action = cmd[1] ?? "show";
    const requested = cmd[2] === "ultra" ? "xhigh" : cmd[2];
    const restoreDefaults = action === "set" && requested === "auto";
    if (action === "set" && !restoreDefaults && !EFFORTS.includes(requested as Effort)) {
      err("usage: kiln mode set auto|low|medium|high|xhigh\n"); return 2;
    }
    if (action !== "show") {
      if (restoreDefaults) {
        const defaults = defaultConfig();
        cfg.effort = defaults.effort;
        cfg.effortByRole = { ...defaults.effortByRole };
        cfg.routing = { ...cfg.routing, mode: cfg.routing?.mode ?? "adaptive", effort: "adaptive" };
      } else {
        cfg.effort = action === "toggle" ? EFFORTS[(EFFORTS.indexOf(cfg.effort) + 1) % EFFORTS.length]! : requested as Effort;
        // An explicit operator mode applies to every seat; automatic sweeps remain a separate action.
        cfg.effortByRole = Object.fromEntries(ROLES.map((role) => [role, cfg.effort]));
        cfg.routing = { ...cfg.routing, mode: cfg.routing?.mode ?? "adaptive", effort: "fixed" };
      }
      saveConfig(home, cfg);
    }
    if (flags.json) printJson(io, { effort: cfg.routing?.effort === "adaptive" ? "auto" : cfg.effort, effortByRole: cfg.effortByRole,
      effortPolicy: cfg.routing?.effort ?? "fixed", fallbackEffort: cfg.effort });
    else io.write(cfg.routing?.effort === "adaptive" ? "effort: auto (Jev chooses per task; explicit effort pins take precedence)\n" : `effort: ${cfg.effort}\n`);
    return 0;
  }
  err(INSPECT_USAGE);
  return 2;
}
