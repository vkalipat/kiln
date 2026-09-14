/** One previously seen case: diagnostic fix validation, never an unbiased heldout score. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { streamSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
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
import { modelCostUsd } from "../../src/providers/models";
import { requestBody } from "./runtime-pilot";
import { reservation, settleReservation } from "./delivery-recovery-pilot";

const LIMIT = 35;
const CASE = "heldout-research-01";
const LABEL = "Diagnostic fix validation on previously seen case; not unbiased heldout evidence";
const root = resolve(import.meta.dir, "../..");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const option = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
function fingerprint() {
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);
  const paths = [...walk("src"), ...walk("bin"), ...walk("prompts"), "package.json", "bun.lock"].filter(p => existsSync(join(root, p))).sort();
  const digest = createHash("sha256");
  for (const p of paths) digest.update(p).update("\0").update(readFileSync(join(root, p))).update("\0");
  return { sourceTreeSha256: digest.digest("hex"), sourceFileCount: paths.length,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
    trackedDiffSha256: hash(execFileSync("git", ["diff", "HEAD", "--"], { cwd: root })),
    helperHashes: Object.fromEntries(["ideation-validation.ts", "runtime-pilot.ts", "delivery-recovery-pilot.ts"].map(p => [p, hash(readFileSync(join(import.meta.dir, p)))])) };
}
export function outputLimit(context: { tools?: Array<{ name: string }> }): number {
  return context.tools?.some(t => ["verdict", "critique"].includes(t.name)) ? 32768 : 16384;
}
export function admitted(charged: number, reserve: number): boolean {
  return Number.isFinite(charged) && charged >= 0 && Number.isFinite(reserve) && reserve >= 0 && charged + reserve <= LIMIT;
}
async function prepare() {
  const home = mkdtempSync(join(tmpdir(), "kiln-ideation-validation-")); chmodSync(home, 0o700);
  initHome(home, { plugAndPlay: true });
  const original = loadConfig(resolve(kilnHome()));
  // Offline selection: both frozen transports are Anthropic, with live entitlement
  // checked only after the separate paid launch is explicitly requested.
  const planned = planAdaptiveRouting(original, new Set(["anthropic"]), "general ideation comparison", new Date(), undefined, { phases: ["frame"] });
  const cfg = planned.config;
  cfg.roles = Object.fromEntries(Object.entries(planned.report.selectedRoleRefs).map(([role, ref]) => [role, [ref]])) as typeof cfg.roles;
  cfg.seating.default = structuredClone(cfg.roles);
  cfg.routing = { mode: "manual" }; cfg.provider.fallbacks = "off"; cfg.autonomous = true;
  cfg.budgets = { ...original.budgets, usd: 25, wallSeconds: 1500, share: { frame: .05, discover: .15, ideate: .4, form: .075, build: .3, reflect: .025 } };
  cfg.ideation.rounds = 1; cfg.evals.rounds = 1; cfg.evals.runBudgetUsd = 25;
  cfg.evals.runWallSeconds = 1500; cfg.evals.wallSeconds = 2700;
  saveConfig(home, cfg);
  const seeds = loadSeeds(home, "heldout");
  if (seeds[0]?.id !== CASE) throw new Error("Canonical first seed changed; refuse a different diagnostic case");
  const protocol = { version: 1, label: LABEL, preparedAt: new Date().toISOString(), home,
    provenance: fingerprint(), configSha256: hash(readFileSync(join(home, "config.json"))),
    selectedRoles: planned.report.selectedRoleRefs, effortByRole: cfg.effortByRole,
    selectedCase: { id: seeds[0].id, sha256: seeds[0].sha256, previouslySeen: true, safety: "Previously screened benign ecological acoustic-monitoring research" },
    maxSeedCells: 1, trackCapUsd: LIMIT, runTargetUsd: 25, maxRequests: 300,
    outputCaps: { general: 16384, verdictAndCritique: 32768 },
    unitWallSeconds: 1500, overallWallSeconds: 2700,
    projection: projectM1(cfg, { rounds: 1, fableLow: false, frontier: false }, 1),
    humanCalibration: "absent", learning: false, promotion: false, fallback: "off", transportRetries: false,
    changedConditions: ["Discovery now protects phase resources and limits followup retrieval", "Explicit balanced phase shares applied before freezing", "General output window increased to 16384; strict verdict/critique window to 32768", "Cancellation and output-limit classification follow repaired engine", "Single previously seen case, diagnostic only"],
    sourceFreezeRequiredBeforePaidLaunch: true };
  writeAtomic(join(home, "validation-protocol.json"), JSON.stringify(protocol, null, 2) + "\n", { mode: 0o600 });
  writeAtomic(join(home, "executed-ideation-validation.ts"), readFileSync(import.meta.filename, "utf8"), { mode: 0o600 });
  console.log(JSON.stringify({ home, protocol: join(home, "validation-protocol.json"), sourceTreeSha256: protocol.provenance.sourceTreeSha256, projection: protocol.projection, paidCalls: 0 }));
}
async function run() {
  const suppliedHome = option("--home"), expected = option("--expected-source-sha");
  if (!suppliedHome || !expected) throw new Error("Paid launch requires --home and parent-frozen --expected-source-sha");
  const home = resolve(suppliedHome), authHome = resolve(kilnHome());
  if (home === authHome || !home.includes("kiln-ideation-validation-")) throw new Error("Expected fresh isolated validation home");
  if (existsSync(join(home, "validation-execution.json"))) throw new Error("Already dispatched or attempted: refuse budget reset or duplicate execution");
  const protocol = JSON.parse(readFileSync(join(home, "validation-protocol.json"), "utf8"));
  const current = fingerprint();
  if (expected !== current.sourceTreeSha256 || expected !== protocol.provenance.sourceTreeSha256) throw new Error("Production source differs from approved protocol; prepare again after source freeze");
  if (JSON.stringify(current.helperHashes) !== JSON.stringify(protocol.provenance.helperHashes)) throw new Error("Validation helper source changed");
  if (hash(readFileSync(join(home, "config.json"))) !== protocol.configSha256) throw new Error("Frozen config changed");
  const cfg = loadConfig(home), seeds = loadSeeds(home, "heldout");
  if (seeds[0]?.id !== CASE || seeds[0].sha256 !== protocol.selectedCase.sha256) throw new Error("Diagnostic case integrity mismatch");
  const runtime = await createCliRuntime(authHome, cfg, { runtimeEffort: { enabled: false } });
  for (const role of Object.keys(cfg.roles) as Role[]) if (runtime.models(role).ref !== protocol.selectedRoles[role]) throw new Error(`Frozen role unavailable: ${role}`);
  writeAtomic(join(home, "validation-execution.json"), JSON.stringify({ startedAt: new Date().toISOString(), source: current, capUsd: LIMIT }, null, 2), { mode: 0o600 });
  const control = new RunControl(), pending = new Set<Promise<unknown>>();
  let spent = 0, charged = 0, requests = 0, milestone = 0;
  const calls: Array<Record<string, unknown>> = [];
  const ledger = () => writeAtomic(join(home, "validation-provider-ledger.json"), JSON.stringify({ spentUsd: spent, chargedUsd: charged, requests, calls }, null, 2), { mode: 0o600 });
  const capped: StreamFn = (model, context, options) => {
    control.signal.throwIfAborted();
    if (model.provider !== "anthropic") throw new Error("Unexpected provider: output isolation cannot be verified");
    const maxTokens = outputLimit(context);
    let reserve = reservation(model.cost, Buffer.byteLength(JSON.stringify(context)), maxTokens), dispatched = false;
    if (requests >= 300 || !admitted(charged, reserve)) { control.cancel("Diagnostic request or reservation cap exhausted"); throw control.signal.reason; }
    charged += reserve;
    const entry: Record<string, unknown> = { request: ++requests, model: `${model.provider}/${model.id}`, maxTokens, reserveUsd: reserve, dispatched: false, startedAt: new Date().toISOString() };
    calls.push(entry); ledger();
    const guardedFetch: FetchImpl = async (url, init) => {
      if (dispatched) throw new Error("Diagnostic transport retry disabled");
      control.signal.throwIfAborted();
      const body = await requestBody(url, init), wire = JSON.parse(body);
      if (wire.max_tokens !== maxTokens || wire.model !== model.id) throw new Error("Exact wire output/model isolation failed");
      const exact = reservation(model.cost, Buffer.byteLength(body), maxTokens);
      if (!admitted(charged - reserve, exact)) { control.cancel("Exact wire reservation exceeds total diagnostic allowance"); throw control.signal.reason; }
      charged += exact - reserve; reserve = exact; dispatched = true;
      Object.assign(entry, { reserveUsd: reserve, wireBytes: Buffer.byteLength(body), dispatched: true }); ledger();
      return coworkFetch(url, init);
    };
    const { fallbacks: _fallbacks, ...rest } = options ?? {};
    const signal = options?.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal;
    const stream = streamSimple(model, context, { ...rest, maxTokens, fetch: guardedFetch, signal, acceptEmptyResponse: true, preferWebsockets: false });
    const done = stream.result().then(message => {
      const actual = modelCostUsd(model, message.usage);
      const keep = dispatched ? settleReservation(reserve, actual, message.stopReason) : 0;
      charged += keep - reserve;
      if (Number.isFinite(actual) && actual >= 0) spent += actual;
      Object.assign(entry, { costUsd: actual, chargedUsd: keep, stopReason: message.stopReason, outputTokens: message.usage.output, finishedAt: new Date().toISOString() }); ledger();
      const next = Math.floor(spent / 10);
      if (next > milestone) { milestone = next; console.log(JSON.stringify({ milestoneUsd: milestone * 10, spentUsd: spent, chargedUsd: charged, requests })); }
      if (charged > LIMIT) control.cancel("Diagnostic allowance reached");
    }, error => { entry.error = String(error); if (!dispatched) charged -= reserve; ledger(); control.cancel("Provider failure; unknown usage retained"); });
    pending.add(done); void done.finally(() => pending.delete(done));
    return stream;
  };
  const cli = { apiKeyFor: runtime.apiKeyFor, fetchUsage: runtime.fetchUsage, streamFn: capped, runtimeEffort: { enabled: false } };
  const executor = createRunExecutor(authHome, cli), timer = setTimeout(() => control.cancel("Diagnostic overall 45-minute wall limit"), 2700000);
  let report: Awaited<ReturnType<typeof runM1>> | undefined, error: string | undefined;
  console.log(JSON.stringify({ started: home, capUsd: LIMIT, label: LABEL, sourceTreeSha256: expected }));
  try {
    report = await withRunControl(control, () => runM1(home, cfg, { budgetUsd: LIMIT, rounds: 1, fableLow: false, frontier: false, maxSeedCells: 1, evalId: "diagnostic-m1-r1", wallSeconds: 2700 }, {
      cli, executor: async spec => {
        if (spec.seedIdentity.id !== CASE) throw new Error("Diagnostic seed boundary violated before dispatch");
        const unitTimer = setTimeout(() => control.cancel("Diagnostic unit 25-minute wall limit"), 1500000);
        console.log(JSON.stringify({ unitStarted: { arm: spec.arm, seed: spec.seedIdentity.id }, spentUsd: spent, chargedUsd: charged }));
        try { const value = await executor(spec); console.log(JSON.stringify({ unitFinished: { arm: value.arm, state: value.status.state, outcome: value.outcome, costUsd: value.costUsd } })); return value; }
        finally { clearTimeout(unitTimer); }
      },
    }));
  } catch (e) { error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
  finally { clearTimeout(timer); await Promise.allSettled([...pending]); }
  const records = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() && e.name !== ".git" ? records(join(dir, e.name)) : e.isFile() && e.name === "record.jsonl" ? [join(dir, e.name)] : []);
  const recordCosts = records(home).map(path => ({ path, costUsd: new RunRecord(path).costUsd() }));
  const after = fingerprint();
  const result = { label: LABEL, home, finishedAt: new Date().toISOString(), report, error, providerObservedUsd: spent, chargedUsd: charged, requests, recordCosts,
    canonicalRecordedUsd: recordCosts.reduce((n, r) => n + r.costUsd, 0), sourceUnchanged: after.sourceTreeSha256 === expected,
    finalSource: after, humanCalibration: "absent; diagnostic only", judgedPairs: report?.comparisons.reduce((n, c) => n + c.rows.reduce((k, r) => k + r.pairs.length, 0), 0) ?? 0 };
  writeAtomic(join(home, "validation-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ home, error, canonicalRecordedUsd: result.canonicalRecordedUsd, chargedUsd: charged, judgedPairs: result.judgedPairs, result: join(home, "validation-result.json") }));
  await finishProcess(error ? 1 : 0);
}
async function selfTest() {
  assert.equal(outputLimit({}), 16384); assert.equal(outputLimit({ tools: [{ name: "verdict" }] }), 32768);
  assert.equal(outputLimit({ tools: [{ name: "critique" }] }), 32768); assert.equal(outputLimit({ tools: [{ name: "web_search" }] }), 16384);
  assert.equal(admitted(30, 5), true); assert.equal(admitted(30, 5.001), false); assert.equal(admitted(0, NaN), false);
  assert.equal(settleReservation(2, 0, "aborted"), 2); assert.equal(settleReservation(2, .5, "error"), 2); assert.equal(settleReservation(2, .5, "stop"), .5);
  assert.equal(await requestBody("https://invalid.local", { body: new TextEncoder().encode('{"max_tokens":16384}') }), '{"max_tokens":16384}');
  const cost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
  assert.ok(reservation(cost, 1000, 32768) > reservation(cost, 1000, 16384));
  console.log("ideation-validation self-test: 12 assertions passed; no network or model calls");
}
if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) await selfTest();
  else if (Bun.argv.includes("--prepare")) await prepare();
  else if (Bun.argv.includes("--confirm-spend")) await run();
  else throw new Error("Use --self-test, --prepare, or --confirm-spend --home DIR --expected-source-sha SHA after parent approval");
}
