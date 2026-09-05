import type { Dossier } from "./dossier";

/**
 * The cheap half of novelty rejection (record §5): trigram Jaccard over an idea's title plus
 * mechanism. Above `ideation.jaccardThreshold` the candidate is a *restatement candidate* — not a
 * verdict — and the caller escalates the single best match to one arbiter tie-break. Everything
 * here is pure and deterministic, so the similarity distribution recorded per run is reproducible
 * from the archive alone.
 */

/** Lowercase, fold every non-alphanumeric run to one space, trim. Punctuation and line wrapping are
 *  formatting, not content, and must not move the score. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The set of character 3-grams of `text` after normalization. Fewer than three characters yields
 *  no grams, which makes an empty or near-empty field score 0 against everything. */
export function trigrams(text: string): Set<string> {
  const s = normalize(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  // Two empty sets are *not* identical for this purpose: a dossier with no title and no mechanism
  // has nothing to restate, and scoring it 1 would reject every later idea against it.
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Trigram Jaccard similarity of two texts, in [0, 1]. Symmetric; 1 only for identical content. */
export function trigramJaccard(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/** What novelty compares: the title and the mechanism, the two fields that say what the idea *is*. */
function noveltyKey(d: Pick<Dossier, "title" | "mechanism">): string {
  return `${d.title} ${d.mechanism}`;
}

/**
 * The archive entry closest to `candidate`, or `undefined` when the archive holds nothing to
 * compare against. The candidate never matches itself (re-checking a stored idea is not a
 * collision with itself), and ties go to the earlier archive entry, so repeated runs over the same
 * archive escalate the same match to the arbiter.
 */
export function bestMatch(candidate: Dossier, archive: Dossier[]): { id: string; similarity: number } | undefined {
  const key = trigrams(noveltyKey(candidate));
  let best: { id: string; similarity: number } | undefined;
  for (const other of archive) {
    if (other.id === candidate.id) continue;
    const similarity = jaccard(key, trigrams(noveltyKey(other)));
    if (best === undefined || similarity > best.similarity) best = { id: other.id, similarity };
  }
  return best;
}
