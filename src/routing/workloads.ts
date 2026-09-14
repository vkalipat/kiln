import type { Role } from "../core/config";

export const COMPUTATIONAL_BIOLOGY_ASTRA_MODEL = "openai-codex/gpt-6-astra";
export const COMPUTATIONAL_BIOLOGY_PRODUCING_ROLES = [
  "brain",
  "generator",
  "builder",
  "prober",
  "reflector",
] as const satisfies readonly Role[];

export interface WorkloadPreference {
  policy: "prospective_user_workload_preference_v1";
  workload: "computational_biology_vcc";
  requestedModelRef: typeof COMPUTATIONAL_BIOLOGY_ASTRA_MODEL;
  producingRoles: typeof COMPUTATIONAL_BIOLOGY_PRODUCING_ROLES;
}

const COMPUTATIONAL_BIOLOGY_SIGNALS = [
  /\bvirtual[- ]?(?:biological[- ]?)?cells?\b/i,
  /\bwhole[- ]cell model(?:s|ing)?\b/i,
  /\bperturb[- ]?seq\b/i,
  /\bsinglecell\b/i,
  /\bsingle[- ]cell\b[^.!?\n]{0,80}\b(?:rna|sequenc\w*|transcript\w*|genom\w*|omics|gene|perturb\w*|atlas|biology|assay)\b/i,
  /\b(?:rna|sequenc\w*|transcript\w*|genom\w*|omics|gene|perturb\w*|atlas|biology|assay)\b[^.!?\n]{0,80}\bsingle[- ]cell\b/i,
  /\bbioinformatics?\b/i,
  /\b(?:computational|systems|synthetic) biology\b/i,
  /\b(?:gfp|green fluorescent protein)\b/i,
  /\bprotein[- ]?binding\b/i,
  /\b(?:protein|peptide)[- ]?(?:mini)?binders?\b/i,
  /\b(?:genomics?|transcriptomics?|proteomics?|metabolomics?|gene expression|molecular docking)\b/i,
] as const;

/**
 * Prospective user preference inferred only from high-signal workload terms. This is deliberately
 * separate from benchmark categories: matching it does not manufacture biology benchmark evidence.
 */
export function workloadPreferenceFor(seed: string): WorkloadPreference | undefined {
  if (!COMPUTATIONAL_BIOLOGY_SIGNALS.some((pattern) => pattern.test(seed))) return undefined;
  return {
    policy: "prospective_user_workload_preference_v1",
    workload: "computational_biology_vcc",
    requestedModelRef: COMPUTATIONAL_BIOLOGY_ASTRA_MODEL,
    producingRoles: COMPUTATIONAL_BIOLOGY_PRODUCING_ROLES,
  };
}
