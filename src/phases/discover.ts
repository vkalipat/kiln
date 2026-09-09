import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain, type BrainResult } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { brainTools, scoutTools, type ExitKind, type ToolContext } from "../brain/tools";
import { classifyFailure, type FailureClass } from "../core/failure";
import type { SearchStatus } from "../core/events";
import { Limiter } from "../core/limiter";
import { writeAtomic } from "../core/paths";
import { hashInput } from "../core/record";
import { writeStatus } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
import { effortFor } from "../providers/models";
import { runScout, type ScoutResult } from "../scouts/scout";
import { LANDSCAPE_SECTIONS, bullets, discoverContract, sections } from "./contracts";
import { parseBrief, stopFailure, type PhaseDeps, type PhaseResult } from "./frame";
import { assertShapeFrozen } from "./guards";
import { createDisposableDeadline, remainingRunWallMs, runValidatedFile, type ValidatedFileResult } from "./shared";

export function parseLandscape(md: string) {
  const s = sections(md);
  const missing = LANDSCAPE_SECTIONS.filter((n) => !(n in s));
  return { sections: s, missing, obvious: bullets(s["Obvious list"] ?? ""), atoms: bullets(s["Atoms"] ?? ""), tensions: bullets(s["Tensions"] ?? ""), domains: bullets(s["Distant domains"] ?? "") };
}

const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** How a scout that did not answer is described, to the record and to the brain reading its file.
 *  A spent turn cap reads as a spent budget so `classifyFailure` lands on `budget`, not `verify`. */
function scoutFailure(r: ScoutResult): { class: FailureClass; message: string; category?: string } | undefined {
  if (r.stopped === "refused") {
    const category = r.stopDetails?.category?.trim() || "unknown";
    return { class: "refusal", message: `scout refused: ${category}`, category };
  }
  if (r.stopped === "done" && r.findings.trim() === "") return { class: "verify", message: "scout returned no findings" };
  if (r.stopped === "done" && r.searchHealth.length > 0 && !r.searchHealth.includes("ok") && (r.successfulFetches ?? 0) === 0) {
    return { class: "verify", message: "scout retrieval produced no successful result; returned claims were discarded as unverified" };
  }
  if (r.stopped === "usd_cap") return { class: "budget", message: "budget exhausted: the scout hit its dollar cap before answering" };
  if (r.stopped === "exit") return { class: "verify", message: "scout exited without a supported findings result" };
  if (r.stopped !== "error" && r.stopped !== "turn_cap") return undefined;
  const message = r.stopped === "turn_cap" ? "budget exhausted: the scout hit its turn cap before answering" : r.error ?? "scout error";
  return { class: classifyFailure({ message, status: r.errorStatus, stopDetails: r.stopDetails }), message };
}

interface ScoutCheckpoint {
  fingerprint: string;
  state: "ok" | "failure";
  /** Bumped when scout completion/cap semantics change; old failures get one bounded re-evaluation. */
  policyVersion?: number;
  budgetTargetUsd?: number;
  wallTargetSeconds?: number;
  failure?: { class: FailureClass; message: string; category?: string };
}

type ScoutSeat = ReturnType<PhaseDeps["models"]>;

const SCOUT_CHECKPOINT_PREFIX = "<!-- kiln-scout-v1:";
export const SCOUT_CHECKPOINT_POLICY_VERSION = 2;
const FAILURE_CLASSES = new Set<FailureClass>(["transient", "verify", "unsatisfiable", "budget", "deadline", "integrity", "policy", "refusal"]);

function findingPath(d: PhaseDeps, question: string, index: number): string {
  return join(d.run.discoveryDir, `${index + 1}-${slug(question)}.md`);
}

function findingFingerprint(brief: string, question: string): string {
  return hashInput({ brief, question });
}

function findingsWithRetrievalNote(r: ScoutResult): string {
  if (r.searchHealth.length === 0 || r.searchHealth.every((status) => status === "ok")) return r.findings;
  const ok = r.searchHealth.filter((status) => status === "ok").length;
  return `${r.findings}\n\n> Retrieval status: ${ok}/${r.searchHealth.length} searches succeeded. Treat uncited claims and claims sourced only from failed or blocked attempts as unverified.`;
}

function readLandscape(path: string): ReturnType<typeof parseLandscape> | undefined {
  try { return existsSync(path) ? parseLandscape(readFileSync(path, "utf8")) : undefined; }
  catch { return undefined; }
}

function vendor(provider: string): string {
  return provider === "openai" || provider === "openai-codex" ? "openai" : provider;
}

/** The config's ranked scout list is the approval boundary; authentication alone adds no model. */
function alternateScout(d: PhaseDeps, primary: ScoutSeat): ScoutSeat | undefined {
  if (!d.modelsOn || !d.availableProviders) return undefined;
  const seen = new Set<string>();
  for (const ref of d.cfg.roles.scout) {
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    const provider = ref.slice(0, slash);
    if (seen.has(provider) || !d.availableProviders.has(provider) || vendor(provider) === vendor(String(primary.model.provider))) continue;
    seen.add(provider);
    try {
      const seat = d.modelsOn("scout", provider, primary.ref);
      if (seat.ref !== primary.ref && vendor(String(seat.model.provider)) !== vendor(String(primary.model.provider))) return seat;
    } catch {
      // A configured fallback unavailable in the live catalog is simply not dispatchable.
    }
  }
  return undefined;
}

/** Decode only harness-written metadata. The findings body remains plain Markdown for the brain. */
function readScoutCheckpoint(path: string, fingerprint: string): ScoutCheckpoint | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    if (!first.startsWith(SCOUT_CHECKPOINT_PREFIX) || !first.endsWith(" -->")) return undefined;
    const encoded = first.slice(SCOUT_CHECKPOINT_PREFIX.length, -4);
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ScoutCheckpoint;
    if (parsed.fingerprint !== fingerprint || (parsed.state !== "ok" && parsed.state !== "failure")) return undefined;
    if (parsed.policyVersion !== undefined && (!Number.isSafeInteger(parsed.policyVersion) || parsed.policyVersion < 1)) return undefined;
    if (parsed.budgetTargetUsd !== undefined && (!Number.isFinite(parsed.budgetTargetUsd) || parsed.budgetTargetUsd < 0)) return undefined;
    if (parsed.wallTargetSeconds !== undefined && (!Number.isFinite(parsed.wallTargetSeconds) || parsed.wallTargetSeconds < 0)) return undefined;
    if (parsed.state === "failure" && (!parsed.failure || !FAILURE_CLASSES.has(parsed.failure.class) || typeof parsed.failure.message !== "string"
      || (parsed.failure.category !== undefined && typeof parsed.failure.category !== "string"))) return undefined;
    return parsed;
  } catch { return undefined; }
}

function retryableCheckpoint(checkpoint: ScoutCheckpoint | undefined, d: PhaseDeps): boolean {
  if (checkpoint?.state !== "failure" || !checkpoint.failure) return checkpoint === undefined;
  if (checkpoint.failure.class === "transient") return true;
  if (checkpoint.failure.class === "budget") {
    return checkpoint.policyVersion !== SCOUT_CHECKPOINT_POLICY_VERSION
      || checkpoint.budgetTargetUsd === undefined || d.cfg.budgets.usd > checkpoint.budgetTargetUsd;
  }
  if (checkpoint.failure.class === "deadline") {
    return checkpoint.policyVersion !== SCOUT_CHECKPOINT_POLICY_VERSION
      || checkpoint.wallTargetSeconds === undefined || d.cfg.budgets.wallSeconds > checkpoint.wallTargetSeconds;
  }
  return false;
}

function writeScoutCheckpoint(path: string, fingerprint: string, question: string, findings: string, d: PhaseDeps, failure?: ScoutCheckpoint["failure"]): void {
  const targets = failure?.class === "budget" ? { budgetTargetUsd: d.cfg.budgets.usd }
    : failure?.class === "deadline" ? { wallTargetSeconds: d.cfg.budgets.wallSeconds } : {};
  const checkpoint: ScoutCheckpoint = failure
    ? { fingerprint, state: "failure", policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION, ...targets, failure }
    : { fingerprint, state: "ok", policyVersion: SCOUT_CHECKPOINT_POLICY_VERSION };
  const encoded = Buffer.from(JSON.stringify(checkpoint), "utf8").toString("base64url");
  const body = failure?.class === "refusal"
    ? `(scout refused: ${failure.category})`
    : failure ? `(scout failed: ${failure.class}: ${failure.message})` : findings;
  writeAtomic(path, `${SCOUT_CHECKPOINT_PREFIX}${encoded} -->\n# Question\n${question}\n\n# Findings\n${body}\n`);
}

export async function runDiscover(d: PhaseDeps): Promise<PhaseResult> {
  throwIfRunCancelled();
  const turnCap = d.cfg.budgets.turns.discover;
  const finish = (res: PhaseResult, message?: string): PhaseResult => {
    d.record.append({ t: "phase.end", phase: "discover", outcome: res.outcome });
    const usdSpent = d.record.costUsd();
    if (res.outcome === "ok") writeStatus(d.run, { phase: "ideate", state: "running", outcome: undefined, pausedReason: undefined, wakeAt: undefined, usdSpent });
    else if (res.outcome === "honest_exit") writeStatus(d.run, { state: "done", usdSpent, outcome: { kind: "honest_exit", exitKind: res.kind, reasons: res.reasons } });
    else if (res.outcome === "failed") writeStatus(d.run, { state: "failed", usdSpent, outcome: { kind: "failure", failureClass: res.failureClass, message: res.message } });
    else writeStatus(d.run, { state: "stopped", usdSpent, outcome: { kind: "stopped", stopKind: res.stopKind, truncatedRound: res.truncatedRound, frontierEmpty: res.frontierEmpty, budgetTargetUsd: res.budgetTargetUsd, wallTargetSeconds: res.wallTargetSeconds, ...(message ? { message } : {}) } });
    return res;
  };

  const frozen = assertShapeFrozen(d);
  if (frozen) return frozen;
  const brief = readFileSync(d.run.brief, "utf8");
  const parsedBrief = parseBrief(brief);

  d.record.append({ t: "phase.start", phase: "discover" });
  const { questions } = parsedBrief;
  const priorCheckpoints = questions.slice(0, 4).map((question, index) =>
    readScoutCheckpoint(findingPath(d, question, index), findingFingerprint(brief, question)));
  const priorLandscape = readLandscape(d.run.landscape);
  if (priorCheckpoints.length > 0
    && priorCheckpoints.every((checkpoint) => checkpoint?.state === "ok"
      || (checkpoint?.state === "failure" && checkpoint.failure?.class !== "transient"))
    && priorCheckpoints.some((checkpoint) => checkpoint?.state === "ok")
    && priorLandscape !== undefined
    && priorLandscape.missing.length === 0) {
    d.record.append({ t: "note", text: "Recovered a contract-valid discovery landscape and its current scout checkpoints; no provider call was repeated." });
    return finish({ outcome: "ok" });
  }
  if (d.record.costUsd() >= d.cfg.budgets.usd) {
    const message = `run budget target $${d.cfg.budgets.usd.toFixed(2)} is exhausted before discovery dispatch`;
    d.record.append({ t: "note", text: `${message}; no model call was attempted.` });
    return finish({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: d.cfg.budgets.usd }, message);
  }
  const remainingWallMs = remainingRunWallMs(d.cfg.budgets, d.record);
  if (remainingWallMs <= 0) {
    const message = `run wall target ${d.cfg.budgets.wallSeconds}s is exhausted before discovery dispatch`;
    d.record.append({ t: "note", text: `${message}; no model call was attempted.` });
    return finish({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: d.cfg.budgets.wallSeconds }, message);
  }
  const deadline = createDisposableDeadline(remainingWallMs);
  try {
  const pendingScouts = priorCheckpoints.filter((checkpoint) => retryableCheckpoint(checkpoint, d)).length;
  const scoutUsdCap = Math.max(0, d.cfg.budgets.usd - d.record.costUsd()) / Math.max(1, pendingScouts);
  const primaryScout = d.models("scout");
  const fallbackScout = alternateScout(d, primaryScout);
  const scoutCtx: ToolContext = { cwd: d.run.dir, roots: [d.run.dir], run: d.run, record: d.record, fetchImpl: d.fetchImpl };
  const searchLimiter = new Limiter(d.cfg.ideation.searchConcurrency);
  const runQuestion = async (question: string, unitCap: number, onCost?: (costUsd: number) => void): Promise<{ result: ScoutResult; failure?: ReturnType<typeof scoutFailure> }> => {
    const runSeat = async (seat: ScoutSeat, usdCap: number): Promise<ScoutResult> => {
      const searchHealth: SearchStatus[] = [];
      const result = await d.limiter.run(() => runScout({
        question,
        brief,
        model: seat.model,
        getApiKey: () => d.apiKeyFor(String(seat.model.provider)),
        tools: scoutTools({ ...scoutCtx, searchLimiter, searchJitterMs: d.searchJitterMs, onSearchHealth: (status) => searchHealth.push(status) }),
        record: d.record,
        home: d.home,
        cfg: d.cfg,
        runId: d.run.id,
        role: "scout",
        phase: "discover",
        streamFn: d.streamFn,
        searchHealth,
        usdCap,
        signal: deadline.signal,
      }));
      onCost?.(result.costUsd);
      return result;
    };
    let result = await runSeat(primaryScout, unitCap);
    let failure = scoutFailure(result);
    if (failure) d.record.append({ t: "failure", class: failure.class, message: `scout failed on "${question}": ${failure.message}`, ...(failure.category ? { category: failure.category } : {}) });
    const remaining = Math.max(0, unitCap - result.costUsd);
    if (failure?.class === "transient" && fallbackScout && remaining > 0) {
      d.record.append({ t: "note", text: `Transient scout failure on "${question}"; trying the configured different-provider fallback once.` });
      result = await runSeat(fallbackScout, remaining);
      failure = scoutFailure(result);
      if (failure) d.record.append({ t: "failure", class: failure.class, message: `fallback scout failed on "${question}": ${failure.message}`, ...(failure.category ? { category: failure.category } : {}) });
    }
    return { result, failure };
  };
  // A scout that fails silently is worse than one that fails loudly: the brain would read an empty
  // findings file and build a landscape on nothing. Each failure is recorded and written into the
  // file the brain reads, so a partial discovery is visible in the output rather than inferred.
  const settledOutcomes = await Promise.allSettled(
    questions.slice(0, 4).map(async (q, i) => {
      const path = findingPath(d, q, i);
      const fingerprint = findingFingerprint(brief, q);
      const prior = readScoutCheckpoint(path, fingerprint);
      if (prior?.state === "ok") {
        d.record.append({ t: "note", text: `Reused completed discovery scout ${i + 1}; no model call was repeated.` });
        return undefined;
      }
      // Refusal/verification failures are permanent work units. Budget/deadline failures reopen
      // only after their target grows, while old-policy cap failures get one migration attempt.
      if (prior?.state === "failure" && !retryableCheckpoint(prior, d)) return prior.failure;
      const { result: r, failure } = await runQuestion(q, scoutUsdCap);
      throwIfRunCancelled();
      writeScoutCheckpoint(path, fingerprint, q, findingsWithRetrievalNote(r), d, failure);
      return failure;
    }),
  );
  // Cancellation and unexpected exceptions are control flow, not scout findings. Wait for every
  // dispatched sibling to settle before the phase returns so no checkpoint can appear after the
  // caller has released its run lock or finalized status.
  const rejected = settledOutcomes.find((outcome) => outcome.status === "rejected");
  if (rejected?.status === "rejected") {
    throwIfRunCancelled();
    if (deadline.signal.aborted) {
      const message = `discovery reached the run wall target of ${d.cfg.budgets.wallSeconds}s`;
      return finish({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: d.cfg.budgets.wallSeconds }, message);
    }
    throw rejected.reason;
  }
  const outcomes = settledOutcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
  if (outcomes.length > 0 && outcomes.every((o) => o !== undefined)) {
    const classes = new Set(outcomes.map((o) => o!.class));
    if (classes.size === 1 && classes.has("transient")) {
      const message = `all ${outcomes.length} scouts failed in discover: ${outcomes[0]!.message}`;
      d.record.append({ t: "note", text: `${message}. Discovery is resumable; no further automatic retry or model substitution was attempted.` });
      d.onText?.(`\nDiscovery stopped on a temporary provider error: ${outcomes[0]!.message}. Check connectivity, then explicitly resume this same run.\n`);
      return finish({ outcome: "stopped", stopKind: "transient" }, message);
    }
    if (classes.size === 1 && classes.has("budget")) {
      const message = `all ${outcomes.length} scouts exhausted their bounded discovery unit`;
      d.record.append({ t: "note", text: `${message}. Increase the run dollar target to retry these cached questions; the same target dispatches nothing.` });
      return finish({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: d.cfg.budgets.usd }, message);
    }
    if (classes.size === 1 && classes.has("deadline")) {
      const message = `all ${outcomes.length} scouts reached a discovery deadline`;
      d.record.append({ t: "note", text: `${message}. Increase the run wall target to retry these cached questions; the same target dispatches nothing.` });
      return finish({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: d.cfg.budgets.wallSeconds }, message);
    }
    // Scouts that failed for the same reason name it; a mixed batch is reported as transient,
    // the class that says "the same run could go differently".
    const failureClass = classes.size === 1 ? [...classes][0]! : "transient";
    return finish({ outcome: "failed", failureClass, message: `all ${outcomes.length} scouts failed in discover: ${outcomes[0]!.message}` });
  }

  let exit: { kind: ExitKind; reasons: string[] } | undefined;
  let externalSpentUsd = d.record.costUsd();
  const ctx: ToolContext = {
    cwd: d.run.dir,
    roots: [d.run.dir],
    run: d.run,
    record: d.record,
    fetchImpl: d.fetchImpl,
    // These files are durable paid-work checkpoints. Synthesis may read them but cannot rewrite
    // their harness-authored outcome metadata or turn a failed retrieval into apparent evidence.
    protectedDirs: [d.run.discoveryDir],
    onExit: (kind, reasons) => { exit = { kind, reasons }; },
    // A scout the brain asked for gets the same treatment as the batch above: a failure is
    // journalled and handed back as text, so the brain sees that its question went unanswered
    // instead of an empty string it might read as "nothing exists".
    spawnScout: async (question) => {
      const { result: r, failure } = await runQuestion(question, Math.max(0, d.cfg.budgets.usd - externalSpentUsd), (cost) => { externalSpentUsd += cost; });
      if (!failure) return findingsWithRetrievalNote(r);
      return failure.class === "refusal" ? `(scout refused: ${failure.category})` : `(scout failed: ${failure.class}: ${failure.message})`;
    },
  };
  // Read through a function rather than the bare `exit` variable: TS's flow analysis for a `let`
  // mutated only inside a closure does not reliably re-widen it across an intervening `await`
  // once it has been narrowed to `undefined`, which would make later `if (exit)` checks unsound.
  const takeExit = (): { kind: ExitKind; reasons: string[] } | undefined => exit;
  const brainModel = d.models("brain").model;
  const priorBrainTurns = d.record.read().filter((event) => event.t === "turn" && event.phase === "discover" && event.role === "brain").length;
  const rawBrain = createBrain({
    model: brainModel,
    getApiKey: () => d.apiKeyFor(String(brainModel.provider)),
    tools: brainTools(ctx, "discover"),
    systemPrompt: [loadPrompt(d.home, "kernel"), loadPrompt(d.home, "brain"), `## Playbook (discover)\n${playbookSection(loadPlaybook(d.home), "discover")}`],
    pinned: discoverContract(d.run, questions, turnCap, d.workflow),
    record: d.record,
    role: "brain",
    phase: "discover",
    turnCap,
    priorTurns: () => priorBrainTurns,
    usdCap: d.cfg.budgets.usd,
    spentUsd: () => externalSpentUsd,
    signal: deadline.signal,
    effort: effortFor(d.cfg, "brain", brainModel),
    streamFn: d.streamFn,
    onText: d.onText,
    onTool: d.onTool,
    shaping: { cfg: d.cfg, runId: d.run.id },
  });
  const brain = {
    async run(prompt: string): Promise<BrainResult> {
      const result = await rawBrain.run(prompt);
      externalSpentUsd += result.costUsd;
      return result;
    },
  };
  let v: ValidatedFileResult<ReturnType<typeof parseLandscape>>;
  try {
    v = await runValidatedFile({
      brain,
      path: d.run.landscape,
      parse: parseLandscape,
      validate: (p) => (p.missing.length > 0 ? [`missing sections: ${p.missing.join(", ")}`] : []),
      prompt: `Brief:\n${brief}\n\nScout findings are in ${d.run.discoveryDir}. Read them, then write ${d.run.landscape}.`,
      fix: (problems, path) => `${path} is not usable yet: ${problems.join("; ")}. Rewrite the whole file with every required section.`,
      halt: (r) => takeExit() !== undefined || stopFailure("discover", turnCap, r) !== undefined,
    });
  } catch (error) {
    throwIfRunCancelled();
    if (deadline.signal.aborted) {
      const message = `discovery reached the run wall target of ${d.cfg.budgets.wallSeconds}s`;
      return finish({ outcome: "stopped", stopKind: "deadline", wallTargetSeconds: d.cfg.budgets.wallSeconds }, message);
    }
    throw error;
  }
  const exited = takeExit();
  if (exited) return finish({ outcome: "honest_exit", ...exited });
  // As in frame, a dispatch cap cannot invalidate the contract-valid artifact produced by the
  // completed final turn. Errors and refusals remain authoritative and cannot take this path.
  if ((v.result.stopped === "turn_cap" || v.result.stopped === "usd_cap") && v.parsed !== undefined && v.problems.length === 0) {
    d.record.append({ t: "note", text: `Discovery reached its ${v.result.stopped === "turn_cap" ? "turn" : "dollar"} cap with a contract-valid landscape; accepted the existing artifact without another model call.` });
    return finish({ outcome: "ok" });
  }
  const stop = stopFailure("discover", turnCap, v.result);
  if (stop?.outcome === "failed" && stop.failureClass === "transient") {
    d.record.append({ t: "note", text: `${stop.message}. Discovery synthesis is resumable; no automatic retry or model substitution was attempted.` });
    return finish({ outcome: "stopped", stopKind: "transient" }, stop.message);
  }
  if (stop?.outcome === "failed" && v.result.stopped === "usd_cap") {
    return finish({ outcome: "stopped", stopKind: "budget", budgetTargetUsd: d.cfg.budgets.usd }, stop.message);
  }
  if (stop) return finish(stop);
  if (v.problems.length > 0) return finish({ outcome: "failed", failureClass: "verify", message: `landscape ${v.problems.join("; ")}` });
  return finish({ outcome: "ok" });
  } finally {
    deadline.dispose();
  }
}
