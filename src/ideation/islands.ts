import type { Model } from "@oh-my-pi/pi-catalog";
import { createBrain } from "../brain/agent";
import { loadPrompt, playbookSection } from "../brain/prompts";
import type { KilnConfig } from "../core/config";
import type { RunRecord } from "../core/record";
import { bullets } from "../phases/contracts";
import type { PhaseDeps } from "../phases/frame";
import { effortFor } from "../providers/models";
import { type Axis, parseDossier, splitIdeas, validateDossier } from "./dossier";
import { formatRawIsland, type IslandBatch } from "./island-raw";

export { deriveIdeas, formatRawIsland, parseRawIsland, rawIslandPath, writeRawIsland } from "./island-raw";
export type { DerivedIdea, IslandBatch, RawIsland } from "./island-raw";

/**
 * Islands (record §4, §8): stateless toolless generators, two batches each, assigned a lens
 * (round 1) or a mutation operator (later) deterministically by the harness.
 *
 * The island's unit of idempotence is the whole session: `ideas/raw/r<n>-i<k>.md` is written once,
 * after both batches, and every id, dossier and `vsBound` downstream is a pure function of that
 * file — which is why the file carries its own header and per-batch markers rather than depending
 * on state held by the caller.
 */

/** At least this many of a verbalized-distribution batch must sit below `VS_PROBABILITY_MAX`. */
export const VS_MIN_UNDER = 3;
/** "Under 10 percent" as a probability; a batch that clears it is `vsBound` (record §4). */
export const VS_PROBABILITY_MAX = 0.1;

/** A resolved model seat, the same shape `PhaseDeps.models(role)` returns. */
export interface ModelChoice { model: Model; ref: string }

/**
 * The model candidates an assignment may draw on. `PhaseDeps.models(role)` resolves one model per
 * role and so cannot enumerate providers; the caller builds these lists with `resolveRoleOn(role,
 * provider, cfg, available)`, one entry per available provider, in the order to alternate through.
 */
export interface IslandModels {
  generator: readonly ModelChoice[];
  /** Cheap-list candidates for the cheap island slot; empty or absent disables the slot. */
  cheap?: readonly ModelChoice[];
}

/** One counted playbook bullet: `- L1 [helpful:0 harmful:0] <text>`. */
export interface PlaybookMove { id: string; text: string }

export interface IslandPlan {
  round: number;
  /** 1-based, as it appears in the idea id `r<round>-i<island>-<n>`. */
  island: number;
  model: Model;
  ref: string;
  cheap: boolean;
  /** Round 1 only. */
  lens?: PlaybookMove;
  /** Rounds after the first. */
  operator?: PlaybookMove;
}

const MOVE_BULLET = /^([A-Za-z]+\d+)\s*(?:\[[^\]]*\])?\s*(.*)$/s;

/** The counted bullets of a playbook section, in file order; bullets without an id are skipped. */
export function playbookMoves(playbook: string, section: string): PlaybookMove[] {
  const out: PlaybookMove[] = [];
  for (const b of bullets(playbookSection(playbook, section))) {
    const m = MOVE_BULLET.exec(b);
    if (m && m[2] !== undefined && m[2].trim() !== "") out.push({ id: m[1]!, text: m[2].trim() });
  }
  return out;
}

/** Drop the judge's own model, unless that would leave nothing to generate with (record §2). */
function away(candidates: readonly ModelChoice[], judgeModel: string): readonly ModelChoice[] {
  const rest = candidates.filter((c) => c.ref !== judgeModel);
  return rest.length > 0 ? rest : candidates;
}

/**
 * This round's island assignment: one lens per island in round 1, one mutation operator per island
 * afterwards, the cheap slot rotating through the islands, and the remaining seats alternating
 * through the generator candidates while avoiding the judge's model.
 *
 * Pure and total: the same arguments always give the same plans, so a resumed round re-derives the
 * assignment it already ran instead of reading it back out of the journal.
 */
export function assignIslands(
  round: number,
  cfg: KilnConfig,
  playbook: string,
  judgeModel: string,
  models: IslandModels,
): IslandPlan[] {
  const n = cfg.ideation.islands;
  const generator = away(models.generator, judgeModel);
  if (generator.length === 0) throw new Error("assignIslands: no generator model candidates supplied");
  const cheap = away(models.cheap ?? [], judgeModel);
  // Lenses open the search in round 1; from round 2 the operators mutate what the frontier holds.
  const pool = playbookMoves(playbook, round === 1 ? "lenses" : "ideate");
  // Consecutive rounds start where the last one stopped, so five operators over three islands are
  // all used before any is repeated.
  const base = round === 1 ? 0 : (round - 2) * n;
  const cheapAt = cfg.ideation.cheapIsland && cheap.length > 0 ? (round - 1) % n : -1;
  const plans: IslandPlan[] = [];
  let seat = 0;
  for (let k = 0; k < n; k++) {
    const isCheap = k === cheapAt;
    const choice = isCheap ? cheap[(round - 1) % cheap.length]! : generator[seat++ % generator.length]!;
    const move = pool.length > 0 ? pool[(base + k) % pool.length] : undefined;
    const plan: IslandPlan = { round, island: k + 1, model: choice.model, ref: choice.ref, cheap: isCheap };
    if (move) {
      if (round === 1) plan.lens = move;
      else plan.operator = move;
    }
    plans.push(plan);
  }
  return plans;
}

/** Record one `island.assign` per plan; separate from `assignIslands` so the assignment stays pure. */
export function recordIslandAssignments(record: RunRecord, plans: readonly IslandPlan[]): void {
  for (const p of plans) record.append({ t: "island.assign", round: p.round, island: p.island, model: p.ref, lens: p.lens?.id, operator: p.operator?.id });
}

/** What one island is shown: the brief and landscape verbatim, the vocabulary, and the round's seeds. */
export interface IslandInputs {
  brief: string;
  landscape: string;
  axes: readonly Axis[];
  /** Rendered frontier dossiers to mutate; empty in round 1 (record §8). */
  seeds?: readonly string[];
  /** The previous round's meta-review of why losers lost (record §7). */
  metaReview?: string;
}

/** The island's pinned block: its seat, its one move, and the closed vocabulary it must choose from. */
export function islandContract(plan: IslandPlan, inputs: IslandInputs, cfg: KilnConfig): string {
  const move = plan.lens ?? plan.operator;
  const lines = [
    `Round ${plan.round} of ${cfg.ideation.rounds}, island ${plan.island} of ${cfg.ideation.islands}.`,
    `Two batches of exactly ${cfg.ideation.ideasPerBatch} ideas each.`,
  ];
  if (move) {
    const kind = plan.lens ? "Lens" : "Mutation operator";
    lines.push(`${kind} ${move.id} — apply it to every idea you write this round: ${move.text}`);
  }
  lines.push(
    "Axis vocabulary. Every idea gives one value per axis, chosen from these lists and nothing else:",
    ...inputs.axes.map((a) => `- ${a.name}: ${a.values.join(" | ")}`),
  );
  return lines.join("\n");
}

export interface BatchCheck {
  /** The `# Idea <n>` blocks the batch actually contains, headings stripped. */
  blocks: string[];
  /** Everything to quote back in the single re-ask; empty means the batch is usable as written. */
  problems: string[];
  /** True when both rules record §4 states — the batch size and the verbalized distribution — held.
   *  It is the source of the dossiers' `vsBound`, so a batch still wrong after its one re-ask is
   *  marked unbounded while a merely untidy one (a missing section, a stray axis value) is not. */
  bounded: boolean;
}

export interface BatchCheckOptions {
  count: number;
  /** Ideas that must state a probability below `VS_PROBABILITY_MAX`; 0 turns the rule off. */
  minUnder?: number;
  /** When given, every idea is also checked against the brief's closed vocabulary and the caps. */
  axes?: readonly Axis[];
}

/**
 * Validate one batch: exactly `count` blocks, at least `minUnder` of them below the VS threshold,
 * and — when axes are supplied — every idea complete and inside the vocabulary. The problems are
 * what the one re-ask quotes back; `bounded` is what survives the re-ask as `vsBound` (record §4).
 */
export function validateBatch(md: string, opts: BatchCheckOptions): BatchCheck {
  const minUnder = opts.minUnder ?? VS_MIN_UNDER;
  const blocks = splitIdeas(md);
  const problems: string[] = [];
  const rightSize = blocks.length === opts.count;
  if (!rightSize) problems.push(`expected exactly ${opts.count} "# Idea <n>" blocks, found ${blocks.length}`);
  let under = 0;
  blocks.forEach((block, i) => {
    const { dossier, missing } = parseDossier(block);
    const p = dossier.vsProbability;
    if (p !== undefined && p < VS_PROBABILITY_MAX) under += 1;
    if (missing.length > 0) problems.push(`idea ${i + 1} is missing: ${missing.join(", ")}`);
    if (opts.axes) for (const e of validateDossier(dossier, opts.axes)) problems.push(`idea ${i + 1}: ${e}`);
  });
  const distributed = under >= minUnder;
  if (!distributed) problems.push(`only ${under} of ${blocks.length} ideas state a probability below ${VS_PROBABILITY_MAX}; at least ${minUnder} must`);
  return { blocks, problems, bounded: rightSize && distributed };
}

export interface IslandRun {
  /** The whole session as it is written to `ideas/raw/r<n>-i<k>.md`. */
  raw: string;
  /** The `# Idea <n>` blocks of each batch, in order. */
  batches: string[][];
  bounded: boolean[];
  /** How many batches needed their one re-ask. */
  reasked: number;
  costUsd: number;
  /** A high-water signal from any model turn in this island session. */
  contextPressure: boolean;
  /** Set when the model failed; the batches produced before the failure are still returned. */
  error?: string;
  errorStatus?: number;
  errorId?: string;
  stopped?: "error" | "turn_cap";
}

function firstTurn(inputs: IslandInputs, count: number): string {
  const parts = ["## Brief", inputs.brief.trim(), "", "## Landscape", inputs.landscape.trim()];
  if (inputs.seeds && inputs.seeds.length > 0) parts.push("", "## Ideas on the frontier so far", ...inputs.seeds.map((s) => s.trim()));
  if (inputs.metaReview && inputs.metaReview.trim() !== "") parts.push("", "## Why the last round's losers lost", inputs.metaReview.trim());
  parts.push(
    "",
    `Batch 1 of 2. Write exactly ${count} ideas as a verbalized distribution: give every idea a Probability and make at least ${VS_MIN_UNDER} of them below ${VS_PROBABILITY_MAX}.`,
  );
  return parts.join("\n");
}

function secondTurn(count: number): string {
  return `Batch 2 of 2. Write exactly ${count} more ideas that are unlike the first ${count}: different mechanisms, not variations, refinements or restatements of them. Same format, same axis vocabulary, a Probability on each.`;
}

function reask(problems: readonly string[], count: number): string {
  return [
    "That batch is not usable yet:",
    ...problems.map((p) => `- ${p}`),
    `Rewrite the whole batch: exactly ${count} \`# Idea <n>\` blocks with every section present, fixing each problem above.`,
  ].join("\n");
}

/**
 * Run one island: a toolless brain over two batches, each validated once and re-asked at most once
 * before it is accepted as written (record §4). Nothing reaches disk here — the caller passes `raw`
 * to `writeRawIsland` after both batches, which is what makes the session the unit of idempotence.
 */
export async function runIsland(deps: PhaseDeps, plan: IslandPlan, inputs: IslandInputs): Promise<IslandRun> {
  const count = deps.cfg.ideation.ideasPerBatch;
  const brain = createBrain({
    model: plan.model,
    getApiKey: () => deps.apiKeyFor(String(plan.model.provider)),
    tools: [],
    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "generator")],
    pinned: islandContract(plan, inputs, deps.cfg),
    record: deps.record,
    role: "generator",
    phase: "ideate",
    // Two batches plus at most one re-ask each; the island has no tools, so a turn is one answer.
    turnCap: 4,
    effort: effortFor(deps.cfg, "generator", plan.model),
    streamFn: deps.streamFn,
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
  const batches: IslandBatch[] = [];
  let reasked = 0;
  let costUsd = 0;
  let contextPressure = false;
  let error: string | undefined;
  let errorStatus: number | undefined;
  let errorId: string | undefined;
  let stopped: IslandRun["stopped"];
  for (let n = 0; n < 2; n += 1) {
    // The VS rule is asked of the first turn only; the second is asked for ideas unlike the first.
    const opts: BatchCheckOptions = { count, minUnder: n === 0 ? VS_MIN_UNDER : 0, axes: inputs.axes };
    let text = "";
    let check: BatchCheck | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = await brain.run(attempt === 1 ? reask(check!.problems, count) : n === 0 ? firstTurn(inputs, count) : secondTurn(count));
      // Billed per run, not diffed off the journal: all three islands of a round share one
      // limiter, so a sequence-number window would sweep in the other two islands' calls.
      costUsd += r.costUsd;
      contextPressure ||= r.contextPressure === true;
      if (r.stopped === "error" || r.stopped === "turn_cap") {
        error = r.error ?? `island stopped: ${r.stopped}`;
        errorStatus = r.errorStatus;
        errorId = r.errorId;
        stopped = r.stopped;
        break;
      }
      text = r.text;
      check = validateBatch(text, opts);
      if (check.problems.length === 0 || attempt === 1) break;
      reasked += 1;
    }
    // A batch whose re-ask failed to reach the model is still the batch the island wrote, so it is
    // kept rather than thrown away with the error.
    if (check !== undefined) batches.push({ text, bounded: check.bounded });
    if (error !== undefined) break;
  }
  const raw = formatRawIsland(plan, batches);
  return {
    raw,
    batches: batches.map((batch) => splitIdeas(batch.text)),
    bounded: batches.map((batch) => batch.bounded),
    reasked,
    costUsd,
    contextPressure,
    error,
    errorStatus,
    errorId,
    stopped,
  };
}
