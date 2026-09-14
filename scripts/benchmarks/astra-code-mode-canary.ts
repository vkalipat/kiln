/** Opt-in transport canary only. Never runs a full Kiln workflow or benchmark. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { streamSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import type { StreamFn, AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../../src/brain/agent";
import { readTool } from "../../src/brain/tools/read";
import { writeTool } from "../../src/brain/tools/write";
import { recorded, type ToolContext } from "../../src/brain/tools";
import { fail } from "../../src/brain/tools/shape";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";
import { kilnHome, writeAtomic } from "../../src/core/paths";
import { AuthStore } from "../../src/providers/auth";
import { modelCostUsd } from "../../src/providers/models";
import { reservation, settleReservation } from "./delivery-recovery-pilot";
import { requestBody } from "./runtime-pilot";

export const CANARY = Object.freeze({ provider: "openai-codex", model: "gpt-6-astra", maxRequests: 3,
  wallMs: 180_000, exposureUsd: 25, reservedOutputTokens: 128_000, effort: "low" });
const ROOT = resolve(import.meta.dir, "../..");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function canaryHashes() {
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
  const files = [...walk("src"), ...walk("bin"), ...walk("prompts"), "package.json", "bun.lock",
    "scripts/benchmarks/delivery-recovery-pilot.ts", "scripts/benchmarks/runtime-pilot.ts",
    "node_modules/@oh-my-pi/pi-ai/src/providers/openai-codex-responses.ts",
    "node_modules/@oh-my-pi/pi-ai/src/providers/cowork-fetch.ts"].sort();
  const h = createHash("sha256");
  for (const path of files) h.update(path).update("\0").update(readFileSync(join(ROOT, path))).update("\0");
  return { sourceSha256: h.digest("hex"), driverSha256: sha(readFileSync(import.meta.filename)) };
}

export function parseCanaryArgs(args: readonly string[]) {
  const allowed = new Set(["--prepare", "--live", "--out", "--expected-source-sha", "--expected-driver-sha"]);
  const values: Record<string, string> = {}; const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.has(flag) || seen.has(flag)) throw new Error("Unknown or duplicate canary argument");
    seen.add(flag);
    if (flag === "--prepare" || flag === "--live") continue;
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing canary argument value");
    values[flag] = value;
  }
  if (seen.has("--prepare") === seen.has("--live") || !values["--out"]) throw new Error("Use exactly one of --prepare/--live and provide --out");
  if (seen.has("--live") && ["--expected-source-sha", "--expected-driver-sha"].some((key) => !/^[a-f0-9]{64}$/.test(values[key] ?? ""))) {
    throw new Error("Live dispatch requires parent-approved source and driver hashes");
  }
  return { live: seen.has("--live"), out: resolve(values["--out"]!), source: values["--expected-source-sha"], driver: values["--expected-driver-sha"] };
}

/** Decode the final transformed request, including native Codex zstd compression. No body is logged. */
export async function decodedCanaryWire(url: string | URL | Request, init?: RequestInit): Promise<string> {
  const encoding = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined)).get("content-encoding");
  if (!encoding || encoding === "identity") return requestBody(url, init);
  if (encoding !== "zstd") throw new Error("Unsupported wire encoding");
  const body = init?.body instanceof Uint8Array ? init.body : url instanceof Request && !init?.body
    ? new Uint8Array(await url.clone().arrayBuffer()) : undefined;
  if (!body) throw new Error("Cannot inspect compressed request");
  return new TextDecoder("utf-8", { fatal: true }).decode(Bun.zstdDecompressSync(body));
}

export function inspectCanaryWire(body: string, cost: Parameters<typeof reservation>[0]) {
  const wire = JSON.parse(body);
  if (wire.model !== CANARY.model || !Array.isArray(wire.tools)
    || !wire.tools.some((tool: any) => tool.type === "custom" && tool.name === "exec")
    || wire.tools.some((tool: any) => tool.type !== "custom")) throw new Error("Unexpected model or non-Code-Mode wire tools");
  if (wire.max_output_tokens !== undefined || wire.max_tokens !== undefined) throw new Error("Codex output-cap assumption changed; re-freeze protocol");
  return { actualModel: wire.model as string, wireBytes: Buffer.byteLength(body), wireSha256: sha(body),
    actualOutputCap: null, reservedOutputTokens: CANARY.reservedOutputTokens,
    reservedUsd: reservation(cost, Buffer.byteLength(body), CANARY.reservedOutputTokens) };
}

export function validCanaryResult(text: string): boolean {
  try { const value = JSON.parse(text); return Boolean(value && !Array.isArray(value) && Object.keys(value).length === 1 && value.sum === 42); }
  catch { return false; }
}

export class CanaryExposure {
  requests = 0;
  chargedUsd = 0;
  reserve(amount: number) {
    if (!Number.isFinite(amount) || amount < 0 || this.requests >= CANARY.maxRequests || this.chargedUsd + amount > CANARY.exposureUsd) {
      throw new Error("Canary request/exposure limit reached");
    }
    this.requests++; this.chargedUsd += amount;
    let settled = false;
    return (actual: number, stop: string) => {
      if (settled) throw new Error("Reservation already settled");
      settled = true;
      const kept = settleReservation(amount, actual, stop);
      this.chargedUsd += kept - amount;
      return kept;
    };
  }
}

export function prepareCanary(out: string) {
  // Never reuse directories: no reset of a previous ledger, result, or approval artifact.
  mkdirSync(out, { mode: 0o700 });
  const protocol = { version: 1, label: "Astra Code Mode arithmetic transport canary; no benchmark or biology claim",
    ...CANARY, ...canaryHashes(), requestedMaxTokens: null, enforceableOutputCap: null,
    budgetMeaning: "Estimated charged exposure using final wire bytes and catalog maximum output; not a provider invoice or enforceable output token cap",
    authentication: "Existing AuthStore only; credentials never copied", input: { a: 17, b: 25 }, createdAt: new Date().toISOString() };
  writeFileSync(join(out, "protocol.json"), JSON.stringify(protocol, null, 2), { flag: "wx", mode: 0o600 });
  return protocol;
}

export async function runCanary(options: ReturnType<typeof parseCanaryArgs>) {
  if (!options.live) throw new Error("Explicit --live required");
  const protocol = JSON.parse(readFileSync(join(options.out, "protocol.json"), "utf8"));
  const hashes = canaryHashes();
  if (hashes.sourceSha256 !== options.source || hashes.driverSha256 !== options.driver
    || protocol.sourceSha256 !== options.source || protocol.driverSha256 !== options.driver
    || Object.entries(CANARY).some(([key, value]) => protocol[key] !== value)
    || JSON.stringify(protocol.input) !== JSON.stringify({ a: 17, b: 25 })) throw new Error("Frozen canary protocol/source mismatch");
  writeFileSync(join(options.out, "execution.json"), JSON.stringify({ ...hashes, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  const exposure = new CanaryExposure(); const calls: any[] = []; const pending = new Set<Promise<unknown>>();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Canary wall deadline")), CANARY.wallMs);
  const persist = () => writeAtomic(join(options.out, "provider-ledger.json"), JSON.stringify({ requests: exposure.requests,
    chargedUsd: exposure.chargedUsd, limitUsd: CANARY.exposureUsd, calls }, null, 2), { mode: 0o600 });
  let result: unknown; let failure: string | null = null; let stoppedAfterCheckedWrite = false; let readSeen = false;
  const work = join(options.out, "work"); let record: RunRecord | undefined;
  try {
    const model = getBundledModel(CANARY.provider, CANARY.model);
    if (!model || model.maxTokens !== CANARY.reservedOutputTokens) throw new Error("Catalog model/output maximum changed");
    const run = createRun(join(options.out, "runtime"), "arithmetic Code Mode canary"); record = new RunRecord(run.record);
    mkdirSync(work, { mode: 0o700 }); writeFileSync(join(work, "input.json"), JSON.stringify(protocol.input));
    const ctx: ToolContext = { cwd: work, roots: [work], run, record };
    const restrict = (tool: AgentTool<any>, file: string): AgentTool<any> => ({ ...tool,
      async execute(id, args, signal, update, context) {
        if (typeof args.path !== "string" || resolve(work, args.path) !== join(work, file)) return fail("Only the named canary file is accessible");
        return tool.execute(id, args, signal, update, context);
      } });
    const tools = [recorded(ctx, restrict(readTool(ctx), "input.json")), recorded(ctx, restrict(writeTool(ctx), "result.json"))];
    const auth = new AuthStore(join(kilnHome(), "auth.json"));
    const guarded: StreamFn = (selected, context, supplied) => {
      if (selected.provider !== CANARY.provider || selected.id !== CANARY.model) throw new Error("Unexpected dispatch identity");
      abort.signal.throwIfAborted();
      const entry: any = { requestedProvider: CANARY.provider, requestedModel: CANARY.model,
        actualProvider: selected.provider, actualModel: selected.id, requestedMaxTokens: null,
        dispatched: false, settled: false, createdAt: new Date().toISOString() };
      calls.push(entry); persist();
      let attempted = false; let settle: ReturnType<CanaryExposure["reserve"]> | undefined;
      const guardedFetch: FetchImpl = async (url, init) => {
        if (attempted) { abort.abort(new Error("Canary transport retry blocked")); throw abort.signal.reason; }
        attempted = true; abort.signal.throwIfAborted();
        if (JSON.stringify(canaryHashes()) !== JSON.stringify(hashes)) throw new Error("Canary source changed before dispatch");
        const wire = inspectCanaryWire(await decodedCanaryWire(url, init), selected.cost);
        settle = exposure.reserve(wire.reservedUsd); Object.assign(entry, wire, { dispatched: true }); persist();
        return coworkFetch(url, init);
      };
      const { fallbacks: _fallbacks, maxTokens: _ignored, ...rest } = supplied ?? {};
      const stream = streamSimple(selected, context, { ...rest, fetch: guardedFetch, preferWebsockets: false,
        codexSseMaxAttempts: 1, acceptEmptyResponse: true,
        signal: supplied?.signal ? AbortSignal.any([supplied.signal, abort.signal]) : abort.signal } as never);
      const done = stream.result().then((message) => {
        const usage = message.usage;
        const known = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((n) => Number.isFinite(n) && n >= 0)
          && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
        const cost = known ? modelCostUsd(selected, usage) : NaN;
        const identityMatches = message.provider === CANARY.provider && message.model === CANARY.model;
        Object.assign(entry, { responseProvider: message.provider, responseModel: message.model, usage, costUsd: known ? cost : null, stop: message.stopReason,
          error: !identityMatches ? "Response identity differs from requested model" : message.errorMessage ? "Provider reported an error; inspect sanitized native record" : null,
          unknownUsage: !known, retainedUsd: settle?.(cost, identityMatches ? message.stopReason : "error") ?? 0, settled: true });
        if (!identityMatches || ["error", "aborted"].includes(message.stopReason)) abort.abort(new Error("Canary provider failure"));
        persist();
      }, () => {
        Object.assign(entry, { error: "Provider stream rejected", unknownUsage: true, retainedUsd: settle?.(NaN, "error") ?? 0, settled: true });
        abort.abort(new Error("Canary provider failure")); persist();
      });
      pending.add(done); void done.finally(() => pending.delete(done));
      return stream;
    };
    const brain = createBrain({ model, getApiKey: () => auth.apiKeyFor(CANARY.provider), tools, record,
      role: "builder", phase: "build", turnCap: CANARY.maxRequests, effort: CANARY.effort,
      signal: abort.signal, streamFn: guarded, systemPrompt: ["Use the available tools to perform the arithmetic task and write the result."],
      pinned: `Read ${join(work, "input.json")} using read. Add a and b. Write ${join(work, "result.json")} as JSON with exactly the key sum. A verified write ends this canary.`,
      afterTool(event) {
        if (event.name === "read" && event.ok && event.excerpt?.includes(JSON.stringify(protocol.input))) readSeen = true;
        if (event.name === "write" && event.ok && readSeen && existsSync(join(work, "result.json"))
          && validCanaryResult(readFileSync(join(work, "result.json"), "utf8"))) {
          stoppedAfterCheckedWrite = true; return true;
        }
      } });
    const completed = await brain.run("Read the input with the tool and write the checked arithmetic result now.");
    result = { stopped: completed.stopped, turns: completed.turns, costUsd: completed.costUsd,
      error: completed.error ? "Native brain reported an error" : null, errorStatus: completed.errorStatus };
  } catch { failure = "Canary did not complete normally; inspect receipt and sanitized native record"; }
  finally {
    clearTimeout(timer); await Promise.allSettled([...pending]); persist();
    const receipt = { ...hashes, label: "Code Mode arithmetic canary only", result, failure,
      passed: Boolean(!failure && stoppedAfterCheckedWrite && readSeen && !abort.signal.aborted
        && (result as { stopped?: string } | undefined)?.stopped === "done"
        && calls.length > 0 && calls.every((call) => call.dispatched && call.settled && !call.unknownUsage && !call.error)
        && exposure.chargedUsd <= CANARY.exposureUsd),
      readSeen, stoppedAfterCheckedWrite, sourceUnchanged: JSON.stringify(canaryHashes()) === JSON.stringify(hashes),
      cancelled: abort.signal.aborted, requests: exposure.requests, chargedUsd: exposure.chargedUsd,
      recordedUsd: record?.costUsd() ?? 0, calls, finishedAt: new Date().toISOString() };
    receipt.passed &&= receipt.sourceUnchanged;
    writeAtomic(join(options.out, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    return receipt;
  }
}

if (import.meta.main) {
  const args = parseCanaryArgs(Bun.argv.slice(2));
  if (!args.live) console.log(JSON.stringify(prepareCanary(args.out)));
  else {
    const receipt = await runCanary(args);
    console.log(JSON.stringify({ receipt: join(args.out, "receipt.json"), passed: receipt.passed }));
    // All tracked streams have settled and the receipt is durable; close native idle transports.
    process.exit(receipt.passed ? 0 : 1);
  }
}
