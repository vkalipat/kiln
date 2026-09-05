import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock } from "../core/lock";
import { writeAtomic } from "../core/paths";
import { readStatus, writeStatus } from "../core/run";
import { rethrowIfRunCancelled, throwIfRunCancelled } from "../core/run-control";
import type { Evidence } from "../ideation/dossier";
import { writeMetrics } from "../ideation/metrics";
import { readJsonIfPresent } from "../ideation/runtime";
import { appendTournamentLine, fitRound, readTournament, seedFor } from "../ideation/tournament";
import type { FrontierFile } from "./ideate";
import type { PhaseDeps, PhaseResult } from "./frame";

export interface CheckpointIo {
  write(s: string): void;
  ask(prompt: string): Promise<string>;
}

export interface CheckpointOptions { exclude?: readonly string[]; autonomous?: boolean }
type DecisionDeps = Pick<PhaseDeps, "run" | "record">;

function spreadOrder(shown: readonly string[], cells: Readonly<Record<string, string | undefined>>): string[] {
  const buckets = new Map<string, string[]>();
  for (const id of shown) {
    const key = cells[id] ?? "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id); else buckets.set(key, [id]);
  }
  const out: string[] = [];
  for (let depth = 0; out.length < shown.length; depth += 1) {
    for (const bucket of buckets.values()) if (bucket[depth]) out.push(bucket[depth]!);
  }
  return out;
}

/** Deterministic groups of four; every shown id appears at least twice and cells are spread greedily. */
export function bwsGroups(shown: readonly string[], cells: Readonly<Record<string, string | undefined>>): string[][] {
  if (shown.length === 0) return [];
  if (shown.length < 4) throw new Error("checkpoint needs at least four shown ideas for best-worst groups");
  const ordered = spreadOrder(shown, cells);
  const make = (start: number): string[] => {
    const group = [ordered[start]!]; const usedCells = new Set([cells[group[0]!] ?? ""]);
    while (group.length < 4) {
      const candidates = Array.from({ length: ordered.length }, (_, offset) => ordered[(start + offset + 1) % ordered.length]!).filter((id) => !group.includes(id));
      const next = candidates.find((id) => !usedCells.has(cells[id] ?? "")) ?? candidates[0]!;
      group.push(next); usedCells.add(cells[next] ?? "");
    }
    return group;
  };
  const groups = ordered.map((_, start) => make(start));
  const counts = () => Object.fromEntries(shown.map((id) => [id, groups.filter((group) => group.includes(id)).length]));
  for (const id of shown) if ((counts()[id] ?? 0) < 2) groups.push(make(ordered.indexOf(id)));
  return groups;
}

function readEvidence(runDir: string, id: string): Evidence | undefined {
  try { return JSON.parse(readFileSync(join(runDir, "ideas", `${id}.evidence.json`), "utf8")) as Evidence; } catch { return undefined; }
}

function renderHash(runDir: string, id: string, round: number): string {
  const path = join(runDir, "ideas", "rendered", `${id}-r${round}.md`);
  if (!existsSync(path)) throw new Error(`missing checkpoint render ${path}`);
  return Bun.CryptoHasher.hash("sha256", readFileSync(path, "utf8"), "hex");
}

function rejectedIds(d: DecisionDeps): Set<string> {
  return new Set(d.record.read().flatMap((event) => event.t === "checkpoint.decision" && event.kind === "reject" && event.id ? [event.id] : []));
}

export function readFrontier(d: Pick<DecisionDeps, "run">): FrontierFile {
  const frontier = readJsonIfPresent<FrontierFile>(d.run.frontier);
  if (!frontier || !Array.isArray(frontier.shown) || !Array.isArray(frontier.rawFront)) throw new Error("frontier.json is missing or invalid");
  return frontier;
}

function writeFrontier(d: Pick<DecisionDeps, "run">, frontier: FrontierFile): void {
  writeAtomic(d.run.frontier, `${JSON.stringify(frontier, null, 2)}\n`);
}

function parseBws(answer: string, group: readonly string[]): { best: string; worst: string } | undefined {
  const explicit = /\bbest\s+([^\s,;]+).*\bworst\s+([^\s,;]+)/i.exec(answer);
  const words = answer.trim().split(/\s+/);
  const best = explicit?.[1] ?? words[0];
  const worst = explicit?.[2] ?? words[1];
  if (!best || !worst || best === worst || !group.includes(best) || !group.includes(worst)) return undefined;
  return { best, worst };
}

function bwsRelations(group: readonly string[], best: string, worst: string): Array<{ winner: string; loser: string }> {
  const relations = new Map<string, { winner: string; loser: string }>();
  const add = (winner: string, loser: string) => relations.set(`${winner}\0${loser}`, { winner, loser });
  for (const id of group) if (id !== best) add(best, id);
  for (const id of group) if (id !== worst && id !== best) add(id, worst);
  return [...relations.values()];
}

function appendHumanBws(d: PhaseDeps, frontier: FrontierFile, groupIndex: number, group: readonly string[], best: string, worst: string): void {
  const existing = readTournament(d.run);
  const done = new Set(existing.flatMap((line) => line.comparisonId ? [`${line.comparisonId}|${line.order}`] : []));
  let seq = existing.reduce((max, line) => Math.max(max, line.seq), 0);
  const modelById = new Map<string, string>();
  for (const line of existing) { modelById.set(line.a, line.aGenModel); modelById.set(line.b, line.bGenModel); }
  const groupHash = Bun.CryptoHasher.hash("sha256", group.join("\0"), "hex").slice(0, 12);
  bwsRelations(group, best, worst).forEach(({ winner, loser }, relationIndex) => {
    const [a, b] = winner < loser ? [winner, loser] : [loser, winner];
    const valueWinner = winner === a ? "a" as const : "b" as const;
    const comparisonId = `checkpoint-r${frontier.round}-g${groupIndex + 1}-${groupHash}-p${relationIndex + 1}`;
    for (const order of ["ab", "ba"] as const) {
      if (done.has(`${comparisonId}|${order}`)) continue;
      seq += 1;
      appendTournamentLine(d.run, {
        round: frontier.round, a, b, order, valueWinner, feasibilityWinner: "tie",
        judgeModel: "human", aGenModel: modelById.get(a) ?? "unknown", bGenModel: modelById.get(b) ?? "unknown",
        criteriaId: `checkpoint-r${frontier.round}`, aRenderHash: renderHash(d.run.dir, a, frontier.round),
        bRenderHash: renderHash(d.run.dir, b, frontier.round), costUsd: 0, source: "human", comparisonId,
        reason: `human best-worst: ${best} best, ${worst} worst`,
      }, seq);
    }
  });
}

function refitFrontier(d: PhaseDeps, frontier: FrontierFile, shown: readonly string[]): FrontierFile {
  const lines = readTournament(d.run);
  const ids = [...new Set([...shown, ...lines.flatMap((line) => [line.a, line.b])])];
  const fit = fitRound(lines, ids, {
    lambda: d.cfg.ideation.btLambda, samples: d.cfg.ideation.bootstrapSamples,
    humanWeight: d.cfg.ideation.humanWeight, level: d.cfg.ideation.dominanceLevel,
    seed: seedFor(d.run.id, frontier.round),
  });
  const value = [...shown].sort((a, b) => (fit.value[b]?.mean ?? -Infinity) - (fit.value[a]?.mean ?? -Infinity) || a.localeCompare(b));
  const feasibility = [...shown].sort((a, b) => (fit.feasibility[b]?.mean ?? -Infinity) - (fit.feasibility[a]?.mean ?? -Infinity) || a.localeCompare(b));
  return {
    ...frontier,
    ladders: { value, feasibility },
    ideas: frontier.ideas.map((idea) => ({ ...idea, value: fit.value[idea.id] ?? idea.value, feasibility: fit.feasibility[idea.id] ?? idea.feasibility })),
  };
}

function removeIdea(frontier: FrontierFile, id: string): FrontierFile {
  const without = (ids: readonly string[]) => ids.filter((candidate) => candidate !== id);
  return {
    ...frontier, rawFront: without(frontier.rawFront), shown: without(frontier.shown), eligible: without(frontier.eligible),
    ideas: frontier.ideas.filter((idea) => idea.id !== id),
    ladders: { value: without(frontier.ladders.value), feasibility: without(frontier.ladders.feasibility) },
  };
}

export function pickIdea(d: DecisionDeps, id: string): PhaseResult {
  const frontier = readFrontier(d);
  if (!frontier.shown.includes(id)) return { outcome: "failed", failureClass: "verify", message: `idea ${id} is not shown at the checkpoint` };
  d.record.append({ t: "checkpoint.decision", kind: "pick", id });
  writeStatus(d.run, { chosenIdeaId: id, phase: "form", state: "running", outcome: undefined });
  return { outcome: "ok" };
}

export function rejectIdea(d: DecisionDeps, id: string, reason: string): PhaseResult {
  const frontier = readFrontier(d);
  if (!frontier.shown.includes(id)) return { outcome: "failed", failureClass: "verify", message: `idea ${id} is not shown at the checkpoint` };
  d.record.append({ t: "checkpoint.decision", kind: "reject", id, reason });
  writeFrontier(d, removeIdea(frontier, id));
  writeStatus(d.run, { chosenIdeaId: undefined, state: "stopped", cursor: { round: frontier.round, step: "checkpoint" }, outcome: { kind: "stopped", stopKind: "rounds" } });
  return { outcome: "stopped", stopKind: "rounds" };
}

export function requestAnotherRound(d: DecisionDeps, steering: string): PhaseResult {
  const frontier = readFrontier(d);
  const next = frontier.round + 1;
  d.record.append({ t: "checkpoint.decision", kind: "another_round", steering });
  writeStatus(d.run, { chosenIdeaId: undefined, phase: "ideate", state: "running", ideationRounds: next, cursor: { round: next, step: "round.start" }, outcome: undefined });
  return { outcome: "ok" };
}

function noIdea(d: PhaseDeps, round: number): PhaseResult {
  const reasons = ["no unexcluded frontier idea remains at the checkpoint"];
  d.record.append({ t: "stop", stopKind: "no_idea_clears_bar", round, frontierEmpty: true });
  writeStatus(d.run, { chosenIdeaId: undefined, state: "done", outcome: { kind: "honest_exit", exitKind: "no_idea_clears_bar", reasons } });
  return { outcome: "honest_exit", kind: "no_idea_clears_bar", reasons };
}

function show(d: PhaseDeps, io: CheckpointIo, frontier: FrontierFile, shown: readonly string[]): void {
  io.write(`search health: ${(frontier.searchHealth * 100).toFixed(1)}% (floor ${(frontier.searchHealthFloor * 100).toFixed(1)}%); novelty enforced: ${frontier.noveltyEnforced}\n`);
  io.write("id  value  feasibility  cell  probe  prior art\n");
  for (const id of shown) {
    const idea = frontier.ideas.find((candidate) => candidate.id === id);
    const evidence = readEvidence(d.run.dir, id);
    const interval = (value: FrontierFile["ideas"][number]["value"]) => value ? `${value.mean.toFixed(2)} [${value.lo.toFixed(2)},${value.hi.toFixed(2)}]` : "unranked";
    io.write(`${id}  ${interval(idea?.value)}  ${interval(idea?.feasibility)}  ${idea?.cell ?? "?"}  ${evidence?.probe?.status ?? "not_run"}  ${evidence?.priorArt?.status ?? "not_checked"}\n`);
  }
}

async function runCheckpointUnlocked(d: PhaseDeps, io: CheckpointIo, opts: CheckpointOptions): Promise<PhaseResult> {
  let frontier = readFrontier(d);
  const excluded = rejectedIds(d); for (const id of opts.exclude ?? []) excluded.add(id);
  let shown = frontier.shown.filter((id) => !excluded.has(id));
  const trueFront = new Set(frontier.rawFront.filter((id) => !excluded.has(id)));
  if (trueFront.size === 0) return noIdea(d, frontier.round);
  if (shown.length === 0) shown = [...trueFront];
  const hashes = shown.map((id) => renderHash(d.run.dir, id, frontier.round));
  show(d, io, frontier, shown);
  const shownSet = new Set(shown);
  const shownLadders = { value: frontier.ladders.value.filter((id) => shownSet.has(id)), feasibility: frontier.ladders.feasibility.filter((id) => shownSet.has(id)) };
  d.record.append({ t: "checkpoint.shown", round: frontier.round, ideas: [...shown], hashes, ladders: shownLadders });

  if (opts.autonomous ?? d.cfg.autonomous) {
    const id = frontier.ladders.value.find((candidate) => trueFront.has(candidate)) ?? frontier.rawFront.find((candidate) => trueFront.has(candidate));
    if (!id) return noIdea(d, frontier.round);
    d.record.append({ t: "checkpoint.decision", kind: "autonomous_pick", id });
    writeStatus(d.run, { chosenIdeaId: id, phase: "form", state: "running", outcome: undefined });
    return { outcome: "ok" };
  }

  const cells = Object.fromEntries(frontier.ideas.map((idea) => [idea.id, idea.cell]));
  const prior = new Map(d.record.read().flatMap((event) => event.t === "checkpoint.bws" ? [[JSON.stringify(event.group), { best: event.best, worst: event.worst }] as const] : []));
  if (shown.length < 4 && prior.size === 0) return { outcome: "failed", failureClass: "verify", message: `checkpoint has ${shown.length} shown ideas; at least four are required for best-worst scaling` };
  const groups = shown.length >= 4 ? bwsGroups(shown, cells) : [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    let answer = prior.get(JSON.stringify(group));
    for (let attempt = 0; !answer && attempt < 2; attempt += 1) {
      const raw = await io.ask(`Group ${index + 1}: ${group.join(", ")}\nEnter best <id> worst <id>: `);
      throwIfRunCancelled();
      answer = parseBws(raw, group);
    }
    if (!answer) return { outcome: "failed", failureClass: "verify", message: `invalid best-worst response for group ${index + 1}` };
    if (!prior.has(JSON.stringify(group))) d.record.append({ t: "checkpoint.bws", group: [...group], best: answer.best, worst: answer.worst });
    appendHumanBws(d, frontier, index, group, answer.best, answer.worst);
  }
  frontier = refitFrontier(d, frontier, shown); writeFrontier(d, frontier);
  io.write(`value: ${frontier.ladders.value.join(" > ")}\nfeasibility: ${frontier.ladders.feasibility.join(" > ")}\n`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await io.ask("Choose: pick <id> | reject <id> <reason> | another <steering>: ");
    throwIfRunCancelled();
    const trimmed = answer.trim();
    const [command, id, ...rest] = trimmed.split(/\s+/);
    if (command === "pick" && id && shown.includes(id)) return pickIdea(d, id);
    if (command === "reject" && id && shown.includes(id) && rest.length > 0) {
      const result = rejectIdea(d, id, rest.join(" "));
      frontier = readFrontier(d); shown = frontier.shown.filter((candidate) => !excluded.has(candidate));
      if (frontier.rawFront.length === 0) return noIdea(d, frontier.round);
      io.write(`rejected ${id}; ${shown.length} shown ideas remain\n`);
      if (result.outcome === "failed") return result;
      continue;
    }
    if (command === "another" && [id, ...rest].filter(Boolean).length > 0) return requestAnotherRound(d, [id, ...rest].filter(Boolean).join(" "));
    io.write("invalid checkpoint decision\n");
  }
  return { outcome: "failed", failureClass: "verify", message: "checkpoint decision was not valid after five attempts" };
}

export async function runCheckpoint(d: PhaseDeps, io: CheckpointIo, opts: CheckpointOptions = {}): Promise<PhaseResult> {
  throwIfRunCancelled();
  const lock = d.lockHeld ? undefined : acquireRunLock(d.run, { force: d.forceLock });
  try {
    try {
      const result = await runCheckpointUnlocked(d, io, opts);
      throwIfRunCancelled();
      if (result.outcome === "failed") {
        d.record.append({ t: "failure", class: result.failureClass, message: result.message });
        writeStatus(d.run, { state: "failed", outcome: { kind: "failure", failureClass: result.failureClass, message: result.message } });
      }
      return result;
    }
    catch (error) {
      rethrowIfRunCancelled(error);
      const message = error instanceof Error ? error.message : String(error);
      d.record.append({ t: "failure", class: "integrity", message });
      writeStatus(d.run, { state: "failed", outcome: { kind: "failure", failureClass: "integrity", message } });
      return { outcome: "failed", failureClass: "integrity", message };
    }
  } finally {
    try { writeMetrics(d.run); } finally { lock?.release(); }
  }
}
