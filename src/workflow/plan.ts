import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";

export const WORKFLOW_PHASES = ["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];
export type WorkflowIntent = "open_ended_ideation" | "supplied_concept" | "existing_artifact";
export type WorkflowGoal = "explore" | "deliver";

export interface WorkflowPlan {
  version: 1;
  intent: WorkflowIntent;
  goal: WorkflowGoal;
  /** Default only. A later explicit --through remains an invocation control. */
  defaultThrough: WorkflowPhase;
  assumptionPolicy: "bounded" | "preserve" | "inspect_existing";
  researchPolicy: "landscape" | "targeted" | "repository_first";
  checkpointDefault: "human" | "autonomous";
  /** Whether readable artifact context was deliberately supplied, never inferred from --out. */
  artifactContext: "not_applicable" | "not_supplied" | "declared";
  seedSha256: string;
  rationale: string[];
}

export interface WorkflowControls {
  through?: WorkflowPhase;
  autonomous?: boolean;
}

export interface WorkflowExecution {
  through: WorkflowPhase;
  throughSource: "explicit" | "intent" | "default";
  checkpointPolicy: "human" | "autonomous";
  phases: WorkflowPhase[];
}

export interface PlanWorkflowOptions {
  autonomous?: boolean;
  /** Reserved for an explicit future artifact adapter; --out is a destination and must not set it. */
  artifactAvailable?: boolean;
}

const OPEN_ENDED = [
  /\b(?:find|discover|generate|suggest|brainstorm|identify|explore|come up with)\b[^.!?\n]{0,100}\bideas?\b/i,
  /\bideas?\s+(?:for|that|to)\b/i,
  /\bwhat\s+(?:business|company|product|project|thing)?\s*should\s+i\s+(?:build|start|pursue|make)\b/i,
  /\bmake\s+me\s+(?:a\s+)?(?:billionaire|millionaire)\b/i,
];

const EXISTING_ARTIFACT = [
  /\b(?:this|the|my)\s+(?:existing\s+)?(?:repo(?:sitory)?|codebase|project|app(?:lication)?|artifact)\b/i,
  /\ban?\s+existing\s+(?:repo(?:sitory)?|codebase|project|app(?:lication)?|artifact)\b/i,
  /\bcontinue\s+(?:working\s+on|building|developing|from)\b/i,
  /\b(?:fix|update|extend|refactor)\s+(?:this|the|my)\b/i,
];

const DELIVERY = /\b(?:ship|implement|prototype|launch|deliver|build|develop|create|fix|finish|complete)\b/i;

function seedHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function matchesAny(seed: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(seed));
}

export function classifyWorkflowIntent(seed: string, opts: Pick<PlanWorkflowOptions, "artifactAvailable"> = {}): WorkflowIntent {
  if (matchesAny(seed, EXISTING_ARTIFACT) || (opts.artifactAvailable === true && DELIVERY.test(seed))) return "existing_artifact";
  if (matchesAny(seed, OPEN_ENDED)) return "open_ended_ideation";
  return "supplied_concept";
}

export function planWorkflow(seed: string, opts: PlanWorkflowOptions = {}): WorkflowPlan {
  const intent = classifyWorkflowIntent(seed, opts);
  const goal: WorkflowGoal = DELIVERY.test(seed) ? "deliver" : "explore";
  const rationale: string[] = [];
  if (intent === "open_ended_ideation") {
    rationale.push("The seed asks Kiln to search across ideas; translate aspirational outcomes into a checkable proxy and state bounded assumptions.");
  } else if (intent === "supplied_concept") {
    rationale.push("The seed supplies a concept; preserve it and use research to test assumptions, risks, and implementation choices.");
  } else {
    rationale.push(opts.artifactAvailable
      ? "The seed targets an existing artifact and explicit readable context was declared; inspect that evidence before proposing changes."
      : "The seed refers to an existing artifact but no readable source was supplied; keep work at bounded planning until the source is available.");
  }
  rationale.push(goal === "deliver"
    ? "The seed asks for delivery, so the default route reaches verified build and reflection without bypassing the checkpoint or acceptance freeze."
    : "The seed asks for exploration, so the default route ends at the idea checkpoint.");

  return {
    version: 1,
    intent,
    goal,
    defaultThrough: goal === "deliver" ? "reflect" : "checkpoint",
    assumptionPolicy: intent === "open_ended_ideation" ? "bounded" : intent === "supplied_concept" ? "preserve" : "inspect_existing",
    researchPolicy: intent === "open_ended_ideation" ? "landscape" : intent === "supplied_concept" ? "targeted" : "repository_first",
    checkpointDefault: opts.autonomous === true ? "autonomous" : "human",
    artifactContext: intent !== "existing_artifact" ? "not_applicable" : opts.artifactAvailable === true ? "declared" : "not_supplied",
    seedSha256: seedHash(seed),
    rationale,
  };
}

export function compileWorkflow(plan: WorkflowPlan, controls: WorkflowControls): WorkflowExecution {
  const through = controls.through ?? plan.defaultThrough;
  const throughSource = controls.through ? "explicit" : plan.goal === "deliver" ? "intent" : "default";
  return {
    through,
    throughSource,
    checkpointPolicy: controls.autonomous === undefined
      ? plan.checkpointDefault
      : controls.autonomous ? "autonomous" : "human",
    phases: WORKFLOW_PHASES.slice(0, WORKFLOW_PHASES.indexOf(through) + 1),
  };
}

export function workflowPath(run: RunPaths): string {
  return join(run.dir, "workflow.json");
}

function validateWorkflowPlan(value: unknown): WorkflowPlan {
  if (!value || typeof value !== "object") throw new Error("workflow plan must be an object");
  const plan = value as Partial<WorkflowPlan>;
  if (plan.version !== 1) throw new Error(`unsupported workflow plan version ${String(plan.version)}`);
  if (!(["open_ended_ideation", "supplied_concept", "existing_artifact"] as unknown[]).includes(plan.intent)) throw new Error("workflow plan has an invalid intent");
  if (!(["explore", "deliver"] as unknown[]).includes(plan.goal)) throw new Error("workflow plan has an invalid goal");
  if (!WORKFLOW_PHASES.includes(plan.defaultThrough as WorkflowPhase)) throw new Error("workflow plan has an invalid defaultThrough");
  if (!(["bounded", "preserve", "inspect_existing"] as unknown[]).includes(plan.assumptionPolicy)) throw new Error("workflow plan has an invalid assumptionPolicy");
  if (!(["landscape", "targeted", "repository_first"] as unknown[]).includes(plan.researchPolicy)) throw new Error("workflow plan has an invalid researchPolicy");
  if (!(["human", "autonomous"] as unknown[]).includes(plan.checkpointDefault)) throw new Error("workflow plan has an invalid checkpointDefault");
  if (!(["not_applicable", "not_supplied", "declared"] as unknown[]).includes(plan.artifactContext)) throw new Error("workflow plan has an invalid artifactContext");
  if (typeof plan.seedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(plan.seedSha256)) throw new Error("workflow plan has an invalid seedSha256");
  if (!Array.isArray(plan.rationale) || plan.rationale.some((line) => typeof line !== "string")) throw new Error("workflow plan has invalid rationale");
  return plan as WorkflowPlan;
}

export function loadWorkflowPlan(run: RunPaths): WorkflowPlan | undefined {
  const path = workflowPath(run);
  if (!existsSync(path)) return undefined;
  return validateWorkflowPlan(JSON.parse(readFileSync(path, "utf8")));
}

/** Create the run's plan once; later invocations reuse it and reject seed drift. */
export function ensureWorkflowPlan(run: RunPaths, opts: PlanWorkflowOptions = {}): WorkflowPlan {
  const seed = readFileSync(run.seed, "utf8");
  const current = loadWorkflowPlan(run);
  if (current) {
    if (current.seedSha256 !== seedHash(seed)) throw new Error("workflow plan does not match the run seed");
    return current;
  }
  const plan = planWorkflow(seed, opts);
  saveWorkflowPlan(run, plan);
  return plan;
}

export function saveWorkflowPlan(run: RunPaths, plan: WorkflowPlan): void {
  const current = loadWorkflowPlan(run);
  if (current) {
    if (JSON.stringify(current) === JSON.stringify(plan)) return;
    throw new Error("workflow plan is already frozen and differs from the requested plan");
  }
  writeAtomic(workflowPath(run), `${JSON.stringify(validateWorkflowPlan(plan), null, 2)}\n`);
}

export function workflowGuidance(plan: WorkflowPlan, phase: "frame" | "discover" | "ideate"): string {
  if (plan.intent === "open_ended_ideation") {
    if (phase === "frame") return "Open-ended ideation: replace aspirational outcomes with observable search proxies, make reversible assumptions explicit, and continue unless no bounded search can be defined.";
    if (phase === "discover") return "Open-ended ideation: build a broad but bounded landscape around the chosen proxies; do not search the entire economy or unrelated domains indiscriminately.";
    return "Open-ended ideation: generate a genuinely broad portfolio across the frozen axes before selection; do not collapse early onto one familiar concept.";
  }
  if (plan.intent === "supplied_concept") {
    if (phase === "frame") return "Supplied concept: preserve the user's concept and frame what must be true for it to work; do not silently replace it with a different product or research question.";
    if (phase === "discover") return "Supplied concept: research its dependencies, prior art, risks, and decision points; do not perform broad unrelated market exploration.";
    return "Supplied concept: generate materially different mechanisms, refinements, and falsification paths for this concept, not unrelated replacement concepts.";
  }
  if (plan.artifactContext === "declared") {
    return phase === "frame"
      ? "Existing artifact: inspect supplied repository evidence before framing a delta; preserve its behavior unless the seed requests a change."
      : phase === "discover"
        ? "Existing artifact: use repository evidence first and external research only for concrete unresolved questions."
        : "Existing artifact: propose bounded interventions grounded in the inspected artifact, not greenfield replacements.";
  }
  return "Existing artifact requested, but no readable source was supplied. Do not claim to inspect or modify it; obtain the source before artifact-specific work, while any interim output remains bounded planning.";
}
