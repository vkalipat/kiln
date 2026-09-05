import { describe, expect, test } from "bun:test";
import { predicateMatches as corePredicateMatches } from "../../src/core/predicate";
import { predicateMatches as probePredicateMatches, type Predicate } from "../../src/ideation/probe";

describe("predicateMatches", () => {
  const cases: Array<{ predicate: Predicate; text: string; matches: boolean }> = [
    { predicate: { type: "substring", value: "ready" }, text: "system ready", matches: true },
    { predicate: { type: "substring", value: "ready" }, text: "not yet", matches: false },
    { predicate: { type: "regex", value: "f\\d{2}" }, text: "passed f03", matches: true },
    { predicate: { type: "regex", value: "^ok$" }, text: "not ok", matches: false },
  ];

  for (const item of cases) {
    test(`${item.predicate.type} ${item.matches ? "matches" : "does not match"}`, () => {
      expect(corePredicateMatches(item.predicate, item.text)).toBe(item.matches);
      expect(probePredicateMatches(item.predicate, item.text)).toBe(item.matches);
    });
  }
});
