import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionFactory, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getBundledModel, type Model } from "@oh-my-pi/pi-catalog";
import { streamSimple, type Context, type FetchImpl, type Usage } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { Tokenizer, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { RunPaths } from "../core/run";
import { writeAtomic } from "../core/paths";
import { modelCostUsd } from "../providers/models";
import { OperatorBudget, OperatorBudgetError, type OperatorTicket } from "./budget";
import { createMeterLedger, readOperatorLedger } from "./meter-ledger";

export interface OperatorMeterRow {
  id: number; sessionId: string; lane: "sdk" | "legacy" | "maintenance" | "external";
  provider: string; model: string; reservedUsd: number; chargedUsd: number;
  state: "reserved" | "settled" | "unknown"; payloadBytes?: number; payloadSha256?: string;
  inputTokensCounted?: number; inputTokensEstimated?: number; inputEstimateMethod?: string; reservedOutputTokens?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  costUsd?: number; stop?: string; reason?: string;
}
export interface OperatorMeterSnapshot {
  version: 1; runId: string; limitUsd: number | null; chargedUsd: number; knownCostUsd: number;
  coverage: "estimated-exposure-not-invoice-ceiling";
  gaps: string[]; rows: OperatorMeterRow[]; seenMaintenance: string[];
}
export interface OperatorMeterChange { row: OperatorMeterRow; previous?: OperatorMeterRow }
export interface OperatorMeterOptions {
  run: Pick<RunPaths, "id" | "dir">; limitUsd: number | null; deadline?: number; signal?: AbortSignal;
  /** Must abort the whole operator tree: SDK extension errors are notification-only. */
  onViolation: (error: Error) => void;
  onUsage?: (snapshot: OperatorMeterSnapshot) => void;
  /** Incremental runtime observer; initial rows are supplied once, then only changed rows. */
  onChange?: (summary: Omit<OperatorMeterSnapshot, "rows">, changes: readonly OperatorMeterChange[], initial: boolean) => void;
  ledgerPath?: string; models?: readonly Model[];
  /** Optional child-specific cancellation source unavailable on SDK ExtensionContext itself. */
  sessionSignal?: (sessionId: string) => AbortSignal | undefined;
  /** Must remain below SDK's 30s extension timeout. */
  hookWaitMs?: number;
  streamImpl?: typeof streamSimple; fetchImpl?: FetchImpl;
}
export interface ExternalMeterReservation {
  provider: string; model: string; reservedUsd: number; signal?: AbortSignal; sessionId?: string;
}
export interface ExternalMeterSettlement {
  costUsd?: number; inputTokens?: number; outputTokens?: number; reason?: string;
}
export interface ExternalMeterTicket {
  /** Call immediately before transport. False means cancelled or closed; do not dispatch. */
  dispatch(): boolean;
  /** Missing or invalid cost/usage retains the reservation as unknown exposure. */
  settle(result?: ExternalMeterSettlement): void;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function rates(model: Model) {
  const cost = model.cost as any, tiers = [cost, ...(cost.longContext ? [cost.longContext] : [])];
  const input = Math.max(...tiers.flatMap(t => [t.input * 2, t.cacheRead ?? 0, t.cacheWrite ?? 0]));
  const output = Math.max(...tiers.map(t => t.output));
  if (![input, output].every(n => Number.isFinite(n) && n >= 0)) throw new Error("Unknown model pricing");
  return { input, output };
}
export const OPERATOR_INPUT_ESTIMATE = { safetyFactor: 1.25, framingTokens: 8192 } as const;
/** SDK local tokenizer over serialized input plus estimation headroom, NOT an enforced bound.
 * Astra has no catalog tokenizer, so SDK o200k_base is a proxy. Provider framing and opaque
 * reasoning may bill differently. Never clamp to unenforced catalog contextWindow. A single
 * framing allowance replaces byte/token conflation and separate64KiB padding. Codex retains
 * its complete catalog output maximum because requested output caps are ignored. */
export function operatorReservation(model: Model, payload: unknown) {
  const text = JSON.stringify(payload); if (text === undefined) throw new Error("Uninspectable provider payload");
  const p = payload as any, r = rates(model), bytes = Buffer.byteLength(text);
  if (!p || typeof p !== "object" || (p.model !== undefined && p.model !== model.id)) throw new Error("Provider model identity mismatch");
  const cap = model.provider === "anthropic" && Number.isSafeInteger(p.max_tokens) && p.max_tokens > 0 ? p.max_tokens : model.maxTokens;
  if (!Number.isSafeInteger(cap) || !cap || cap < 1) throw new Error("Missing model output maximum");
  const count = new Tokenizer(model).checkTokenBudget(text, 0);
  const inputTokensEstimated = Math.ceil(count.tokens * OPERATOR_INPUT_ESTIMATE.safetyFactor) + OPERATOR_INPUT_ESTIMATE.framingTokens;
  return { reservedUsd: (inputTokensEstimated * r.input + cap * r.output) / 1e6, payloadBytes: bytes, payloadSha256: sha(text),
    inputTokensCounted: count.tokens, inputTokensEstimated,
    inputEstimateMethod: `${count.exact ? model.tokenizer ?? "o200k_base-proxy" : "sdk-byte-fallback"}; local-estimate x1.25 +8192 framing tokens; not enforced`,
    reservedOutputTokens: cap };
}
function estimateMetadata(estimate: ReturnType<typeof operatorReservation>) {
  const { reservedUsd: _reservedUsd, ...metadata } = estimate; return metadata;
}
function knownUsage(value: any): value is Usage {
  return Boolean(value && [value.input, value.output, value.cacheRead, value.cacheWrite].every(n => Number.isFinite(n) && n >= 0)
    && value.input + value.output + value.cacheRead + value.cacheWrite > 0);
}
function counters(value: Usage) { return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
  totalTokens: Number.isFinite(value.totalTokens) ? value.totalTokens : value.input + value.output + value.cacheRead + value.cacheWrite }; }

/** One instance per operator tree. Install extension last; streamFn is ONLY for legacy createBrain. */
export function createOperatorMeter(options: OperatorMeterOptions) {
  const path = options.ledgerPath ?? join(options.run.dir, "operator-meter.json");
  mkdirSync(dirname(path), { recursive: true });
  const waitMs = options.hookWaitMs ?? 20_000;
  if (!Number.isFinite(waitMs) || waitMs < 1 || waitMs >= 29_000) throw new Error("Meter hook deadline must be below SDK handler timeout");
  const old = readOperatorLedger(path);
  if (old && (old.version !== 1 || old.runId !== options.run.id || old.limitUsd !== options.limitUsd || !Array.isArray(old.rows)
    || !Number.isFinite(old.chargedUsd) || old.chargedUsd < 0)) throw new Error("Invalid or mismatched operator ledger; refuse reset");
  const rows = old?.rows ?? [], gaps = old?.gaps ?? [], seen = new Set(old?.seenMaintenance ?? []);
  if (rows.some((row, index) => row.id !== index + 1 || typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > 512
    || !["sdk", "legacy", "maintenance", "external"].includes(row.lane) || !["reserved", "settled", "unknown"].includes(row.state)
    || !Number.isFinite(row.chargedUsd) || row.chargedUsd < 0 || !Number.isFinite(row.reservedUsd) || row.reservedUsd < 0
    || (row.costUsd !== undefined && (!Number.isFinite(row.costUsd) || row.costUsd < 0)))) throw new Error("Invalid persisted exposure");
  for (const row of rows) if (row.state === "reserved") { row.state = "unknown"; row.chargedUsd = Math.max(row.chargedUsd, row.reservedUsd); row.reason = "Interrupted request retained on resume"; }
  const prior = Math.max(old?.chargedUsd ?? 0, rows.reduce((n, row) => n + row.chargedUsd, 0));
  const budget = new OperatorBudget(options.limitUsd, prior), abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const tickets = new Map<number, OperatorTicket>(), pending = new Map<string, OperatorMeterRow[]>(), contexts = new Map<string, ExtensionContext>();
  const compact = new Map<string, OperatorMeterRow>(), boundCompacts = new Set<number>();
  const preCalls = new Map<string, OperatorMeterRow>();
  let closed = false, violation: Error | undefined;
  let knownCostUsd = rows.reduce((n, row) => n + (row.costUsd ?? 0), 0);
  const publishedRows = new Map(rows.map(row => [row.id, { ...row }]));
  const summary = (): Omit<OperatorMeterSnapshot, "rows"> => ({ version: 1, runId: options.run.id, limitUsd: options.limitUsd,
    chargedUsd: budget.chargedUsd, knownCostUsd, coverage: "estimated-exposure-not-invoice-ceiling", gaps: [...gaps], seenMaintenance: [...seen] });
  const usage = (): OperatorMeterSnapshot => ({ version: 1, runId: options.run.id, limitUsd: options.limitUsd, chargedUsd: budget.chargedUsd,
    knownCostUsd, coverage: "estimated-exposure-not-invoice-ceiling",
    gaps: [...gaps], rows: rows.map(row => ({ ...row, ...(row.usage ? { usage: { ...row.usage } } : {}) })), seenMaintenance: [...seen] });
  const ledger = createMeterLedger(path, old?.journalSequence ?? 0, usage);
  const persist = (row?: OperatorMeterRow) => {
    const previous = row ? publishedRows.get(row.id) : undefined;
    const next = row ? { ...row, ...(row.usage ? { usage: { ...row.usage } } : {}) } : undefined;
    if (row) { knownCostUsd += (row.costUsd ?? 0) - (previous?.costUsd ?? 0); publishedRows.set(row.id, next!); }
    const totals = summary(); ledger.append(totals, row);
    options.onChange?.(totals, next ? [{ row: next, previous }] : [], false);
    if (options.onUsage) options.onUsage(usage());
  };
  const violate = (reason: string, ctx?: ExtensionContext) => {
    ctx?.abort();
    if (!violation) { violation = new Error(reason); abort.abort(violation); for (const context of contexts.values()) context.abort(); options.onViolation(violation); }
  };
  const deny = (error: unknown, ctx: ExtensionContext | undefined, fallback: string) => {
    const child = ctx && ctx.sessionManager.getSessionId() !== contexts.keys().next().value;
    if (child && error instanceof OperatorBudgetError) ctx.abort();
    else violate(error instanceof OperatorBudgetError ? error.message : fallback, ctx);
  };
  const gap = (reason: string, ctx?: ExtensionContext) => { if (!gaps.includes(reason)) gaps.push(reason); persist(); violate(reason, ctx); };
  const deadlineTimer = options.deadline === undefined ? undefined : setTimeout(() => violate("Operator deadline reached"), Math.max(0, options.deadline - Date.now()));
  deadlineTimer?.unref();
  function scope(ctx?: ExtensionContext, supplied?: AbortSignal) {
    const child = ctx ? options.sessionSignal?.(ctx.sessionManager.getSessionId()) : undefined;
    return AbortSignal.any([signal, ...(child ? [child] : []), ...(supplied ? [supplied] : [])]);
  }
  async function admit(amount: number, ctx?: ExtensionContext, supplied?: AbortSignal, heldUsd = 0) {
    if (closed) throw new Error("Operator meter closed");
    const scoped = scope(ctx, supplied); scoped.throwIfAborted();
    const timeout = new AbortController();
    const timer = ctx ? setTimeout(() => {
      const error = new OperatorBudgetError("Operator admission wait exceeded SDK hook deadline");
      deny(error, ctx, error.message); timeout.abort(error);
    }, waitMs) : undefined;
    let ticket: OperatorTicket;
    try {
      ticket = await budget.acquire(amount, AbortSignal.any([scoped, timeout.signal]), heldUsd);
      if (scoped.aborted || closed) { ticket.settle(0); throw scoped.reason ?? new Error("Operator meter closed"); }
    } catch (error) {
      if (ctx && error instanceof OperatorBudgetError) deny(error, ctx, error.message);
      if (ctx) ctx.abort(); throw error;
    } finally { if (timer) clearTimeout(timer); }
    return ticket;
  }
  async function reserve(model: Model, amount: number, sessionId: string, lane: OperatorMeterRow["lane"], ctx?: ExtensionContext, supplied?: AbortSignal) {
    const ticket = await admit(amount, ctx, supplied);
    const scoped = scope(ctx, supplied);
    if (scoped.aborted || closed) { ticket.settle(0); throw scoped.reason ?? new Error("Operator meter closed"); }
    const row: OperatorMeterRow = { id: rows.length + 1, sessionId, lane, provider: String(model.provider), model: model.id,
      reservedUsd: amount, chargedUsd: amount, state: "reserved" };
    rows.push(row); tickets.set(row.id, ticket); persist(row); return row;
  }
  function settle(row: OperatorMeterRow, model: Model, raw: any, stop?: string) {
    if (row.state !== "reserved") return;
    const known = knownUsage(raw); const cost = known ? modelCostUsd(model, raw) : undefined;
    const retain = !known || !Number.isFinite(cost) || ["error", "aborted"].includes(stop ?? "");
    row.chargedUsd = tickets.get(row.id)!.settle(retain ? Math.max(row.reservedUsd, cost ?? 0) : cost);
    tickets.delete(row.id); row.state = retain ? "unknown" : "settled";
    row.provider = String(model.provider); row.model = model.id;
    if (known) { row.usage = counters(raw); if (Number.isFinite(cost)) row.costUsd = cost; }
    row.stop = stop; persist(row); if (options.limitUsd !== null && budget.chargedUsd > options.limitUsd) violate("Observed cost exceeds operator exposure limit");
  }
  /** Optional external calls never wait on a parent model reservation or stop the tree on denial. */
  async function reserveExternal(request: ExternalMeterReservation): Promise<ExternalMeterTicket | undefined> {
    if (typeof request.provider !== "string" || !request.provider.trim() || request.provider.length > 256
      || typeof request.model !== "string" || !request.model.trim() || request.model.length > 256
      || !Number.isFinite(request.reservedUsd) || request.reservedUsd < 0) throw new Error("Invalid external meter reservation");
    const scoped = scope(undefined, request.signal);
    if (closed || scoped.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)
      || budget.queuedCount > 0 || (options.limitUsd !== null && budget.chargedUsd + request.reservedUsd > options.limitUsd)) return undefined;
    // acquire drains synchronously. No await between the headroom check and acquisition:
    // another request cannot take these funds and turn this optional admission into a wait.
    const acquired = budget.acquire(request.reservedUsd, scoped);
    const ticket = await acquired;
    if (closed || scoped.aborted) { ticket.settle(0); return undefined; }
    const row: OperatorMeterRow = { id: rows.length + 1, sessionId: request.sessionId ?? "external", lane: "external",
      provider: request.provider, model: request.model, reservedUsd: request.reservedUsd,
      chargedUsd: request.reservedUsd, state: "reserved" };
    rows.push(row); tickets.set(row.id, ticket);
    let dispatched = false;
    const finish = (result: ExternalMeterSettlement = {}) => {
      if (row.state !== "reserved") return;
      const validTokens = [result.inputTokens, result.outputTokens].every(value => value === undefined || (Number.isSafeInteger(value) && value >= 0));
      const known = Number.isFinite(result.costUsd) && result.costUsd! >= 0 && validTokens;
      row.chargedUsd = ticket.settle(known ? result.costUsd : undefined);
      tickets.delete(row.id); row.state = known ? "settled" : "unknown";
      if (known) {
        row.costUsd = result.costUsd;
        if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
          const input = result.inputTokens ?? 0, output = result.outputTokens ?? 0;
          row.usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output };
        }
      }
      row.reason = typeof result.reason === "string" ? result.reason.slice(0, 1024) : known ? "External usage settled" : "External usage unavailable; reservation retained";
      scoped.removeEventListener("abort", onAbort); persist(row);
      if (options.limitUsd !== null && budget.chargedUsd > options.limitUsd) violate("Observed cost exceeds operator exposure limit");
    };
    const onAbort = () => finish(dispatched ? { reason: "External request cancelled after dispatch; reservation retained" }
      : { costUsd: 0, reason: "External request cancelled before dispatch" });
    scoped.addEventListener("abort", onAbort, { once: true });
    // Durable exposure must exist before the caller gets authority to dispatch.
    persist(row);
    if (scoped.aborted) onAbort();
    return {
      dispatch() {
        if (row.state !== "reserved" || dispatched) return false;
        if (closed || scoped.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) {
          finish({ costUsd: 0, reason: "External request cancelled before dispatch" }); return false;
        }
        dispatched = true; return true;
      },
      settle: finish,
    };
  }
  const modelFor = (provider: string, id: string) => options.models?.find(m => m.provider === provider && m.id === id) ?? getBundledModel(provider as never, id);
  function maintenance(ctx: ExtensionContext, group?: OperatorMeterRow) {
    const sid = ctx.sessionManager.getSessionId(), coveredCompaction = Boolean(group); let found = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "model_usage" || seen.has(`${sid}:${entry.id}`)) continue;
      seen.add(`${sid}:${entry.id}`); found = true;
      const model = modelFor(entry.provider, entry.model);
      const admitted = group?.state === "reserved" ? group : coveredCompaction
        ? (pending.get(sid) ?? []).find(row => row.state === "reserved" && row.provider === entry.provider && row.model === entry.model) : undefined;
      if (admitted && model) {
        settle(admitted, model, entry.usage, entry.stopReason);
        pending.set(sid, (pending.get(sid) ?? []).filter(row => row.id !== admitted.id)); group = undefined;
      }
      else if (group?.state === "settled" && group.provider === entry.provider && group.model === entry.model
        && knownUsage(entry.usage) && JSON.stringify(group.usage) === JSON.stringify(counters(entry.usage))) { group = undefined; }
      else {
        const known = model && knownUsage(entry.usage), cost = known ? modelCostUsd(model, entry.usage) : undefined;
        // Maintenance outside a request hook was already billed. Record it even when over budget.
        const row: OperatorMeterRow = { id: rows.length + 1, sessionId: sid, lane: "maintenance", provider: entry.provider, model: entry.model,
          reservedUsd: 0, chargedUsd: cost ?? 0, state: known ? "settled" : "unknown", reason: "Unreserved durable maintenance usage",
          ...(known ? { usage: counters(entry.usage), costUsd: cost } : {}) };
        rows.push(row);
        // Account uncovered cost in the same total without pretending it had dispatch admission.
        budget.chargeUnreserved(cost ?? 0);
        persist(row);
        gap("SDK maintenance call bypassed operator request admission", ctx);
      }
    }
    return found;
  }
  const snapshot = usage;
  /** Wire to the SDK Agent's additive native gate, inherited by children; NOT a stream override. */
  async function beforeModelCall(ctx: ExtensionContext, prepared: Context, requestSignal?: AbortSignal): Promise<boolean> {
    const sid = ctx.sessionManager.getSessionId(); contexts.set(sid, ctx);
    try {
      maintenance(ctx); const scoped = scope(ctx, requestSignal); scoped.throwIfAborted();
      if (!ctx.model) throw new Error("Native gate lacks model identity");
      // This is a conservative input estimate, not an exact final-wire or invoice guarantee.
      // The final payload hook reconciles its size against the SAME ticket before transport.
      const estimate = operatorReservation(ctx.model, { model: ctx.model.id, context: prepared });
      const previous = preCalls.get(sid);
      if (previous?.state === "reserved") settle(previous, ctx.model, undefined, "error");
      // Native gate is not under the extension runner's 30-second timeout.
      const row = await reserve(ctx.model, estimate.reservedUsd, sid, "sdk", undefined, scoped);
      Object.assign(row, estimateMetadata(estimate), { reason: "Native gate: SDK local input-token estimate with single framing allowance" });
      if (scoped.aborted) {
        tickets.get(row.id)!.settle(0); tickets.delete(row.id); row.chargedUsd = 0; row.state = "settled"; persist(row); return false;
      }
      preCalls.set(sid, row); persist(row); return true;
    } catch (error) {
      if (scope(ctx, requestSignal).aborted && !signal.aborted) ctx.abort();
      else deny(error, ctx, "Native operator admission failed");
      return false;
    }
  }
  const extension: ExtensionFactory = pi => {
    pi.on("session_start", (_event, ctx) => { contexts.set(ctx.sessionManager.getSessionId(), ctx); maintenance(ctx); });
    pi.on("before_provider_request", async (event, ctx) => {
      const sid = ctx.sessionManager.getSessionId(); contexts.set(sid, ctx);
      try {
        maintenance(ctx); scope(ctx).throwIfAborted();
        if (!ctx.model) throw new Error("SDK provider request lacks model identity");
        const estimate = operatorReservation(ctx.model, event.payload);
        const group = preCalls.get(sid) ?? compact.get(sid); preCalls.delete(sid);
        let row: OperatorMeterRow;
        if (group?.state === "reserved" && !boundCompacts.has(group.id)) {
          if (estimate.reservedUsd > group.reservedUsd) {
            // Top up only the difference: waiting for a second full reservation could deadlock on our own pre-reserve.
            const extra = await admit(estimate.reservedUsd - group.reservedUsd, ctx, undefined, group.reservedUsd), original = tickets.get(group.id)!;
            const total = estimate.reservedUsd;
            tickets.set(group.id, { reservedUsd: total, settle: actual => {
              if (actual === undefined) return original.settle() + extra.settle();
              return original.settle(Math.min(actual, original.reservedUsd)) + extra.settle(Math.max(0, actual - original.reservedUsd));
            } });
            group.reservedUsd = total; group.chargedUsd = total;
          }
          boundCompacts.add(group.id); row = group;
        } else row = await reserve(ctx.model, estimate.reservedUsd, sid, "sdk", ctx);
        Object.assign(row, { ...estimateMetadata(estimate),
          provider: String(ctx.model.provider), model: ctx.model.id }); // Never persist payloads or headers.
        (pending.get(sid) ?? (pending.set(sid, []), pending.get(sid)!)).push(row); persist(row);
      } catch (error) {
        if (scope(ctx).aborted && !signal.aborted) ctx.abort();
        else deny(error, ctx, "SDK request admission failed");
        throw error;
      }
      return event.payload;
    });
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const sid = ctx.sessionManager.getSessionId(), queue = pending.get(sid) ?? [];
      const row = queue.pop() ?? preCalls.get(sid); preCalls.delete(sid);
      if (!row) { if (knownUsage(event.message.usage)) gap("SDK assistant usage without request admission", ctx); return; }
      for (const earlier of queue.splice(0)) { const earlierModel = modelFor(earlier.provider, earlier.model); if (earlierModel) settle(earlier, earlierModel, undefined, "error"); }
      const model = modelFor(row.provider, row.model) ?? ctx.model;
      if (!model) { gap("SDK settlement model unavailable", ctx); return; }
      if (event.message.provider !== row.provider || event.message.model !== row.model) { settle(row, model, undefined, "error"); gap("SDK response model identity mismatch", ctx); return; }
      settle(row, model, event.message.usage, event.message.stopReason);
    });
    pi.on("session_before_compact", async (_event, ctx) => {
      try {
        const pool = options.models?.length ? options.models : ctx.model ? [ctx.model] : [];
        const estimates = pool.map(model => { const r = rates(model);
          if (!model.contextWindow || !model.maxTokens) throw new Error("Unknown maintenance model bounds");
          return { model, amount: (model.contextWindow * r.input + model.maxTokens * r.output) / 1e6 }; });
        const worst = estimates.sort((a, b) => b.amount - a.amount)[0]; if (!worst) throw new Error("No admitted maintenance model bounds");
        const sid = ctx.sessionManager.getSessionId(); contexts.set(sid, ctx); maintenance(ctx);
        compact.set(sid, await reserve(worst.model, worst.amount, sid, "maintenance", ctx));
      } catch (error) { if (scope(ctx).aborted && !signal.aborted) ctx.abort(); else deny(error, ctx, "Compaction exposure admission failed"); return { cancel: true }; }
    });
    pi.on("session_compact", (event, ctx) => {
      const sid = ctx.sessionManager.getSessionId(), row = compact.get(sid); compact.delete(sid);
      if (row) pending.set(sid, (pending.get(sid) ?? []).filter(item => item.id !== row.id));
      const found = maintenance(ctx, row);
      const details = event.compactionEntry.details as { usage?: unknown; provider?: string; model?: string } | undefined;
      if (row?.state === "reserved") {
        const model = details?.provider && details.model ? modelFor(details.provider, details.model)
          : boundCompacts.has(row.id) ? modelFor(row.provider, row.model) : undefined;
        if (!found && model && knownUsage(details?.usage)) settle(row, model, details.usage, "stop");
        else {
          if (knownUsage(details?.usage)) row.usage = counters(details.usage);
          const reservedModel = modelFor(row.provider, row.model) ?? ctx.model;
          if (reservedModel) settle(row, reservedModel, undefined, "error");
          gap("Compaction completed without attributable usage; worst reservation retained", ctx);
        }
      } else if (!row && !found && !event.fromExtension) gap("Compaction lacked operator admission and usage", ctx);
      persist();
    });
  };
  const streamFn: StreamFn = (model, context, supplied) => {
    const scoped = scope(undefined, supplied?.signal); scoped.throwIfAborted();
    let row: OperatorMeterRow | undefined, attempted = false;
    const guard: FetchImpl = async (url, init) => {
      if (attempted) { violate("Legacy transport retry blocked"); throw violation; } attempted = true;
      const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
      const bytes = init?.body instanceof Uint8Array ? init.body : typeof init?.body === "string" ? new TextEncoder().encode(init.body)
        : url instanceof Request ? new Uint8Array(await url.clone().arrayBuffer()) : undefined;
      if (!bytes) { violate("Uninspectable legacy provider body"); throw violation; }
      const encoding = headers.get("content-encoding"), decoded = encoding === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
      if (encoding && !["identity", "zstd"].includes(encoding)) { violate("Unsupported legacy wire encoding"); throw violation; }
      const estimate = operatorReservation(model, JSON.parse(new TextDecoder().decode(decoded)));
      try { row = await reserve(model, estimate.reservedUsd, "legacy", "legacy", undefined, scoped); }
      catch (error) { if (error instanceof OperatorBudgetError) violate(error.message); throw error; }
      if (scoped.aborted) {
        tickets.get(row.id)!.settle(0); tickets.delete(row.id); row.chargedUsd = 0; row.state = "settled";
        row.reason = "Cancelled before transport dispatch"; persist(row); throw scoped.reason;
      }
      Object.assign(row, estimate); persist(row); return (options.fetchImpl ?? coworkFetch)(url, init);
    };
    const { fallbacks: _fallbacks, ...rest } = supplied ?? {};
    const stream = (options.streamImpl ?? streamSimple)(model, context, { ...rest, signal: scoped, fetch: guard, preferWebsockets: false, codexSseMaxAttempts: 1 } as never);
    const done = stream.result().then(message => { if (row) settle(row, model, message.usage, message.stopReason); }, () => { if (row) settle(row, model, undefined, "error"); });
    legacyPending.add(done); void done.finally(() => legacyPending.delete(done)); return stream;
  };
  const legacyPending = new Set<Promise<unknown>>();
  options.onChange?.(summary(), rows.map(row => ({ row: { ...row } })), true);
  options.onUsage?.(usage());
  return { extension, beforeModelCall, reserveExternal, streamFn, signal, usage: snapshot,
    async close() {
      if (closed) return snapshot(); closed = true; abort.abort(new Error("Operator meter closed"));
      if (deadlineTimer) clearTimeout(deadlineTimer); await Promise.allSettled([...legacyPending]);
      for (const ctx of contexts.values()) maintenance(ctx);
      for (const row of rows) if (row.state === "reserved") {
        const model = modelFor(row.provider, row.model) ?? contexts.get(row.sessionId)?.model;
        if (model) settle(row, model, undefined, "error");
        else { row.chargedUsd = tickets.get(row.id)?.settle() ?? row.reservedUsd; tickets.delete(row.id); row.state = "unknown"; row.reason = "Closed without final model usage"; persist(row); }
      }
      persist(); ledger.checkpoint(); return snapshot();
    } };
}
