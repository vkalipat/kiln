import { chooseWithJev, type JevDecision, type JevOptions } from "../integrations/jev";
import { OPERATOR_STEP_KINDS, type OperatorStepKind } from "../operator/context";

const CRITERIA: Record<OperatorStepKind, string> = {
  research: "Find and assess sources, inspect existing evidence, or investigate unknown facts.",
  ideate: "Generate and compare possible approaches before choosing an implementation.",
  implement: "Make scoped code or artifact changes and verify their behavior.",
  review: "Independently assess an existing implementation or claim against requirements.",
  synthesize: "Explain, summarize, plan, or combine existing findings into a response.",
};

/** Advisory step classification only. resolveStep remains authoritative for admitted model selection. */
export function classifyOperatorStep(
  summary: string,
  options: JevOptions & { fallback: OperatorStepKind; allowedSteps?: readonly OperatorStepKind[] },
): Promise<JevDecision<OperatorStepKind>> {
  const allowed = options.allowedSteps ?? OPERATOR_STEP_KINDS;
  if (!allowed.length || new Set(allowed).size !== allowed.length || allowed.some((step) => !OPERATOR_STEP_KINDS.includes(step))
    || !allowed.includes(options.fallback)) throw new Error("Jev step choices must be unique known steps including the fallback");
  const criteria = Object.fromEntries(allowed.map((step) => [step, CRITERIA[step]])) as Record<OperatorStepKind, string>;
  return chooseWithJev(summary, criteria, options.fallback, options);
}
