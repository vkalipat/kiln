/** Explicit, isolated paid M1 pilot. Never calls learning or promotion. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { createCliRuntime } from "../../src/cli/runtime";
import { finishProcess } from "../../src/cli/exit";
import { loadConfig, saveConfig, type Role } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { kilnHome, writeAtomic } from "../../src/core/paths";
import { RunRecord } from "../../src/core/record";
import { RunControl, withRunControl } from "../../src/core/run-control";
import { planAdaptiveRouting } from "../../src/routing/adaptive";
import { projectM1, runM1 } from "../../src/evals/m1";
import { createRunExecutor } from "../../src/evals/executor";
import { loadSeeds } from "../../src/evals/seeds";

if (!Bun.argv.includes("--confirm-spend")) throw new Error("Explicit paid pilot requires --confirm-spend");
const root = resolve(import.meta.dir, "../..");
const authHome = resolve(kilnHome());
const home = mkdtempSync(join(tmpdir(), "kiln-ideation-pilot-"));
chmodSync(home, 0o700);
initHome(home, { plugAndPlay: true });
console.log(JSON.stringify({ artifactHome: home, targetUsd: 60, recordedAllowanceUsd: 63 }));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);
const sourcePaths = [...files("src"), ...files("bin"), ...files("prompts"), "package.json", "bun.lock"].filter(p => existsSync(join(root, p))).sort();
const sourceHash = createHash("sha256");
for (const path of sourcePaths) sourceHash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
const provenance = { head: git("rev-parse", "HEAD").toString().trim(), trackedDiffSha256: hash(git("diff", "HEAD", "--")), sourceTreeSha256: sourceHash.digest("hex"), sourceFileCount: sourcePaths.length, scriptSha256: hash(readFileSync(import.meta.filename)) };
// All 12 canonical heldout prompts were screened before dispatch: benign ecology,
// educational research, creative work and community products; no operational pathogens.
const seeds = loadSeeds(home, "heldout");
const original = loadConfig(authHome);
const authRuntime = await createCliRuntime(authHome, original, { runtimeEffort: { enabled: false } });
// Selection only. Retain the original phase shares and run budget below.
const planned = planAdaptiveRouting(original, authRuntime.available, "general ideation comparison", new Date(), undefined, { phases: ["frame"] });
const cfg = planned.config;
cfg.budgets = original.budgets;
cfg.roles = Object.fromEntries(Object.entries(planned.report.selectedRoleRefs).map(([role, ref]) => [role, [ref]])) as typeof cfg.roles;
cfg.seating.default = structuredClone(cfg.roles);
cfg.routing = { mode: "manual" };
cfg.provider.fallbacks = "off";
cfg.autonomous = true;
cfg.ideation.rounds = 1;
cfg.evals.rounds = 1;
cfg.evals.runWallSeconds = 1500;
cfg.evals.wallSeconds = 2700;
saveConfig(home, cfg);
const runtime = await createCliRuntime(authHome, cfg, { apiKeyFor: authRuntime.apiKeyFor, runtimeEffort: { enabled: false } });
const roles = Object.fromEntries((Object.keys(cfg.roles) as Role[]).map(role => [role, { ref: runtime.models(role).ref, effort: cfg.effortByRole?.[role] ?? cfg.effort }]));
const projection = projectM1(cfg, { rounds: 1, fableLow: false, frontier: false }, seeds.length, { A0: runtime.models, B0: runtime.models });
const freeze = { version: 1, home, startedAt: new Date().toISOString(), provenance, roles, projection, selection: planned.report, conditions: { frozenPrimarySeats: true, fallback: "off", learning: false, promotion: false, humanCalibration: "absent", maxTokens: 6144, maxRequests: 300, targetUsd: 60, recordedAllowanceUsd: 63, unitWallSeconds: 1500, totalWallSeconds: 2700, safetyScreen: "all canonical heldout prompts reviewed; no unsafe operational biological tasks", seedIds: seeds.map(s => s.id) } };
writeAtomic(join(home, "pilot-freeze.json"), JSON.stringify(freeze, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ roles, projection, provenance }));
const control = new RunControl();
let spent = 0, reserved = 0, requests = 0, milestone = 0;
const calls: Array<Record<string, unknown>> = [];
const pending = new Set<Promise<unknown>>();
const ledger = () => writeAtomic(join(home, "provider-ledger.json"), JSON.stringify({ spentUsd: spent, pendingReservedUsd: reserved, requests, calls }, null, 2) + "\n", { mode: 0o600 });
const cappedStream: StreamFn = (model, context, options) => {
  if (control.signal.aborted) throw control.signal.reason;
  const costs = [model.cost, ...(model.cost.longContext ? [model.cost.longContext] : [])];
  const inputRate = Math.max(...costs.flatMap(c => [c.input, c.cacheRead, c.cacheWrite]));
  const outputRate = Math.max(...costs.map(c => c.output));
  // Bytes deliberately overestimate ordinary textual prompt tokens. Overhead and
  // maximum cache-write/long-context rates make this a conservative admission guard.
  const inputBound = Buffer.byteLength(JSON.stringify(context)) + 4096;
  const reserveUsd = (inputBound * inputRate + 6144 * outputRate) / 1e6;
  if (++requests > 300 || spent + reserved + reserveUsd > 60) {
    control.cancel("pilot request reservation budget exhausted");
    throw control.signal.reason;
  }
  reserved += reserveUsd;
  const entry: Record<string, unknown> = { request: requests, model: `${model.provider}/${model.id}`, reserveUsd, inputByteBound: inputBound, startedAt: new Date().toISOString() };
  calls.push(entry); ledger();
  const signal = options?.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal;
  const stream = streamSimple(model, context, { ...options, maxTokens: 6144, signal });
  const settle = stream.result().then(message => {
    const actual = message.usage.cost.total;
    entry.costUsd = actual; entry.usage = message.usage; entry.stopReason = message.stopReason;
    // Retain the reservation when usage is unknown on failed/aborted requests.
    if (actual > 0 || !["error", "aborted"].includes(message.stopReason)) reserved -= reserveUsd;
    spent += actual;
    entry.finishedAt = new Date().toISOString(); ledger();
    const next = Math.floor(spent / 10);
    if (next > milestone) { milestone = next; console.log(JSON.stringify({ milestoneUsd: milestone * 10, spentUsd: spent, reservedUsd: reserved, requests })); }
    if (spent >= 60 || spent + reserved > 63) control.cancel("pilot recorded cost guard reached");
  }, error => { entry.error = String(error); entry.finishedAt = new Date().toISOString(); ledger(); control.cancel("provider stream failed; unknown usage retained"); });
  pending.add(settle); void settle.finally(() => pending.delete(settle));
  return stream;
};
const cli = { apiKeyFor: runtime.apiKeyFor, fetchUsage: runtime.fetchUsage, streamFn: cappedStream, runtimeEffort: { enabled: false } };
const baseExecutor = createRunExecutor(authHome, cli);
const timer = setTimeout(() => control.cancel("pilot overall 45-minute wall limit"), 2700000);
let report: unknown, error: string | undefined;
try {
  report = await withRunControl(control, () => runM1(home, cfg, { budgetUsd: 60, rounds: 1, fableLow: false, frontier: false, evalId: "live-m1-r1", wallSeconds: 2700 }, {
    cli,
    executor: async spec => {
      const unitTimer = setTimeout(() => control.cancel("pilot unit 25-minute wall limit"), 1500000);
      console.log(JSON.stringify({ unitStarted: { seed: spec.seedIdentity.id, arm: spec.arm, runId: spec.runId }, spentUsd: spent }));
      try { const result = await baseExecutor(spec); console.log(JSON.stringify({ unitFinished: { seed: result.seedId, arm: result.arm, state: result.status.state, outcome: result.outcome, costUsd: result.costUsd }, spentUsd: spent })); return result; }
      finally { clearTimeout(unitTimer); }
    },
  }));
} catch (e) { error = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e); }
finally { clearTimeout(timer); await Promise.allSettled([...pending]); }
const recordFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() && e.name !== ".git" ? recordFiles(join(dir, e.name)) : e.isFile() && e.name === "record.jsonl" ? [join(dir, e.name)] : []);
const records = recordFiles(home).map(path => ({ path, costUsd: new RunRecord(path).costUsd() }));
const outcome = { home, finishedAt: new Date().toISOString(), report, error, providerSpentUsd: spent, retainedReservationUsd: reserved, requests, records, recordedCostUsd: records.reduce((n, r) => n + r.costUsd, 0), humanCalibration: "absent; provisional pilot only" };
writeAtomic(join(home, "pilot-result.json"), JSON.stringify(outcome, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ home, error, providerSpentUsd: spent, recordedCostUsd: outcome.recordedCostUsd, requests, result: join(home, "pilot-result.json") }));
await finishProcess(error ? 1 : 0);
