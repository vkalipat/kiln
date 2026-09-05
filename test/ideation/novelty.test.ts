import { describe, expect, test } from "bun:test";
import { bestMatch, trigramJaccard, trigrams } from "../../src/ideation/novelty";
import type { Dossier } from "../../src/ideation/dossier";

function d(id: string, title: string, mechanism: string): Dossier {
  return { id, title, mechanism, draws: "", axisValues: {}, testableClaim: "", cheapestTest: "", failureReason: "", parents: [] };
}

const JOURNAL = d(
  "r1-i1-1",
  "Journal-first agent harness",
  "Every tool call and model call is appended to a jsonl run journal so a crashed run resumes from the file",
);
/** Same mechanism, same user, reworded: the case the 0.45 threshold exists to catch. */
const JOURNAL_RESTATED = d(
  "r2-i1-1",
  "Journal-first harness for agents",
  "Each tool call and each model call is appended to a jsonl run journal, so a crashed run resumes from that file",
);
const FRIDGE = d(
  "r2-i2-1",
  "Shared-house fridge inventory",
  "A barcode scanner logs what enters and leaves the fridge and warns a household before food spoils",
);

describe("trigrams", () => {
  test("are the character 3-grams of the normalized text", () => {
    expect([...trigrams("abcd")]).toEqual(["abc", "bcd"]);
  });

  test("normalization lowercases, folds punctuation and collapses whitespace", () => {
    expect(trigrams("Ab-Cd")).toEqual(trigrams("ab cd"));
    expect(trigrams("ab   cd\n")).toEqual(trigrams("ab cd"));
    expect(trigrams("A B")).toEqual(trigrams("a b"));
  });

  test("text shorter than three characters has no trigrams", () => {
    expect(trigrams("ab").size).toBe(0);
    expect(trigrams("").size).toBe(0);
  });

  test("repeats collapse into a set", () => {
    expect(trigrams("aaaa")).toEqual(new Set(["aaa"]));
  });
});

describe("trigramJaccard", () => {
  test("identical text scores 1 and is case insensitive", () => {
    expect(trigramJaccard("a jsonl run journal", "a jsonl run journal")).toBe(1);
    expect(trigramJaccard("A JSONL Run Journal", "a jsonl run journal")).toBe(1);
  });

  test("a restatement scores above the 0.45 default threshold", () => {
    const a = `${JOURNAL.title} ${JOURNAL.mechanism}`;
    const b = `${JOURNAL_RESTATED.title} ${JOURNAL_RESTATED.mechanism}`;
    expect(trigramJaccard(a, b)).toBeGreaterThan(0.45);
  });

  test("a distinct idea scores far below it", () => {
    const a = `${JOURNAL.title} ${JOURNAL.mechanism}`;
    const c = `${FRIDGE.title} ${FRIDGE.mechanism}`;
    expect(trigramJaccard(a, c)).toBeLessThan(0.2);
  });

  test("is symmetric and bounded in [0, 1]", () => {
    const a = `${JOURNAL.title} ${JOURNAL.mechanism}`;
    const b = `${JOURNAL_RESTATED.title} ${JOURNAL_RESTATED.mechanism}`;
    const s = trigramJaccard(a, b);
    expect(trigramJaccard(b, a)).toBe(s);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  test("empty text scores 0 rather than 1, so a blank dossier is never a restatement", () => {
    expect(trigramJaccard("", "")).toBe(0);
    expect(trigramJaccard("", "a jsonl run journal")).toBe(0);
  });
});

describe("bestMatch", () => {
  test("returns the single closest archive entry with its similarity", () => {
    const m = bestMatch(JOURNAL_RESTATED, [FRIDGE, JOURNAL]);
    expect(m?.id).toBe("r1-i1-1");
    expect(m?.similarity).toBeGreaterThan(0.45);
  });

  test("is deterministic on a tie: the first archive entry in order wins", () => {
    const twin = d("z-later", JOURNAL.title, JOURNAL.mechanism);
    const first = d("a-earlier", JOURNAL.title, JOURNAL.mechanism);
    expect(bestMatch(JOURNAL_RESTATED, [first, twin])?.id).toBe("a-earlier");
    expect(bestMatch(JOURNAL_RESTATED, [twin, first])?.id).toBe("z-later");
  });

  test("compares title plus mechanism, not the title alone", () => {
    const sameTitle = d("same-title", JOURNAL.title, FRIDGE.mechanism);
    const sameMechanism = d("same-mech", FRIDGE.title, JOURNAL.mechanism);
    const m = bestMatch(JOURNAL, [sameTitle, sameMechanism]);
    // The mechanism is the longer, more distinctive half of the key.
    expect(m?.id).toBe("same-mech");
  });

  test("an empty archive has no match", () => {
    expect(bestMatch(JOURNAL, [])).toBeUndefined();
  });

  test("an idea is never its own best match", () => {
    expect(bestMatch(JOURNAL, [JOURNAL])).toBeUndefined();
    expect(bestMatch(JOURNAL, [JOURNAL, FRIDGE])?.id).toBe("r2-i2-1");
  });
});
