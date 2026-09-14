/** Explicitly authorized native delivery qualification; public schema contract, not biology evaluation. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { streamSimple, createAssistantMessageEventStream, type AssistantMessageEvent, type FetchImpl } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { main } from "../../src/cli/main";
import { createCliRuntime } from "../../src/cli/runtime";
import { loadConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { kilnHome, writeAtomic } from "../../src/core/paths";
import { runPaths, readStatus } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { redactEnv, redactText } from "../../src/core/secrets";
import { RunControl, withRunControl } from "../../src/core/run-control";
import { modelCostUsd } from "../../src/providers/models";
import { loadFrozenRouting } from "../../src/workflow/routing";
import { projectPaths } from "../../src/formation/paths";
import { decodedCanaryWire } from "./astra-code-mode-canary";
import { assertDirectWorkflow, outputAllowance, sourceHash } from "./delivery-validation";
import { reservation, settleReservation } from "./delivery-recovery-pilot";

const ROOT = resolve(import.meta.dir, "../.."), ID = "vcc-schema-delivery";
export const VCC_LIMITS = { totalExposureUsd: 25, priorCanaryUsd: 0.0198, maxRequests: 40, wallMs: 1_500_000 } as const;
export const VCC_SEED = "Create and ship a dependency-free Python CLI validate_counts.py that reads one JSON document from stdin. This is a local computational count-matrix schema utility in VCC context, not official .vcc packaging, biological prediction, training, or submission. Input is an object with genes (nonempty list of unique nonblank strings), targets (nonempty list of unique nonblank strings), and cells (nonempty list of objects containing target and counts). Each target must be declared, every declared target must occur in at least one cell, and non-targeting rows/targets are forbidden (case-insensitive after trim, treating underscore as hyphen). Each counts array must match genes length and contain only finite nonnegative integers; booleans are not integers. A cell total above 1000000 is invalid; exactly 1000000 is valid. Reject duplicate or empty genes/targets, unknown targets, missing targets, malformed JSON, nonfinite/negative/fractional counts and length drift. On valid input print one JSON object with exactly cells, genes, targets as their integer counts. On any invalid input exit nonzero and emit no stdout, including no partial summary. Include executable standard-library unittest coverage and README.md with invocation examples and the local-schema-only scope. Use the native project output directory. No external research or browsing. Do not install dependencies, train models, access unrelated files, or submit anything. Finish the implemented CLI, tests, and documentation.";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function deliveryHashes() {
  return { sourceSha256: sourceHash(ROOT), driverSha256: sha(readFileSync(import.meta.filename)),
    helperHashes: Object.fromEntries(["astra-code-mode-canary.ts", "delivery-validation.ts", "delivery-recovery-pilot.ts", "runtime-pilot.ts"]
      .map((file) => [file, sha(readFileSync(join(import.meta.dir, file)))])) };
}
export interface Oracle { id: string; stdin: string; summary?: { cells: number; genes: number; targets: number } }
export function vccOracles(): Oracle[] {
  const good = { genes: ["G1", "G2"], targets: ["T1", "T2"], cells: [{ target: "T1", counts: [2, 3] }, { target: "T2", counts: [0, 5] }] };
  const changed = (id: string, change: (x: any) => void): Oracle => { const x = structuredClone(good); change(x); return { id, stdin: JSON.stringify(x) }; };
  return [
    { id: "valid", stdin: JSON.stringify(good), summary: { cells: 2, genes: 2, targets: 2 } },
    { id: "boundary", stdin: JSON.stringify({ genes: ["G"], targets: ["T"], cells: [{ target: "T", counts: [1000000] }] }), summary: { cells: 1, genes: 1, targets: 1 } },
    changed("negative", x => x.cells[1].counts[0] = -1), changed("fractional", x => x.cells[1].counts[0] = 0.5),
    changed("boolean", x => x.cells[1].counts[0] = true), changed("length", x => x.cells[1].counts.pop()),
    changed("duplicate-gene", x => x.genes[1] = x.genes[0]), changed("empty-gene", x => x.genes[1] = " "),
    changed("duplicate-target", x => x.targets[1] = x.targets[0]), changed("unknown-target", x => x.cells[1].target = "X"),
    changed("missing-target", x => x.cells.pop()), changed("non-targeting", x => { x.targets[1] = "NON_TARGETING"; x.cells[1].target = "NON_TARGETING"; }),
    changed("total", x => x.cells[1].counts = [1000000, 1]), changed("empty-genes", x => x.genes = []),
    changed("empty-targets", x => x.targets = []), changed("empty-cells", x => x.cells = []),
    ...["NaN", "Infinity", "-Infinity"].map(token => ({ id: `nonfinite-${token}`, stdin: JSON.stringify(good).replace("[0,5]", `[0,${token}]`) })),
    { id: "malformed", stdin: "{" },
  ];
}
export function oraclePass(oracle: Oracle, exit: number | null, stdout: string, signal: unknown = null): boolean {
  if (signal || exit === null) return false;
  if (!oracle.summary) return exit !== 0 && stdout === "";
  if (exit !== 0) return false;
  try { const x = JSON.parse(stdout); return x && Object.keys(x).sort().join(",") === "cells,genes,targets"
    && Object.entries(oracle.summary).every(([key, value]) => x[key] === value); } catch { return false; }
}
export function mentionsController(args: unknown, controller: string): boolean {
  const text = JSON.stringify(args) ?? "";
  return text.includes(resolve(controller)) || text.includes(basename(controller));
}
export function nativeDeliveryComplete(status: any, phases: readonly { phase: string; outcome: string }[]): boolean {
  return status?.state === "done" && status?.outcome?.kind === "success"
    && ["frame", "form", "build", "reflect"].every(phase => phases.findLast(event => event.phase === phase)?.outcome === "ok");
}
export function vccWireReservation(provider: string, modelId: string, maxOutput: number, cost: any, body: string, enforced: number) {
  const wire = JSON.parse(body);
  if (wire.model !== modelId) throw new Error("Wire model mismatch");
  if (provider === "openai-codex") {
    if (!Number.isInteger(maxOutput) || maxOutput <= 0 || wire.max_output_tokens !== undefined) throw new Error("Codex maximum assumption changed");
  } else if (provider !== "anthropic" || wire.max_tokens !== enforced) throw new Error("Unsupported transport or unenforced output cap");
  const output = provider === "openai-codex" ? maxOutput : enforced;
  return { wireBytes: Buffer.byteLength(body), wireSha256: sha(body), reservedOutputTokens: output,
    enforcedOutputTokens: provider === "openai-codex" ? null : enforced, reserveUsd: reservation(cost, Buffer.byteLength(body), output) };
}
export function prepareVcc(out: string, canaryReceipt: string) {
  const prior = JSON.parse(readFileSync(canaryReceipt, "utf8"));
  if (!prior.passed || Math.abs(prior.chargedUsd - VCC_LIMITS.priorCanaryUsd) > 1e-9) throw new Error("Canary receipt/exposure differs");
  mkdirSync(out, { mode: 0o700 });
  const home = mkdtempSync(join(tmpdir(), "kiln-vcc-delivery-worker-")); initHome(home, { plugAndPlay: true });
  const cfg = loadConfig(kilnHome()); cfg.routing = { mode: "adaptive" }; cfg.autonomous = true; cfg.provider.fallbacks = "off";
  cfg.budgets.usd = 25; cfg.budgets.wallSeconds = VCC_LIMITS.wallMs / 1000; saveConfig(home, cfg);
  const protocol = { version: 1, ...deliveryHashes(), ...VCC_LIMITS, home, canaryReceipt: resolve(canaryReceipt),
    canaryReceiptSha256: sha(readFileSync(canaryReceipt)), configSha256: sha(readFileSync(join(home, "config.json"))),
    seedSha256: sha(VCC_SEED), oracleSha256: sha(JSON.stringify(vccOracles())),
    scope: "Public contract conformance only; no biological prediction, official VCC packaging or hidden benchmark claim",
    boundary: "Native roots plus pre-execution literal controller-path argument guard; not OS isolation or protection against constructed shell paths" };
  writeFileSync(join(out, "oracles.json"), JSON.stringify(vccOracles()), { flag: "wx", mode: 0o600 });
  writeFileSync(join(out, "protocol.json"), JSON.stringify(protocol, null, 2), { flag: "wx", mode: 0o600 });
  return protocol;
}

async function gradeProject(repo: string, oracles: Oracle[]) {
  const checks: Array<{ id: string; pass: boolean; exit: number; signal: unknown; stdout: string; stderr: string }> = [];
  for (const oracle of oracles) {
    const p = Bun.spawn(["python3", "validate_counts.py"], { cwd: repo, env: redactEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(oracle.stdin); p.stdin.end();
    const timer = setTimeout(() => p.kill(), 5000);
    const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); clearTimeout(timer);
    checks.push({ id: oracle.id, pass: oraclePass(oracle, exit, stdout, p.signalCode), exit, signal: p.signalCode,
      stdout: redactText(stdout), stderr: redactText(stderr) });
  }
  const unit = Bun.spawn(["python3", "-m", "unittest", "discover", "-v"], { cwd: repo, env: redactEnv(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => unit.kill(), 30000);
  const [out, err, exit] = await Promise.all([new Response(unit.stdout).text(), new Response(unit.stderr).text(), unit.exited]); clearTimeout(timer);
  const testsRun = Number(/Ran (\d+) tests?/.exec(out + err)?.[1] ?? 0);
  return { checks, testsRun, unittestPass: exit === 0 && !unit.signalCode && testsRun > 0,
    unittest: { exit, signal: unit.signalCode, stdout: redactText(out), stderr: redactText(err) },
    readmePresent: existsSync(join(repo, "README.md")) && readFileSync(join(repo, "README.md"), "utf8").trim().length > 0 };
}

export async function liveVcc(out: string, expectedSource: string, expectedDriver: string) {
  const p = JSON.parse(readFileSync(join(out, "protocol.json"), "utf8"));
  const hashes = deliveryHashes();
  if (hashes.sourceSha256 !== expectedSource || hashes.driverSha256 !== expectedDriver
    || JSON.stringify(hashes.helperHashes) !== JSON.stringify(p.helperHashes) || p.sourceSha256 !== expectedSource || p.driverSha256 !== expectedDriver
    || p.oracleSha256 !== sha(readFileSync(join(out, "oracles.json"))) || p.seedSha256 !== sha(VCC_SEED)
    || p.configSha256 !== sha(readFileSync(join(p.home, "config.json"))) || p.canaryReceiptSha256 !== sha(readFileSync(p.canaryReceipt))
    || Object.entries(VCC_LIMITS).some(([key, value]) => p[key] !== value)) throw new Error("Frozen qualification changed");
  writeFileSync(join(out, "execution.json"), JSON.stringify({ ...hashes, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  const control = new RunControl(), pending = new Set<Promise<unknown>>(), calls: any[] = [];
  let charged = VCC_LIMITS.priorCanaryUsd as number, spent = 0, requests = 0, nativePreflight = false, code = 1;
  const ledger = () => writeAtomic(join(out, "ledger.json"), JSON.stringify({ priorExposureUsd: VCC_LIMITS.priorCanaryUsd, chargedUsd: charged, spentUsd: spent, requests, calls }, null, 2), { mode: 0o600 });
  const cfg = loadConfig(p.home), runtime = await createCliRuntime(kilnHome(), cfg, {});
  const guarded: StreamFn = (model, context, options) => {
    if (!nativePreflight) throw new Error("Native frozen routing must precede dispatch");
    const entry: any = { provider: model.provider, model: model.id, dispatched: false }; calls.push(entry);
    let attempted = false, reserved = 0;
    const maxTokens = outputAllowance(context.tools);
    const fetchGuard: FetchImpl = async (url, init) => {
      if (attempted) { control.cancel("Transport retry blocked"); throw control.signal.reason; }
      attempted = true; control.signal.throwIfAborted();
      if (sourceHash(ROOT) !== expectedSource) throw new Error("Source changed before dispatch");
      const exact = vccWireReservation(String(model.provider), model.id, model.maxTokens ?? 0, model.cost, await decodedCanaryWire(url, init), maxTokens);
      if (requests >= VCC_LIMITS.maxRequests || charged + exact.reserveUsd > VCC_LIMITS.totalExposureUsd) {
        control.cancel("Shared completion-pass exposure/request cap"); throw control.signal.reason;
      }
      requests++; reserved = exact.reserveUsd; charged += reserved; Object.assign(entry, exact, { dispatched: true, request: requests }); ledger();
      return coworkFetch(url, init);
    };
    const { fallbacks: _fallbacks, maxTokens: _max, ...rest } = options ?? {};
    const stream = streamSimple(model, context, { ...rest, ...(model.provider === "anthropic" ? { maxTokens } : {}), fetch: fetchGuard,
      signal: options?.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal,
      codexSseMaxAttempts: 1, preferWebsockets: false, acceptEmptyResponse: true } as never);
    // Buffer this turn so literal controller accesses are rejected BEFORE native tool execution.
    const checked = createAssistantMessageEventStream();
    const done = (async () => {
      try {
        const events: AssistantMessageEvent[] = []; for await (const event of stream) events.push(event);
        const message = await stream.result();
        const known = [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite].every(n => Number.isFinite(n) && n >= 0)
          && message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0;
        const actual = known ? modelCostUsd(model, message.usage) : NaN;
        const access = message.content.some(x => x.type === "toolCall" && mentionsController(x.arguments, out));
        const bad = access || !known || message.provider !== model.provider || message.model !== model.id || ["error", "aborted"].includes(message.stopReason)
          || Boolean(message.errorMessage) || (message as any).stopDetails?.type === "refusal";
        const kept = entry.dispatched ? settleReservation(reserved, actual, bad ? "error" : message.stopReason) : 0;
        charged += kept - reserved; if (known) spent += actual;
        Object.assign(entry, { usage: message.usage, costUsd: known ? actual : null, retainedUsd: kept, unknownUsage: !known,
          stop: message.stopReason, responseProvider: message.provider, responseModel: message.model, blockedControllerAccess: access, failed: bad, settled: true }); ledger();
        if (bad || charged > VCC_LIMITS.totalExposureUsd) { control.cancel("Provider/refusal/access/accounting failure"); checked.fail(control.signal.reason); }
        else { for (const event of events) checked.push(event); checked.end(message); }
      } catch {
        if (!entry.settled) Object.assign(entry, { unknownUsage: true, retainedUsd: reserved, failed: true, settled: true });
        ledger(); control.cancel("Provider stream failure"); checked.fail(control.signal.reason);
      }
    })(); pending.add(done); void done.finally(() => pending.delete(done)); return checked;
  };
  const timer = setTimeout(() => control.cancel("Qualification wall deadline"), VCC_LIMITS.wallMs);
  try {
    code = await withRunControl(control, () => main(["run", "new", VCC_SEED, "--id", ID, "--home", p.home, "--through", "reflect", "--autonomous", "--yes", "--json"],
      { write: () => {}, error: () => {} }, { apiKeyFor: runtime.apiKeyFor, fetchUsage: runtime.fetchUsage, streamFn: guarded,
        onRun(run) { const direct = assertDirectWorkflow(run); const routing = loadFrozenRouting(run); if (!routing) throw new Error("Missing adaptive routing");
          nativePreflight = true; writeAtomic(join(out, "native-plan.json"), JSON.stringify({ direct, routing }, null, 2), { mode: 0o600 }); } }));
  } catch { code = 1; }
  finally { clearTimeout(timer); await Promise.allSettled([...pending]); ledger(); }
  const run = runPaths(p.home, ID), record = existsSync(run.record) ? new RunRecord(run.record) : undefined;
  const events = record?.read() ?? [], repo = projectPaths(run.project).repo;
  const grading = existsSync(join(repo, "validate_counts.py")) ? await gradeProject(repo, JSON.parse(readFileSync(join(out, "oracles.json"), "utf8"))) : null;
  const status = existsSync(run.status) ? readStatus(run) : null;
  const phaseOutcomes = events.filter(e => e.t === "phase.end");
  const receipt = { scope: p.scope, boundary: p.boundary, ...hashes, home: p.home, code, status, nativePreflight,
    sourceUnchanged: sourceHash(ROOT) === expectedSource, cancelled: control.signal.aborted, phaseOutcomes,
    criticObserved: events.some(e => e.t === "model.call" && e.role === "critic"), auditorObserved: events.some(e => e.t === "model.call" && e.role === "auditor"),
    grading, requests, spentUsd: spent, chargedUsd: charged, priorCanaryUsd: VCC_LIMITS.priorCanaryUsd, recordedUsd: record?.costUsd() ?? 0,
    reflectionCompleted: phaseOutcomes.some(e => e.phase === "reflect" && e.outcome === "ok"),
    passed: false };
  receipt.passed = code === 0 && nativeDeliveryComplete(status, phaseOutcomes) && !receipt.cancelled && receipt.sourceUnchanged && receipt.criticObserved && receipt.auditorObserved && receipt.reflectionCompleted
    && Boolean(grading?.unittestPass && grading.readmePresent && grading.checks.every(x => x.pass)) && !calls.some(x => x.failed);
  writeAtomic(join(out, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 }); return receipt;
}

if (import.meta.main) {
  const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
  const out = arg("--out"); if (!out || Bun.argv.includes("--prepare") === Bun.argv.includes("--live")) throw new Error("Use --prepare or --live with --out");
  if (Bun.argv.includes("--prepare")) { const prior = arg("--canary-receipt"); if (!prior) throw new Error("Existing canary receipt required"); console.log(JSON.stringify(prepareVcc(resolve(out), prior))); }
  else { const source = arg("--expected-source-sha"), driver = arg("--expected-driver-sha"); if (!source || !driver) throw new Error("Explicit source/driver approval hashes required");
    const receipt = await liveVcc(resolve(out), source, driver); console.log(JSON.stringify({ receipt: join(resolve(out), "receipt.json"), passed: receipt.passed })); process.exit(receipt.passed ? 0 : 1); }
}
