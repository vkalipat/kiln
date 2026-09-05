export interface Predicate {
  type: "substring" | "regex";
  value: string;
}

export function predicateMatches(predicate: Predicate, text: string): boolean {
  return predicate.type === "substring" ? text.includes(predicate.value) : new RegExp(predicate.value).test(text);
}
