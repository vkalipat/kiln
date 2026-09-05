/** Tournament admission and pairing (decision record §7).
 *
 *  Admission: standing frontier anchors first, then new ideas by archive-cell spread.
 *  Pairing: an exhaustive round robin for a small field, Swiss by strength proximity above it,
 *  in both cases scheduling until every entrant reaches `minComparisons` or the pair cap binds.
 *  Pure and deterministic: identical inputs give an identical schedule, and the schedule does
 *  not depend on the order of the `entrants` array. */

import { type Cell, cellKey } from "./frontier";

export interface ArchiveEntry {
  id: string;
  cell: Cell | string;
}

/** Either cell key to ideas (in the order they should be offered), or a flat entry list. */
export type ArchiveInput = Record<string, readonly string[]> | readonly ArchiveEntry[];

export interface SelectEntrantsInput {
  archive: ArchiveInput;
  anchors?: readonly string[];
  entrantsCap: number;
  anchorsCap: number;
}

export type ExistingPair = readonly [string, string] | { a: string; b: string };

export interface SchedulePairsInput {
  entrants: readonly string[];
  /** Entrants carrying cumulative history; the schedule avoids anchor-versus-anchor pairs. */
  anchors?: readonly string[];
  /** Pairs already judged, in any round; they are never repeated but do count toward the
   *  minimum, so an entrant returning as an anchor is not re-measured for its own sake. */
  existing?: readonly ExistingPair[];
  pairCap: number;
  minComparisons: number;
  /** Current log-strengths for Swiss proximity; absent ideas sit at 0. */
  strengths?: Record<string, number>;
}

/** Round-robin is exhaustive, so it is only affordable for a small field. */
export const ROUND_ROBIN_MAX = 6;

/** Work budget for the matching search; the greedy descent is tried first, so this only
 *  bounds the backtracking that a repeat-blocked round needs. */
const SEARCH_BUDGET = 20000;

/** Tournament admission: anchors in the order given (at most `anchorsCap`), then new ideas
 *  taken one per archive cell in sorted cell order, in each cell's given order, until
 *  `entrantsCap`. Everything not admitted stays unranked in the archive and may enter later. */
export function selectEntrants(input: SelectEntrantsInput): string[] {
  const lanes = normalizeArchive(input.archive);
  const seated: string[] = [];
  const seen = new Set<string>();
  for (const anchor of input.anchors ?? []) {
    if (seated.length >= Math.min(input.anchorsCap, input.entrantsCap)) break;
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    seated.push(anchor);
  }
  // One cursor per cell: a cell whose next idea is already seated as an anchor advances to its
  // following idea rather than forfeiting its turn, so the spread survives anchor overlap.
  const cursors = lanes.map(() => 0);
  while (seated.length < input.entrantsCap) {
    let progressed = false;
    for (let lane = 0; lane < lanes.length && seated.length < input.entrantsCap; lane++) {
      const ids = lanes[lane]!;
      while (cursors[lane]! < ids.length && seen.has(ids[cursors[lane]!]!)) cursors[lane]!++;
      if (cursors[lane]! >= ids.length) continue;
      const id = ids[cursors[lane]!]!;
      cursors[lane]!++;
      seen.add(id);
      seated.push(id);
      progressed = true;
    }
    if (!progressed) break;
  }
  return seated;
}

function normalizeArchive(archive: ArchiveInput): string[][] {
  if (Array.isArray(archive)) {
    const byCell = new Map<string, string[]>();
    for (const entry of archive as readonly ArchiveEntry[]) {
      const key = cellKey(entry.cell);
      const lane = byCell.get(key);
      if (lane) lane.push(entry.id);
      else byCell.set(key, [entry.id]);
    }
    return [...byCell.keys()].sort().map((key) => byCell.get(key)!);
  }
  const record = archive as Record<string, readonly string[]>;
  return Object.keys(record)
    .sort()
    .map((key) => [...(record[key] ?? [])]);
}

interface Ctx {
  ids: string[];
  anchors: Set<string>;
  strengths: Record<string, number>;
  counts: Map<string, number>;
  played: Set<string>;
  pairs: [string, string][];
  cap: number;
  min: number;
}

/** Schedule this round's pairs. Every pair is emitted with its ids in canonical (sorted) order,
 *  which is what makes `(round, a, b, order)` a stable resume key. */
export function schedulePairs(input: SchedulePairsInput): [string, string][] {
  const ids = [...new Set(input.entrants)].sort();
  const ctx: Ctx = {
    ids,
    anchors: new Set((input.anchors ?? []).filter((id) => ids.includes(id))),
    strengths: input.strengths ?? {},
    counts: new Map(ids.map((id) => [id, 0])),
    played: new Set(),
    pairs: [],
    cap: Math.max(0, input.pairCap),
    min: input.minComparisons,
  };
  for (const existing of input.existing ?? []) {
    const [a, b] = Array.isArray(existing)
      ? [existing[0] as string, existing[1] as string]
      : [(existing as { a: string; b: string }).a, (existing as { a: string; b: string }).b];
    ctx.played.add(key(a, b));
    bump(ctx, a);
    bump(ctx, b);
  }
  if (ids.length < 2 || ctx.cap === 0) return [];
  if (ids.length <= ROUND_ROBIN_MAX) roundRobin(ctx);
  swiss(ctx);
  return ctx.pairs;
}

function key(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function bump(ctx: Ctx, id: string): void {
  if (ctx.counts.has(id)) ctx.counts.set(id, ctx.counts.get(id)! + 1);
}

function add(ctx: Ctx, a: string, b: string): void {
  ctx.pairs.push(a < b ? [a, b] : [b, a]);
  ctx.played.add(key(a, b));
  bump(ctx, a);
  bump(ctx, b);
}

/** Circle method: every entrant meets every other exactly once, in balanced rounds, so a cap
 *  that truncates the schedule still leaves the comparison counts within one of each other. */
function roundRobin(ctx: Ctx): void {
  const BYE = " bye";
  const wheel = [...ctx.ids];
  if (wheel.length % 2 === 1) wheel.push(BYE);
  const size = wheel.length;
  for (let round = 0; round < size - 1; round++) {
    for (let i = 0; i < size / 2; i++) {
      const x = wheel[i]!;
      const y = wheel[size - 1 - i]!;
      if (x === BYE || y === BYE) continue;
      if (ctx.pairs.length >= ctx.cap) return;
      if (ctx.played.has(key(x, y))) continue;
      add(ctx, x, y);
    }
    wheel.splice(1, 0, wheel.pop()!);
  }
}

/** Swiss: each pass matches the entrants that still need comparisons against each other, by
 *  strength proximity, never repeating a pair. Matching the under-compared to each other is
 *  what makes the cap sufficient - one pair then serves two entrants - so an entrant that
 *  already has the minimum is only seated when a short entrant has no short partner left.
 *  With `pairCap >= ceil(n * minComparisons / 2)` every entrant reaches the minimum. */
function swiss(ctx: Ctx): void {
  while (ctx.pairs.length < ctx.cap) {
    const shortlist = seatingOrder(ctx.ids.filter((id) => ctx.counts.get(id)! < ctx.min), ctx);
    if (shortlist.length === 0) return;
    const matched = maximumMatching(ctx, shortlist);
    for (const [x, y] of matched) {
      if (ctx.pairs.length >= ctx.cap) return;
      add(ctx, x, y);
    }
    const paired = new Set(matched.flat());
    const leftover = shortlist.filter((id) => !paired.has(id));
    // A leftover waits for the next pass, where it is seated first - unless no pass can ever
    // pair it with another short entrant, in which case it has to spend a pair on a partner
    // that does not need one.
    if (matched.length > 0 && leftover.length > 0 && leftover.some((id) => hasShortPartner(ctx, id, shortlist))) {
      continue;
    }
    let added = matched.length;
    for (const id of leftover) {
      if (ctx.pairs.length >= ctx.cap) return;
      const partner = bestPartner(ctx, id, ctx.ids.filter((q) => q !== id && !ctx.played.has(key(id, q))));
      if (!partner) continue;
      add(ctx, id, partner);
      added++;
    }
    if (added === 0) return;
  }
}

function hasShortPartner(ctx: Ctx, id: string, shortlist: readonly string[]): boolean {
  return shortlist.some((q) => q !== id && !ctx.played.has(key(id, q)));
}

function seatingOrder(ids: readonly string[], ctx: Ctx): string[] {
  return [...ids].sort(
    (x, y) =>
      ctx.counts.get(x)! - ctx.counts.get(y)! ||
      strength(ctx, y) - strength(ctx, x) ||
      (x < y ? -1 : x > y ? 1 : 0),
  );
}

function strength(ctx: Ctx, id: string): number {
  return ctx.strengths[id] ?? 0;
}

/** Partner preference: never pit two anchors against each other when a mixed pair is available
 *  (anchors carry the previous rounds' scale and are there to anchor the new ideas), then
 *  nearest strength, then id. */
function preference(ctx: Ctx, p: string): (x: string, y: string) => number {
  const anchorPair = (id: string): number => (ctx.anchors.has(p) && ctx.anchors.has(id) ? 1 : 0);
  const near = (id: string): number => Math.abs(strength(ctx, p) - strength(ctx, id));
  return (x, y) => anchorPair(x) - anchorPair(y) || near(x) - near(y) || (x < y ? -1 : x > y ? 1 : 0);
}

function bestPartner(ctx: Ctx, p: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const needs = (id: string): number => (ctx.counts.get(id)! < ctx.min ? 0 : 1);
  const prefer = preference(ctx, p);
  return [...candidates].sort(
    (x, y) => needs(x) - needs(y) || ctx.counts.get(x)! - ctx.counts.get(y)! || prefer(x, y),
  )[0]!;
}

/** Greedy-first depth-first search for the largest set of disjoint legal pairs over `pool`.
 *  The first descent is the plain Swiss greedy; backtracking only happens when repeats block
 *  it, which is exactly the case where the greedy would strand an entrant below the minimum. */
function maximumMatching(ctx: Ctx, pool: readonly string[]): [string, string][] {
  const target = Math.floor(pool.length / 2);
  let best: [string, string][] = [];
  let budget = SEARCH_BUDGET;
  const acc: [string, string][] = [];
  const search = (remaining: readonly string[]): void => {
    if (best.length >= target || budget <= 0) return;
    budget--;
    if (acc.length > best.length) best = [...acc];
    if (remaining.length < 2) return;
    const p = remaining[0]!;
    const rest = remaining.slice(1);
    const candidates = rest.filter((q) => !ctx.played.has(key(p, q))).sort(preference(ctx, p));
    for (const q of candidates) {
      acc.push([p, q]);
      search(rest.filter((x) => x !== q));
      acc.pop();
      if (best.length >= target || budget <= 0) return;
    }
    // Leaving p unmatched is the last resort: it costs this pass a pair.
    search(rest);
  };
  search(pool);
  return best;
}
