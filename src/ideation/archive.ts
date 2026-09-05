import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import type { IdeaRejectReason } from "../core/events";
import { writeAtomic } from "../core/paths";
import type { RunRecord } from "../core/record";
import type { RunPaths } from "../core/run";
import type { PhaseDeps } from "../phases/frame";
import { effortFor } from "../providers/models";
import { type Dossier, type Evidence, renderDossier } from "./dossier";
import { type Cell, cellKey } from "./frontier";
import { bestMatch } from "./novelty";

/**
 * The archive (record §4, §5): every island idea, its evidence sidecar, and serial novelty rejection.
 * Two invariants shape everything here. The archive keeps every idea — a rejection is a status on
 * the entry, never a deletion, so `lost_cell` filters seeding and display without touching the
 * Pareto computation. And insertion is serial in a fixed order after every island has finished, so
 * the same ten island files always produce the same archive whichever island answered first.
 */

/** One archive entry: the dossier as derived from the raw island file, plus its evidence sidecar. */
export interface ArchiveEntry { dossier: Dossier; evidence: Evidence }

export interface InsertOptions {
  /** Trigram similarity to the nearest archive entry at insertion time (record §5). */
  similarity?: number;
  vsBound?: boolean;
  /** Stored verbatim as `ideas/<id>.md`; defaults to the canonical dossier render. */
  source?: string;
  /** Store the idea already rejected, so a restatement still joins the archive (record §4). */
  reject?: { reason: IdeaRejectReason; against?: string };
}

function evidencePath(run: RunPaths, id: string): string {
  return join(run.ideasDir, `${id}.evidence.json`);
}

/** The sidecar on disk, or undefined when there is none or it cannot be parsed. */
function readEvidence(run: RunPaths, id: string): Evidence | undefined {
  const path = evidencePath(run, id);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Evidence;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // A torn or hand-edited sidecar is treated as absent; the run re-derives what it can.
    return undefined;
  }
}

function writeEvidence(run: RunPaths, id: string, e: Evidence): void {
  writeAtomic(evidencePath(run, id), `${JSON.stringify(e, null, 2)}\n`);
}

/**
 * The run's `ideas/` directory as an index. Entries arrive through `insert` only: on resume the
 * caller re-derives the same dossiers from the raw island files and re-inserts them, and an entry
 * whose sidecar already exists adopts it instead of overwriting what earlier rounds learned.
 */
export class Archive {
  private readonly entries = new Map<string, ArchiveEntry>();

  constructor(
    private readonly run: RunPaths,
    private readonly record: RunRecord,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): ArchiveEntry | undefined {
    return this.entries.get(id);
  }

  /** Every dossier, in insertion order — including rejected ones, which novelty still compares against. */
  all(): Dossier[] {
    return [...this.entries.values()].map((e) => e.dossier);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Index an idea the archive already decided — one in memory, or one whose sidecar survives on disk
   * from a previous process — and return that standing; undefined means the idea is new. Callers
   * check this *before* spending anything, so a resume never re-buys a decision already on disk.
   */
  adopt(d: Dossier): Evidence | undefined {
    const known = this.entries.get(d.id);
    if (known) return known.evidence;
    const onDisk = readEvidence(this.run, d.id);
    if (!onDisk) return undefined;
    this.entries.set(d.id, { dossier: d, evidence: onDisk });
    return onDisk;
  }

  /** Add one idea. Idempotent: an id already indexed, or one whose sidecar survives on disk, is adopted. */
  insert(d: Dossier, opts: InsertOptions = {}): Evidence {
    const held = this.adopt(d);
    if (held) return held;
    const cell = cellKey(d.axisValues);
    // `parents` is written now, while it is always empty, because the sidecar is the protected,
    // resume-authoritative artifact: a field added after runs exist is missing from all of them.
    const evidence: Evidence = { status: opts.reject ? "rejected" : "unranked", cell, parents: [...d.parents] };
    if (opts.reject) evidence.rejectReason = opts.reject.reason;
    if (opts.similarity !== undefined) evidence.similarity = opts.similarity;
    if (opts.vsBound !== undefined) evidence.vsBound = opts.vsBound;
    // `ideas/<id>.md` is the island's own words (record §10); the judge's view is rendered per round.
    writeAtomic(join(this.run.ideasDir, `${d.id}.md`), opts.source ?? renderDossier(d, undefined, { forJudge: false }));
    writeEvidence(this.run, d.id, evidence);
    this.entries.set(d.id, { dossier: d, evidence });
    if (opts.reject) this.record.append({ t: "idea.reject", id: d.id, reason: opts.reject.reason, against: opts.reject.against });
    else this.record.append({ t: "idea.insert", id: d.id, cell, similarity: opts.similarity ?? 0, parents: d.parents });
    return evidence;
  }

  /**
   * Merge fields into an idea's evidence. The sidecar is re-read first, so a probe result written
   * straight to disk by the probe runner is never clobbered by a stale in-memory copy.
   */
  mergeEvidence(id: string, patch: Partial<Evidence>): Evidence | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const next: Evidence = { ...entry.evidence, ...(readEvidence(this.run, id) ?? {}), ...patch };
    writeEvidence(this.run, id, next);
    entry.evidence = next;
    return next;
  }

  /** Every idea's cell, keyed by id — the shape `trimForCheckpoint` and `mmrSelect` index by. */
  cells(): Record<string, Cell> {
    const out: Record<string, Cell> = {};
    for (const [id, e] of this.entries) out[id] = e.dossier.axisValues;
    return out;
  }

  /** Ideas still eligible to seed a round or appear at the checkpoint: everything not rejected. */
  seedable(): string[] {
    return [...this.entries].filter(([, e]) => e.evidence.status !== "rejected").map(([id]) => id);
  }

  /** Inserted but never compared: admitted to no tournament yet, and free to enter a later one. */
  unranked(): string[] {
    return [...this.entries].filter(([, e]) => e.evidence.status === "unranked").map(([id]) => id);
  }

  /**
   * The strongest surviving idea of each cell, strongest cell first. A cell whose ideas have no
   * strengths yet still has a champion — the checkpoint backfills from these when the frontier is
   * short (record §7), and the evolve step seeds from them when it is nearly empty (record §8).
   */
  champions(): string[] {
    const best = new Map<string, { id: string; mean: number }>();
    for (const [id, e] of this.entries) {
      if (e.evidence.status === "rejected") continue;
      const key = e.evidence.cell ?? cellKey(e.dossier.axisValues);
      const mean = e.evidence.strengths?.value.mean ?? Number.NEGATIVE_INFINITY;
      const held = best.get(key);
      if (!held || mean > held.mean) best.set(key, { id, mean });
    }
    return [...best.values()].sort((a, b) => b.mean - a.mean || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => c.id);
  }

  /** Flag an idea rejected. Unknown ids are ignored: bookkeeping must never end a round. */
  markRejected(id: string, reason: IdeaRejectReason, against?: string): void {
    if (!this.entries.has(id)) return;
    this.mergeEvidence(id, { status: "rejected", rejectReason: reason });
    this.record.append({ t: "idea.reject", id, reason, against });
  }

  /**
   * After the round's fit, each cell keeps only its strongest idea (record §4).
   *
   * `valueMeans` holds exactly the ideas that had an interval in this round's fit; an idea absent
   * from it was never admitted to that round's tournament and is exempt this round — the archive
   * cannot know what the tournament did, so the caller states it. `lost_cell` is a seeding and
   * display filter: the idea stays in the archive and in the Pareto computation.
   */
  markLostCell(valueMeans: Readonly<Record<string, number>>): string[] {
    const byCell = new Map<string, string[]>();
    for (const [id, e] of this.entries) {
      if (e.evidence.status === "rejected") continue;
      const mean = valueMeans[id];
      if (mean === undefined) continue;
      const key = e.evidence.cell ?? cellKey(e.dossier.axisValues);
      const lane = byCell.get(key);
      if (lane) lane.push(id);
      else byCell.set(key, [id]);
    }
    const lost: string[] = [];
    for (const key of [...byCell.keys()].sort()) {
      const ids = byCell.get(key)!;
      if (ids.length < 2) continue;
      const keep = ids.reduce((a, b) => (valueMeans[b]! > valueMeans[a]! || (valueMeans[b]! === valueMeans[a]! && b < a) ? b : a));
      for (const id of ids) {
        if (id === keep) continue;
        this.markRejected(id, "lost_cell");
        lost.push(id);
      }
    }
    return lost;
  }
}

export interface NoveltyVerdict { restatement: boolean; reason: string; costUsd: number }

export const NOVELTY_SCHEMA = {
  type: "object",
  properties: { restatement: { type: "boolean" }, reason: { type: "string" } },
  required: ["restatement", "reason"],
  additionalProperties: false,
} as const;

/**
 * One arbiter call: is the candidate a restatement of its nearest archive match (record §5)? The
 * cheap trigram check only says the two are close; this is what decides. An arbiter that answers
 * nothing falls back to the mechanical decision that brought us here, which is "restatement" —
 * the same fallback the spent-cap path takes, so a flake and an exhausted budget behave alike.
 */
export async function noveltyVerdict(deps: PhaseDeps, candidate: Dossier, match: Dossier): Promise<NoveltyVerdict> {
  const { model } = deps.models("arbiter");
  let captured: { restatement: boolean; reason: string } | undefined;
  const tool: AgentTool<any> = {
    name: "novelty",
    label: "Novelty",
    intent: "omit",
    description: "Say whether the candidate idea is a restatement of the archive idea it was matched against.",
    parameters: NOVELTY_SCHEMA,
    examples: [
      { caption: "A restatement", call: { restatement: true, reason: "Same mechanism for the same users; only the name changed." } },
    ],
    async execute(_id, p: { restatement?: boolean; reason?: string }) {
      captured = { restatement: p.restatement === true, reason: String(p.reason ?? "").trim() };
      return { content: [{ type: "text" as const, text: "novelty verdict recorded" }] };
    },
  };
  const brain = createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: [tool],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "arbiter")],
    pinned: `Novelty tie-break for idea ${candidate.id} against ${match.id}.`,
    record: deps.record,
    role: "arbiter",
    phase: "ideate",
    turnCap: 2,
    effort: effortFor(deps.cfg, "arbiter", model),
    streamFn: deps.streamFn,
    terminalTools: ["novelty"],
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const side = (label: string, d: Dossier) =>
    [`## ${label}`, `Title: ${d.title}`, `Mechanism: ${d.mechanism}`, `Testable claim: ${d.testableClaim}`].join("\n");
  const { costUsd } = await brain.run(
    [side("Candidate", candidate), "", side("Nearest archive idea", match), "", "Call the novelty tool."].join("\n"),
  );
  if (!captured) return { restatement: true, reason: "arbiter gave no verdict; the similarity threshold decides", costUsd };
  return { ...captured, costUsd };
}

/** One island idea on its way into the archive, as `deriveIdeas` produced it. */
export interface InsertCandidate {
  dossier: Dossier;
  vsBound?: boolean;
  /** The island's own `# Idea <n>` block, stored as `ideas/<id>.md`. */
  block?: string;
}

export interface InsertOutcome {
  id: string;
  /** What this call did. `reused` is an idea the archive already held — in memory, or on disk after
   *  a resume — which costs nothing and spends no tie-break. */
  status: "inserted" | "restatement" | "reused";
  /** How the archive stands for this idea afterwards, and what `inserted`/`rejected` below follow.
   *  A `reused` idea an earlier round rejected reports that round's reason, not `restatement`. */
  rejectedAs?: IdeaRejectReason;
  similarity: number;
  /** The nearest archive idea the candidate was measured against. */
  against?: string;
  /** True when the decision spent an arbiter tie-break. */
  arbiter: boolean;
}

export interface InsertAllOptions {
  /** Novelty tie-breaks still affordable this round; defaults to `ideation.arbiterCaps.novelty`. */
  arbiterBudget?: number;
}

export interface InsertAllResult {
  outcomes: InsertOutcome[];
  /** Ids the archive now holds live, whether this call inserted them or an earlier one did. */
  inserted: string[];
  /** Ids the archive holds rejected, whether this call rejected them or an earlier round did. */
  rejected: string[];
  arbiterCalls: number;
  costUsd: number;
}

const IDEA_ID = /^r(\d+)-i(\d+)-(\d+)$/;

/**
 * The fixed order record §4 requires: round, then island, then idea, each compared as a number so
 * `r1-i2-10` follows `r1-i2-9` instead of `r1-i2-2`. An id that is not `r<round>-i<island>-<n>`
 * keeps its given order, after every id that is.
 */
export function fixedOrder(candidates: readonly InsertCandidate[]): InsertCandidate[] {
  return candidates
    .map((c, i) => ({ c, i, k: IDEA_ID.exec(c.dossier.id) }))
    .sort((x, y) => {
      if (!x.k || !y.k) return (x.k ? 0 : 1) - (y.k ? 0 : 1) || x.i - y.i;
      return Number(x.k[1]) - Number(y.k[1]) || Number(x.k[2]) - Number(y.k[2]) || Number(x.k[3]) - Number(y.k[3]) || x.i - y.i;
    })
    .map((e) => e.c);
}

/**
 * Insert a round's ideas with novelty rejection (record §4, §5).
 *
 * Every island must have finished first, and the candidates are sorted into the fixed order here
 * rather than trusted to arrive in it: insertion is serial because each decision is made against
 * the archive as the previous decisions left it, so island completion order would otherwise decide
 * which of two ideas that restate each other keeps the slot, and the run would not replay. This
 * function takes no limiter and starts no concurrency.
 *
 * An idea the archive already decided is adopted before anything is spent on it, so a resume
 * neither re-buys a tie-break against the round's cap nor reports a standing the archive
 * contradicts. Otherwise at most one tie-break is spent per idea, and none once `arbiterBudget` is
 * exhausted; past the cap the mechanical threshold decides and the fallback is recorded.
 */
export async function insertAll(
  deps: PhaseDeps,
  archive: Archive,
  candidates: readonly InsertCandidate[],
  opts: InsertAllOptions = {},
): Promise<InsertAllResult> {
  const threshold = deps.cfg.ideation.jaccardThreshold;
  let budget = opts.arbiterBudget ?? deps.cfg.ideation.arbiterCaps.novelty;
  const result: InsertAllResult = { outcomes: [], inserted: [], rejected: [], arbiterCalls: 0, costUsd: 0 };
  const settle = (o: InsertOutcome) => {
    result.outcomes.push(o);
    if (o.rejectedAs) result.rejected.push(o.id);
    else result.inserted.push(o.id);
  };
  for (const c of fixedOrder(candidates)) {
    const d = c.dossier;
    const held = archive.adopt(d);
    if (held) {
      const rejectedAs = held.status === "rejected" ? ((held.rejectReason ?? "restatement") as IdeaRejectReason) : undefined;
      settle({ id: d.id, status: "reused", rejectedAs, similarity: held.similarity ?? 0, arbiter: false });
      continue;
    }
    const match = bestMatch(d, archive.all());
    const similarity = match?.similarity ?? 0;
    let restatement = false;
    let usedArbiter = false;
    if (match && similarity >= threshold) {
      if (budget > 0) {
        budget -= 1;
        usedArbiter = true;
        result.arbiterCalls += 1;
        const v = await noveltyVerdict(deps, d, archive.get(match.id)!.dossier);
        result.costUsd += v.costUsd;
        restatement = v.restatement;
        deps.record.append({
          t: "arbiter.verdict",
          kind: "novelty",
          id: d.id,
          against: match.id,
          verdict: restatement ? "restatement" : "distinct",
          costUsd: v.costUsd,
        });
      } else {
        restatement = true;
        deps.record.append({
          t: "note",
          text: `novelty arbiter cap spent; ${d.id} rejected as a restatement of ${match.id} on the similarity threshold (${similarity.toFixed(3)} >= ${threshold})`,
        });
      }
    }
    archive.insert(d, {
      similarity,
      vsBound: c.vsBound,
      source: c.block,
      reject: restatement ? { reason: "restatement", against: match?.id } : undefined,
    });
    const status = restatement ? ("restatement" as const) : ("inserted" as const);
    settle({ id: d.id, status, rejectedAs: restatement ? "restatement" : undefined, similarity, against: match?.id, arbiter: usedArbiter });
  }
  return result;
}
