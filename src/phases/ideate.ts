import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { brainTools, type ExitKind, type ToolContext } from "../brain/tools";
import { classifyFailure, StallDetector } from "../core/failure";
import { Limiter } from "../core/limiter";
import { acquireRunLock } from "../core/lock";
import { writeAtomic } from "../core/paths";
import { readStatus, writeStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import { effortFor, resolveRoleOn } from "../providers/models";
import { applyAxisMappings } from "../ideation/axes";
import { Archive, insertAll } from "../ideation/archive";
import { projectedRoundCost, remainingIdeateUsd, type ModelResolver } from "../ideation/budget";
import { collapsePairs, comparisonCounts, type StrengthInterval } from "../ideation/bt";
import { renderDossierDetailed, type Evidence } from "../ideation/dossier";
import { frontier, mmrSelect, trimForCheckpoint, type AxisIntervals } from "../ideation/frontier";
import { assignIslands, deriveIdeas, rawIslandPath, recordIslandAssignments, runIsland, writeRawIsland, type DerivedIdea, type IslandModels, type IslandRun } from "../ideation/islands";
import { writeCriteria, writeMetaReview } from "../ideation/judge";
import { writeMetrics } from "../ideation/metrics";
import { trigramJaccard } from "../ideation/novelty";
import { selectEntrants, schedulePairs } from "../ideation/pairing";
import { collisionVerdict, runPriorArtScout } from "../ideation/priorart";
import { mergeProbeEvidence, runProbeBatch } from "../ideation/probe";
import { latestSteering, pauseInfo, readJsonIfPresent, searchHealth } from "../ideation/runtime";
import { fitRound, readTournament, runTournament, seedFor } from "../ideation/tournament";
import { parseBrief, type PhaseDeps, type PhaseResult } from "./frame";
import { shapeHash } from "./contracts";
export interface IdeateDeps extends PhaseDeps { islandModels?: IslandModels }
export interface FrontierIdea { id: string; backfill: boolean; cell?: string; value?: StrengthInterval; feasibility?: StrengthInterval }
export interface FrontierFile {
  version: 1; mode: "loop" | "bare"; round: number; rawFront: string[]; shown: string[]; eligible: string[];
  ideas: FrontierIdea[]; ladders: { value: string[]; feasibility: string[] };
  searchHealth: number; searchHealthFloor: number; noveltyEnforced: boolean;
}
interface EnrichmentResult {
  searchHealth: number; noveltyEnforced: boolean;
  contextPressure: boolean;
  exit?: { kind: ExitKind; reasons: string[] };
  stalled?: { tool: string; fingerprint: string };
  pause?: { reason: string; wakeAt: string };
  failure?: { failureClass: ReturnType<typeof classifyFailure>; message: string };
}
async function islandChoices(d: IdeateDeps): Promise<IslandModels> {
  if (d.islandModels) return d.islandModels;
  const providers = [...new Set([...d.cfg.roles.generator, ...d.cfg.roles.prober].map((ref) => ref.split("/")[0]!))];
  const available = new Set<string>();
  for (const provider of providers) {
    try { const key = await d.apiKeyFor(provider); throwIfRunCancelled(); if (key) available.add(provider); }
    catch (error) { rethrowIfRunCancelled(error); /* unavailable */ }
  }
  const choices = (role: "generator" | "prober") => [...available].flatMap((provider) => {
    try { return [resolveRoleOn(role, provider, d.cfg, available)]; }
    catch (error) { rethrowIfRunCancelled(error); return []; }
  });
  const generator = choices("generator");
  return { generator: generator.length > 0 ? generator : [d.models("generator")], cheap: choices("prober") };
}
function finish(d: PhaseDeps, result: PhaseResult, patch: Parameters<typeof writeStatus>[1]): PhaseResult {
  d.record.append({ t: "phase.end", phase: "ideate", outcome: result.outcome });
  writeStatus(d.run, { usdSpent: d.record.costUsd(), ...patch });
  return result;
}
function stop(
  d: PhaseDeps,
  stopKind: "stagnant" | "stalled" | "budget",
  round: number,
  extra: { truncatedRound?: number; frontierEmpty?: boolean; stallTool?: string; stallFingerprint?: string } = {},
): PhaseResult {
  d.record.append({ t: "stop", stopKind, round, ...extra });
  return finish(d, { outcome: "stopped", stopKind, truncatedRound: extra.truncatedRound, frontierEmpty: extra.frontierEmpty }, {
    state: "stopped", truncated: extra.truncatedRound !== undefined,
    outcome: { kind: "stopped", stopKind, ...extra },
  });
}
function mechanicalNoIdea(d: PhaseDeps, round: number, reasons: string[]): PhaseResult {
  d.record.append({ t: "stop", stopKind: "no_idea_clears_bar", round, frontierEmpty: true });
  return finish(d, { outcome: "honest_exit", kind: "no_idea_clears_bar", reasons }, {
    state: "done", outcome: { kind: "honest_exit", exitKind: "no_idea_clears_bar", reasons },
  });
}

function roundsComplete(d: PhaseDeps): PhaseResult {
  const result: PhaseResult = { outcome: "stopped", stopKind: "rounds" };
  if (!d.record.read().some((event) => event.t === "stop" && event.stopKind === "rounds" && event.round === d.cfg.ideation.rounds)) d.record.append({ t: "stop", stopKind: "rounds", round: d.cfg.ideation.rounds });
  return finish(d, result, {
    phase: "ideate", state: "stopped", cursor: { round: d.cfg.ideation.rounds, step: "checkpoint" },
    outcome: { kind: "stopped", stopKind: "rounds" },
  });
}

function latestSeq(d: PhaseDeps): number { return d.record.read().at(-1)?.seq ?? 0; }

function pause(d: PhaseDeps, info: { reason: string; wakeAt: string }): PhaseResult {
  d.record.append({ t: "pause", reason: info.reason, wakeAt: info.wakeAt });
  return finish(d, { outcome: "ok" }, { state: "paused", phase: "ideate", pausedReason: info.reason, wakeAt: info.wakeAt });
}

/** Same prior-art/probe evidence path is used by the loop and `--bare`. */
export async function enrichEvidence(
  d: PhaseDeps, archive: Archive, ids: readonly string[], shape: "research" | "product" | "creative", round: number, searchLimiter: Limiter,
  context: { frontier?: FrontierFile; metaReview?: string } = {},
): Promise<EnrichmentResult> {
  const missingPrior = ids.filter((id) => !archive.get(id)?.evidence.priorArt);
  const marker = latestSeq(d);
  const scouted = await Promise.all(missingPrior.map((id) => d.limiter.run(async () => ({
    id, result: await runPriorArtScout(d, archive.get(id)!.dossier, { shape, arbiter: false, searchLimiter, searchJitterMs: d.searchJitterMs }),
  }))));
  let contextPressure = scouted.some(({ result }) => result.contextPressure);
  const state = () => ({ ...searchHealth(archive, d.cfg.ideation.searchHealthFloor), contextPressure });
  const already = d.record.read().filter((event) => event.t === "arbiter.verdict" && event.kind === "collision" && ids.includes(event.id)).length;
  let collisionSeats = Math.max(0, d.cfg.ideation.arbiterCaps.collision - already);
  await Promise.all(scouted.map(async ({ id, result }) => {
    let priorArt: NonNullable<Evidence["priorArt"]> = result.status === "search_failed" ? { status: "search_failed" } : { status: "not_falsified" };
    if (result.searchOk && collisionSeats-- > 0) {
      const verdict = await d.limiter.run(() => collisionVerdict(d, archive.get(id)!.dossier, result.findings));
      const hasUrl = verdict.artifactUrl !== undefined && /^https?:\/\//i.test(verdict.artifactUrl);
      const collided = verdict.same && hasUrl;
      d.record.append({ t: "arbiter.verdict", kind: "collision", id, against: verdict.artifactUrl, verdict: collided ? "collided" : verdict.same ? "same_without_artifact" : "distinct", costUsd: verdict.costUsd });
      priorArt = collided
        ? { status: "collided" as const, artifact: { title: verdict.artifactTitle ?? verdict.artifactUrl!, url: verdict.artifactUrl! }, distance: verdict.reason }
        : { status: "not_falsified" as const, distance: verdict.reason || undefined };
    }
    archive.mergeEvidence(id, { priorArt });
    if (priorArt.status === "collided") archive.markRejected(id, "collided", priorArt.artifact?.url);
  }));
  const limited = await pauseInfo(d, marker);
  if (limited) return { ...state(), pause: limited };

  const missingProbe = ids.filter((id) => !archive.get(id)?.evidence.probe && archive.get(id)?.evidence.status !== "rejected");
  let exit: { kind: ExitKind; reasons: string[] } | undefined;
  let requested: { ideaId: string; rationale: string }[] = [];
  let stalled: { tool: string; fingerprint: string } | undefined;
  if (missingProbe.length > 0) {
    const detector = new StallDetector();
    let abortStall = () => {};
    const ctx: ToolContext = {
      cwd: d.run.dir, roots: [d.run.dir], run: d.run, record: d.record, fetchImpl: d.fetchImpl, round,
      protectedIdeas: new Set(archive.ids()),
      onProbeRequest: (ideas) => { requested = ideas; },
      onExit: (kind, reasons) => { exit = { kind, reasons }; },
    };
    const tools = brainTools(ctx, "ideate").filter((tool) => ["read", "probe_request", "note", "exit"].includes(tool.name));
    const { model } = d.models("brain");
    const frontierTable = context.frontier?.ideas.map((idea) =>
      `${idea.id} | value ${idea.value ? `${idea.value.mean.toFixed(3)} [${idea.value.lo.toFixed(3)}, ${idea.value.hi.toFixed(3)}]` : "unranked"} | feasibility ${idea.feasibility ? `${idea.feasibility.mean.toFixed(3)} [${idea.feasibility.lo.toFixed(3)}, ${idea.feasibility.hi.toFixed(3)}]` : "unranked"} | cell ${idea.cell ?? "unknown"}`,
    ).join("\n") ?? "(no standing frontier yet)";
    const brain = createBrain({
      model, getApiKey: () => d.apiKeyFor(String(model.provider)), tools,
      systemPrompt: [loadPrompt(d.home, "kernel"), loadPrompt(d.home, "brain"), `## Playbook (ideate)\n${playbookSection(loadPlaybook(d.home), "ideate")}`],
      pinned: [
        `Round ${round} of ${d.cfg.ideation.rounds}.`, `Brief:\n${readFileSync(d.run.brief, "utf8").trim()}`,
        `Standing frontier:\n${frontierTable}`, `Previous meta-review:\n${context.metaReview?.trim() || "(none)"}`,
        `Budget left: $${remainingIdeateUsd(d.cfg, d.record.read()).toFixed(4)}.`,
        "Stop rules: the harness owns round, stagnant, stall and budget stops. Call exit only when no idea clears the bar, with concrete reasons.",
      ].join("\n\n"),
      record: d.record, role: "brain", phase: "ideate", turnCap: d.cfg.budgets.turns.ideate,
      effort: effortFor(d.cfg, "brain", model), streamFn: d.streamFn, terminalTools: ["probe_request"], onText: d.onText,
      onTool: (event) => {
        d.onTool?.(event);
        if (event.phase === "end" && detector.observe(event.name, event.excerpt ?? "")) {
          stalled = { tool: event.name, fingerprint: detector.fingerprint ?? "" };
          abortStall();
        }
      },
      shaping: { cfg: d.cfg, runId: d.run.id },
    });
    abortStall = () => brain.agent.abort("kiln:stall");
    const before = latestSeq(d);
    const result = await brain.run(`Read these idea files and make one probe_request for every executable cheapest test; omit the rest:\n${missingProbe.map((id) => join(d.run.ideasDir, `${id}.md`)).join("\n")}`);
    contextPressure ||= result.contextPressure === true;
    const p = await pauseInfo(d, before);
    if (p) return { ...state(), pause: p };
    if (exit || stalled) return { ...state(), exit, stalled };
    if (result.stopped === "error" || result.stopped === "turn_cap") {
      const message = result.stopped === "turn_cap" ? "ideate brain reached its per-round turn cap" : result.error ?? "ideate brain error";
      const failureClass = result.stopped === "turn_cap" ? "budget" : classifyFailure({ message, status: result.errorStatus });
      d.record.append({ t: "failure", class: failureClass, message });
      return { ...state(), failure: { failureClass, message } };
    }
  }
  if (exit || stalled) return { ...state(), exit, stalled };
  const wanted = new Set(requested.map((item) => item.ideaId).filter((id) => missingProbe.includes(id)));
  const requestedEntries = missingProbe.filter((id) => wanted.has(id)).map((id) => archive.get(id)!);
  const probeMarker = latestSeq(d);
  await runProbeBatch(d, requestedEntries, { roundWallSeconds: d.cfg.ideation.probe.roundWallSeconds, limiter: d.limiter });
  for (const id of missingProbe.filter((candidate) => !wanted.has(candidate))) {
    mergeProbeEvidence(d.run, id, { status: "not_run", reason: "not_probeable", durationMs: 0 });
    d.record.append({ t: "probe", id, status: "not_run", reason: "not_probeable", durationMs: 0 });
  }
  const probePause = await pauseInfo(d, probeMarker);
  if (probePause) return { ...state(), pause: probePause };
  return state();
}

function renders(d: PhaseDeps, archive: Archive, ids: readonly string[], round: number): Record<string, { text: string; hash: string }> {
  const out: Record<string, { text: string; hash: string }> = {};
  for (const id of ids) {
    const path = join(d.run.renderedDir, `${id}-r${round}.md`);
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      out[id] = { text, hash: Bun.CryptoHasher.hash("sha256", text, "hex") };
      continue;
    }
    // Probe execution writes the sidecar directly; refresh it before rendering so a completed
    // probe can never appear as "not yet requested" in the judge's view.
    archive.mergeEvidence(id, {});
    const entry = archive.get(id)!;
    const rendered = renderDossierDetailed(entry.dossier, entry.evidence, { forJudge: true });
    writeAtomic(path, rendered.text);
    archive.mergeEvidence(id, { truncated: rendered.truncated });
    out[id] = { text: rendered.text, hash: rendered.hash };
  }
  return out;
}

function generationModels(d: PhaseDeps, ids: readonly string[]): Record<string, string> {
  const assigned = new Map<string, string>();
  for (const event of d.record.read()) if (event.t === "island.assign") assigned.set(`${event.round}|${event.island}`, event.model);
  return Object.fromEntries(ids.map((id) => {
    const match = /^r(\d+)-i(\d+)-/.exec(id);
    return [id, match ? assigned.get(`${match[1]}|${match[2]}`) ?? "unknown" : "unknown"];
  }));
}

function completePairs(lines: ReturnType<typeof readTournament>): { all: [string, string][]; current: Map<number, number>; incomplete: Map<number, [string, string][]> } {
  const orders = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = `${line.round}|${line.a}|${line.b}`;
    const set = orders.get(key) ?? new Set<string>(); set.add(line.order); orders.set(key, set);
  }
  const all: [string, string][] = [];
  const current = new Map<number, number>();
  const incomplete = new Map<number, [string, string][]>();
  for (const [key, set] of orders) {
    const [roundText, a, b] = key.split("|"); const round = Number(roundText);
    if (set.has("ab") && set.has("ba")) { all.push([a!, b!]); current.set(round, (current.get(round) ?? 0) + 1); }
    else { const pairs = incomplete.get(round) ?? []; pairs.push([a!, b!]); incomplete.set(round, pairs); }
  }
  return { all, current, incomplete };
}

export { projectedRoundCost } from "../ideation/budget";

async function runIdeateUnlocked(d: IdeateDeps): Promise<PhaseResult> {
  let brief: string; let landscape: string;
  try { brief = readFileSync(d.run.brief, "utf8"); landscape = readFileSync(d.run.landscape, "utf8"); }
  catch (error) { const message = `cannot read ideate inputs: ${(error as Error).message}`; d.record.append({ t: "failure", class: "integrity", message }); return finish(d, { outcome: "failed", failureClass: "integrity", message }, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } }); }
  const parsed = parseBrief(brief); const status = readStatus(d.run);
  if ((status.ideationRounds ?? 0) > d.cfg.ideation.rounds) d.cfg.ideation.rounds = status.ideationRounds!;
  if (!parsed.shape || (status.shapeHash && status.shapeHash !== shapeHash(parsed))) {
    const message = "the brief's idea shape does not match the shape frozen at frame; start a new run";
    d.record.append({ t: "failure", class: "integrity", message });
    return finish(d, { outcome: "failed", failureClass: "integrity", message }, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } });
  }
  if (!d.record.read().some((event) => event.t === "phase.start" && event.phase === "ideate")) d.record.append({ t: "phase.start", phase: "ideate" });
  writeStatus(d.run, {
    searchHealth: status.searchHealth ?? 1,
    searchHealthFloor: d.cfg.ideation.searchHealthFloor,
    noveltyEnforced: status.noveltyEnforced ?? true,
  });
  const projection = projectedRoundCost(d.cfg, d.models as ModelResolver); const archive = new Archive(d.run, d.record);
  const searchLimiter = new Limiter(d.cfg.ideation.searchConcurrency); const playbook = loadPlaybook(d.home);
  const routedModels = await islandChoices(d);
  const startRound = status.cursor?.step === "checkpoint" ? d.cfg.ideation.rounds + 1 : Math.max(1, status.cursor?.round ?? 1);
  const restored: DerivedIdea[] = [];
  for (const file of readdirSync(d.run.rawIdeasDir).filter((name) => /^r\d+-i\d+\.md$/.test(name)).sort()) {
    const match = /^r(\d+)-i(\d+)\.md$/.exec(file)!; const rawRound = Number(match[1]);
    if (rawRound >= startRound) continue;
    restored.push(...deriveIdeas(readFileSync(join(d.run.rawIdeasDir, file), "utf8"), rawRound, Number(match[2]), parsed.axes));
  }
  await applyAxisMappings(d, restored, parsed.axes, 0); await insertAll(d, archive, restored, { arbiterBudget: 0 });
  let previous = readJsonIfPresent<FrontierFile>(d.run.frontier); if (previous && previous.round >= startRound) previous = undefined;
  let meta = startRound > 1 && existsSync(join(d.run.criteriaDir, `r${startRound - 1}-meta.md`)) ? readFileSync(join(d.run.criteriaDir, `r${startRound - 1}-meta.md`), "utf8").trim() : "";
  const steering = latestSteering(d.record); if (steering) meta = `${meta}${meta ? "\n\n" : ""}Human steering: ${steering}`;
  let seedIds = previous?.rawFront.slice(0, d.cfg.ideation.mmrK) ?? [];
  if (startRound > d.cfg.ideation.rounds) {
    if (status.cursor?.step === "checkpoint") return { outcome: "stopped", stopKind: "rounds" };
    return roundsComplete(d);
  }
  for (let round = startRound; round <= d.cfg.ideation.rounds; round += 1) {
    writeStatus(d.run, { cursor: { round, step: "round.start" } });
    const boundaryPause = await pauseInfo(d, undefined, true); if (boundaryPause) return pause(d, boundaryPause);
    const remaining = remainingIdeateUsd(d.cfg, d.record.read());
    if (remaining <= 0 || remaining + 1e-12 < projection.costUsd) return stop(d, "budget", round, { frontierEmpty: !previous });
    const roundBudget = Math.max(projection.costUsd, remaining / (d.cfg.ideation.rounds - round + 1)); const roundStart = d.record.costUsd();
    const judgeRef = d.models("judge").ref;
    const plans = assignIslands(round, d.cfg, playbook, judgeRef, routedModels);
    if (!d.record.read().some((event) => event.t === "island.assign" && event.round === round)) recordIslandAssignments(d.record, plans);
    const generationMarker = latestSeq(d);
    const generated = await Promise.all(plans.map((plan) => d.limiter.run(async (): Promise<IslandRun> => {
      const path = rawIslandPath(d.run, round, plan.island);
      if (existsSync(path)) return { raw: readFileSync(path, "utf8"), batches: [], bounded: [], reasked: 0, costUsd: 0, contextPressure: false };
      const seeds = seedIds.flatMap((id) => archive.get(id) ? [renderDossierDetailed(archive.get(id)!.dossier, archive.get(id)!.evidence, { forJudge: true }).text] : []);
      const result = await runIsland(d, plan, { brief, landscape, axes: parsed.axes, seeds, metaReview: meta });
      // The raw file commits a whole two-batch island. Partial output remains in the journal only
      // and is retried on resume; persisting it here would make an error look complete forever.
      if (!result.error) writeRawIsland(d.run, round, plan.island, result.raw);
      return result;
    })));
    const p = await pauseInfo(d, generationMarker); if (p) return pause(d, p);
    let contextPressed = generated.some((result) => result.contextPressure);
    const islandFailure = generated.find((result) => result.error);
    if (islandFailure?.error) {
      const failureClass = islandFailure.stopped === "turn_cap" ? "budget" : classifyFailure({ message: islandFailure.error, status: islandFailure.errorStatus });
      d.record.append({ t: "failure", class: failureClass, message: islandFailure.error });
      return finish(d, { outcome: "failed", failureClass, message: islandFailure.error }, { state: "failed", outcome: { kind: "failure", failureClass, message: islandFailure.error } });
    }
    if (contextPressed) d.record.append({ t: "note", text: `context pressure observed in ideate round ${round}; the next round rebuilds every model seat fresh from files` });
    const candidates: DerivedIdea[] = generated.flatMap((result, index) => deriveIdeas(result.raw, round, plans[index]!.island, parsed.axes));
    const insertionMarker = latestSeq(d);
    const axis = await applyAxisMappings(d, candidates, parsed.axes, d.cfg.ideation.arbiterCaps.novelty);
    const insertion = await insertAll(d, archive, candidates, { arbiterBudget: Math.max(0, d.cfg.ideation.arbiterCaps.novelty - axis.arbiterCalls) });
    const insertionPause = await pauseInfo(d, insertionMarker); if (insertionPause) return pause(d, insertionPause);
    if (d.record.costUsd() - roundStart > roundBudget) return stop(d, "budget", round, { truncatedRound: round, frontierEmpty: !previous });
    // Consume the outcome list in its own fixed order. `inserted` includes reused live ids and is
    // deliberately not a count of work this invocation performed.
    const currentIds = insertion.outcomes.filter((outcome) => !outcome.rejectedAs).map((outcome) => outcome.id);
    const firstInsertedThisRound = new Set(d.record.read().flatMap((event) => event.t === "idea.insert" && event.id.startsWith(`r${round}-`) ? [event.id] : []));
    for (const outcome of insertion.outcomes) if (outcome.status === "inserted") firstInsertedThisRound.add(outcome.id);
    const enriched = await enrichEvidence(d, archive, currentIds, parsed.shape, round, searchLimiter, { frontier: previous, metaReview: meta });
    if (!contextPressed && enriched.contextPressure) d.record.append({ t: "note", text: `context pressure observed in ideate round ${round}; the next round rebuilds every model seat fresh from files` });
    writeStatus(d.run, { searchHealth: enriched.searchHealth, searchHealthFloor: d.cfg.ideation.searchHealthFloor, noveltyEnforced: enriched.noveltyEnforced });
    if (enriched.pause) return pause(d, enriched.pause);
    if (enriched.failure) return finish(d, { outcome: "failed", ...enriched.failure }, { state: "failed", outcome: { kind: "failure", ...enriched.failure } });
    if (enriched.exit) return finish(d, { outcome: "honest_exit", ...enriched.exit }, { state: "done", outcome: { kind: "honest_exit", exitKind: enriched.exit.kind, reasons: enriched.exit.reasons } });
    if (enriched.stalled) return stop(d, "stalled", round, { frontierEmpty: !previous, stallTool: enriched.stalled.tool, stallFingerprint: enriched.stalled.fingerprint });
    if (d.record.costUsd() - roundStart > roundBudget) return stop(d, "budget", round, { truncatedRound: round, frontierEmpty: !previous });
    const rankable = archive.ids().filter((id) => archive.get(id)?.evidence.status !== "rejected" && archive.get(id)?.evidence.priorArt?.status !== "search_failed");
    const rendered = renders(d, archive, rankable, round);
    // Current-round ideas remain candidates on a mid-tournament resume even if their first fit
    // marked them active before the crash simulation. Older active ideas return only as anchors.
    const admissionPool = archive.ids().filter((id) => rankable.includes(id) && (archive.get(id)?.evidence.status === "unranked" || id.startsWith(`r${round}-`)));
    const anchors = (previous?.rawFront ?? []).filter((id) => rankable.includes(id));
    const entrants = selectEntrants({ archive: admissionPool.map((id) => ({ id, cell: archive.get(id)!.dossier.axisValues })), anchors, entrantsCap: d.cfg.ideation.entrantsCap, anchorsCap: d.cfg.ideation.anchorsCap });
    const criteriaMarker = latestSeq(d); const criteria = await writeCriteria(d, round, brief, parsed.shape, meta);
    const criteriaPause = await pauseInfo(d, criteriaMarker); if (criteriaPause) return pause(d, criteriaPause);
    if (!criteria.ok) return finish(d, { outcome: "failed", failureClass: criteria.failure, message: criteria.message }, { state: "failed", outcome: { kind: "failure", failureClass: criteria.failure, message: criteria.message } });
    if (d.record.costUsd() - roundStart > roundBudget) return stop(d, "budget", round, { truncatedRound: round, frontierEmpty: !previous });
    const before = readTournament(d.run); const completed = completePairs(before);
    const incomplete = (completed.incomplete.get(round) ?? []).filter(([a, b]) => entrants.includes(a) && entrants.includes(b));
    const newPairs = schedulePairs({ entrants, anchors, existing: completed.all, pairCap: Math.max(0, d.cfg.ideation.pairCap - (completed.current.get(round) ?? 0) - incomplete.length), minComparisons: d.cfg.ideation.minComparisons, strengths: Object.fromEntries((previous?.ideas ?? []).map((idea) => [idea.id, idea.value?.mean ?? 0])) });
    const pairs = [...incomplete, ...newPairs.filter(([a, b]) => !incomplete.some(([x, y]) => x === a && y === b))];
    let truncated = false; const genModels = generationModels(d, archive.ids());
    for (const pair of pairs) {
      if (d.record.costUsd() - roundStart > roundBudget) { truncated = true; break; }
      const pairMarker = latestSeq(d);
      await runTournament(d, { round, pairs: [pair], renders: rendered, genModels, criteria, limiter: d.limiter });
      const pairPause = await pauseInfo(d, pairMarker); if (pairPause) return pause(d, pairPause);
    }
    if (d.record.costUsd() - roundStart > roundBudget) truncated = true;
    const lines = readTournament(d.run); const collapsed = collapsePairs(lines); const counts = comparisonCounts(collapsed.value, entrants);
    if (truncated && entrants.some((id) => (counts[id] ?? 0) < d.cfg.ideation.minComparisons)) return stop(d, "budget", round, { truncatedRound: round, frontierEmpty: !previous });
    const fitIds = [...new Set(lines.flatMap((line) => [line.a, line.b]))];
    const fit = fitRound(lines, fitIds, { lambda: d.cfg.ideation.btLambda, samples: d.cfg.ideation.bootstrapSamples, humanWeight: d.cfg.ideation.humanWeight, level: d.cfg.ideation.dominanceLevel, seed: seedFor(d.run.id, round) });
    const strengths: Record<string, AxisIntervals> = {}; for (const id of fitIds) {
      strengths[id] = { value: fit.value[id]!, feasibility: fit.feasibility[id]! };
      archive.mergeEvidence(id, archive.get(id)?.evidence.status === "rejected" ? { strengths: strengths[id] } : { status: "active", strengths: strengths[id] });
    }
    const fr = frontier({ strengths, minComparisons: d.cfg.ideation.minComparisons, dominance: { kind: "interval", level: d.cfg.ideation.dominanceLevel } });
    const lost = new Set(archive.markLostCell(Object.fromEntries(fitIds.map((id) => [id, fit.value[id]!.mean])))); const values = Object.fromEntries(fitIds.map((id) => [id, fit.value[id]!.mean]));
    const displayFront = fr.front.filter((id) => !lost.has(id) && archive.get(id)?.evidence.rejectReason !== "lost_cell");
    const trimmed = trimForCheckpoint(displayFront, archive.cells(), { max: d.cfg.ideation.checkpointMax, min: d.cfg.ideation.checkpointMin, champions: archive.champions(), values });
    const ladders = { value: [...fr.eligible].sort((a, b) => fit.value[b]!.mean - fit.value[a]!.mean || a.localeCompare(b)), feasibility: [...fr.eligible].sort((a, b) => fit.feasibility[b]!.mean - fit.feasibility[a]!.mean || a.localeCompare(b)) };
    const h = searchHealth(archive, d.cfg.ideation.searchHealthFloor); previous = { version: 1, mode: "loop", round, rawFront: fr.front, shown: trimmed.shown, eligible: fr.eligible, ideas: trimmed.shown.map((id) => ({ id, backfill: trimmed.backfill.includes(id), cell: archive.get(id)?.evidence.cell, value: fit.value[id], feasibility: fit.feasibility[id] })), ladders, searchHealth: h.searchHealth, searchHealthFloor: d.cfg.ideation.searchHealthFloor, noveltyEnforced: h.noveltyEnforced };
    writeAtomic(d.run.frontier, `${JSON.stringify(previous, null, 2)}\n`);
    const metaMarker = latestSeq(d); meta = (await writeMetaReview(d, round, lines.filter((line) => line.round === round).flatMap((line) => line.reason ? [line.reason] : []), parsed.shape)).text;
    const metaPause = await pauseInfo(d, metaMarker); if (metaPause) return pause(d, metaPause);
    if (d.record.costUsd() - roundStart > roundBudget) truncated = true;
    const seeds = fr.front.length >= 2 ? mmrSelect(fr.front, archive.cells(), (a, b) => trigramJaccard(`${archive.get(a)!.dossier.title} ${archive.get(a)!.dossier.mechanism}`, `${archive.get(b)!.dossier.title} ${archive.get(b)!.dossier.mechanism}`), Math.min(d.cfg.ideation.mmrK, fr.front.length), { values }) : archive.champions().slice(0, d.cfg.ideation.mmrK);
    seedIds = seeds; writeStatus(d.run, { cursor: { round: round + 1, step: "round.start" } });
    if (!trimmed.shown.some((id) => firstInsertedThisRound.has(id))) return fr.eligible.length === 0 ? mechanicalNoIdea(d, round, ["the eligible frontier is empty after generation stagnated"]) : stop(d, "stagnant", round);
    if (truncated) return stop(d, "budget", round, { truncatedRound: round, frontierEmpty: false });
  }
  if (!previous || previous.eligible.length === 0) return mechanicalNoIdea(d, d.cfg.ideation.rounds, ["no eligible idea cleared the mechanical floor"]);
  return roundsComplete(d);
}

/** The phase boundary owns mutual exclusion, unexpected-failure recording, metrics, and cleanup. */
export async function runIdeate(d: IdeateDeps): Promise<PhaseResult> {
  throwIfRunCancelled();
  const lock = d.lockHeld ? undefined : acquireRunLock(d.run, { force: d.forceLock });
  try {
    try {
      const result = await runIdeateUnlocked(d);
      throwIfRunCancelled();
      return result;
    } catch (error) {
      rethrowIfRunCancelled(error);
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifyFailure({ error, message });
      d.record.append({ t: "failure", class: failureClass, message });
      return finish(d, { outcome: "failed", failureClass, message }, { state: "failed", outcome: { kind: "failure", failureClass, message } });
    }
  } finally {
    try { writeMetrics(d.run); } finally { lock?.release(); }
  }
}
