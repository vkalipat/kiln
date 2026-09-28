import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";

export const WORKFLOW_PHASES = ["frame", "discover", "ideate", "checkpoint", "form", "build", "reflect"] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];
export type WorkflowIntent = "open_ended_ideation" | "supplied_concept" | "existing_artifact";
export type WorkflowGoal = "explore" | "deliver";
export interface WorkflowStrategy {
  mode: "exploratory" | "focused" | "direct";
  research: "broad" | "targeted" | "none";
}

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
  /** Absent on historical/evaluator plans, which retain their original full phase chain. */
  strategy?: WorkflowStrategy;
  /** New adaptive direct/no-research runs may frame deterministically; old frozen plans omit it. */
  directFrame?: "deterministic-v1";
}

export interface WorkflowControls {
  through?: WorkflowPhase;
  autonomous?: boolean;
  interactive?: boolean;
}

export interface WorkflowExecution {
  through: WorkflowPhase;
  throughSource: "explicit" | "intent" | "default";
  checkpointPolicy: "human" | "autonomous";
  phases: WorkflowPhase[];
}

const OPEN_ENDED = [
  /\b(?:find|discover|generate|suggest|brainstorm|identify|explore|give|come up with|develop|create|propose|design)\b[^.!?\n]{0,100}\bideas?\b/i,
  // Quantified plural alternatives allow short descriptive modifiers, without treating
  // arbitrary quantified objects (bugs, files) or a single implementation path as ideation.
  /\b(?:find|discover|generate|suggest|brainstorm|identify|explore|give|propose)\s+(?:me\s+)?(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|some|many|a few)\s+(?:[\w-]+,?\s+){0,6}(?:ways|approaches|ideas)\b/i,
  /\b(?:find|discover|identify|explore)\s+(?:me\s+)?(?:a|the|some)\s+(?:way|opportunity|business|startup|product)\b/i,
  /\bwhat\s+(?:business|company|product|project|thing)?\s*should\s+i\s+(?:build|start|pursue|make)\b/i,
  /\bmake\s+me\s+(?:a\s+)?(?:billionaire|millionaire)\b/i,
];

const EXISTING_ARTIFACT = [
  /\b(?:this|the|my)\s+(?:existing\s+)?(?:repo(?:sitory)?|codebase|project|app(?:lication)?|artifact)\b/i,
  /\ban?\s+existing\s+(?:repo(?:sitory)?|codebase|project|app(?:lication)?|artifact)\b/i,
  /\bcontinue\s+(?:working\s+on|building|developing|from)\b/i,
  /\b(?:fix|update|extend|refactor)\s+(?:this|the|my)\b/i,
];

const DELIVERY = /\b(?:ship|implement|prototype|launch|deliver|build|develop|create|write|make|fix|finish|complete)\b/i;
const OPEN_DELIVERY = /\b(?:ship|implement|prototype|launch|deliver|build|develop|fix|finish|complete)\b/i;

function seedHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function matchesAny(seed: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(seed));
}

export function classifyWorkflowIntent(seed: string): WorkflowIntent {
  // A creation request may name an output location without supplying an existing artifact.
  // Mask only that location in output/execution instructions; keep explicit repository references
  // and source-reading clauses authoritative, and never rewrite the persisted seed or plan.
  const artifactText = /^\s*(?:please\s+)?(?:create|build|write|make|implement)\b/i.test(seed)
    ? seed.replace(/\b(?:put|place|save|create|build|write|make|implement)\b[^.!?\n]{0,160}\b(?:at|in|under|into)\s+the\s+project\s+(?:root|directory|folder)\b/gi,
      (instruction) => /\b(?:from|read|inspect|review|existing)\b/i.test(instruction)
        ? instruction : instruction.replace(/\bthe\s+project\s+(?:root|directory|folder)\b/gi, "the output location"))
      .replace(/\b(?:run|execute|invoke|passing\s+with)\b[^.!?\n]{0,160}\b(?:from|in|at)\s+the\s+project\s+(?:root|directory|folder)\b/gi,
        (instruction) => /\b(?:read|reading|inspect|review|existing)\b/i.test(instruction)
          ? instruction : instruction.replace(/\bthe\s+project\s+(?:root|directory|folder)\b/gi, "the execution location"))
    : seed;
  if (matchesAny(artifactText, EXISTING_ARTIFACT)) return "existing_artifact";
  if (matchesAny(seed, OPEN_ENDED)) return "open_ended_ideation";
  return "supplied_concept";
}

export function planWorkflow(seed: string, options: { adaptive?: boolean } = {}): WorkflowPlan {
  const intent = classifyWorkflowIntent(seed);
  // Negated/deferred delivery and output requests for a plan are not authorization to build.
  const noDelivery = /\b(?:do not|don['’]t|without|not yet|never)\s+(?:\w+\s+){0,2}(?:build|implement|ship|deploy|launch|write|make)\b|\b(?:plan|ideas?|research|analysis|recommendations?|report)\s+only\b|\b(?:plan|design|explain)\s+(?:how|for|to)\b/i.test(seed);
  const deliveryText = seed.replace(/\b(?:develop|create|design|build|write|make)\b[^.!?\n]{0,80}\b(?:ideas?|concepts?|hypotheses|plans?|proposals?)\b/gi, "");
  const goal: WorkflowGoal = !noDelivery && (intent === "open_ended_ideation" ? OPEN_DELIVERY : DELIVERY).test(deliveryText) ? "deliver" : "explore";
  const missingArtifact = intent === "existing_artifact";
  const rationale: string[] = [];
  if (intent === "open_ended_ideation") {
    rationale.push("The seed asks Kiln to search across ideas; translate aspirational outcomes into a checkable proxy and state bounded assumptions.");
  } else if (intent === "supplied_concept") {
    rationale.push("The seed supplies a concept; preserve it and use research to test assumptions, risks, and implementation choices.");
  } else {
    rationale.push("The seed refers to an existing artifact but no readable source was supplied; keep work at bounded planning until the source is available.");
  }
  rationale.push(goal === "deliver" && !missingArtifact
    ? "The seed asks for delivery, so the default route reaches verified build and reflection without bypassing the checkpoint or acceptance freeze."
    : missingArtifact
      ? "Artifact delivery cannot start without an explicit readable source, so the default route stops at a human checkpoint."
      : "The seed asks for exploration, so the default route ends at the idea checkpoint.");

  // Test-runner subcommands describe verification, not a request for idea discovery.
  const strategyText = seed.replace(/\bunittest\s+discover\b/gi, "test discovery")
    // Explicitly declined search is not a request to run it; keep positive requests elsewhere.
    .replace(/\b(?:no|without|skip|do not|don['’]t)\s+(?:any\s+)?(?:ideation|ideate|brainstorm(?:ing)?|alternatives?)(?:\s*(?:,|or|and)\s*(?:ideation|ideate|brainstorm(?:ing)?|alternatives?))*/gi, "");
  const directTask = intent === "supplied_concept" && goal === "deliver"
    && /\b(cli|script|utility|function|parser|converter|calculator|command.line|unit tests?|csv|json|markdown|directory|files?)\b/i.test(seed)
    && !/\b(ideas?|ideation|ideate|brainstorm(?:ing)?|alternatives?|explore|discover|novel)\b/i.test(strategyText);
  const researchText = seed.replace(/\b(?:no|without|do not|don['’]t)\s+(?:external\s+|web\s+|online\s+)?research\b/gi, "");
  const researchDeclined = /\b(?:no|without|do not|don['’]t)\s+(?:external\s+|web\s+|online\s+)?(?:research|browsing|web search)\b/i.test(seed);
  const needsExternalFacts = !researchDeclined && /\b(research|market|customers?|biology|medicine|medical|clinical|protein|scientific|api|integration|online|web service|pricing)\b|\b(?:latest|current)\s+(?:papers?|prices?|versions?|releases?|news|guidelines|regulations|trends)\b/i.test(researchText);
  const strategy: WorkflowStrategy = directTask
    ? { mode: "direct", research: needsExternalFacts ? "targeted" : "none" }
    : { mode: intent === "open_ended_ideation" ? "exploratory" : "focused", research: intent === "open_ended_ideation" ? "broad" : "targeted" };
  if (options.adaptive !== false) rationale.push(strategy.mode === "direct"
    ? `The user supplied a concrete implementation task; competitive ideation is unnecessary. Research is ${strategy.research}; formation and external acceptance checks still apply.`
    : `${strategy.mode === "exploratory" ? "Broad idea search" : "Focused refinement"} needs evidence collection and comparison before selection.`);

  return {
    version: 1,
    intent,
    goal,
    defaultThrough: goal === "deliver" && !missingArtifact ? "reflect" : "checkpoint",
    assumptionPolicy: intent === "open_ended_ideation" ? "bounded" : intent === "supplied_concept" ? "preserve" : "inspect_existing",
    researchPolicy: intent === "open_ended_ideation" ? "landscape" : intent === "supplied_concept" ? "targeted" : "repository_first",
    checkpointDefault: !missingArtifact && goal === "deliver" ? "autonomous" : "human",
    artifactContext: intent !== "existing_artifact" ? "not_applicable" : "not_supplied",
    seedSha256: seedHash(seed),
    rationale,
    ...(options.adaptive !== false ? { strategy } : {}),
    ...(options.adaptive !== false && strategy.mode === "direct" && strategy.research === "none"
      ? { directFrame: "deterministic-v1" as const } : {}),
  };
}

export function compileWorkflow(plan: WorkflowPlan, controls: WorkflowControls): WorkflowExecution {
  const through = controls.through ?? plan.defaultThrough;
  const throughSource = controls.through ? "explicit" : plan.goal === "deliver" ? "intent" : "default";
  return {
    through,
    throughSource,
    checkpointPolicy: controls.interactive === true
      ? "human"
      : controls.autonomous === undefined
      ? plan.checkpointDefault
      : controls.autonomous ? "autonomous" : "human",
    phases: WORKFLOW_PHASES.slice(0, WORKFLOW_PHASES.indexOf(through) + 1).filter((phase) => {
      if (plan.strategy?.mode !== "direct") return true;
      if (phase === "discover") return plan.strategy.research !== "none";
      return phase !== "ideate" && phase !== "checkpoint";
    }),
  };
}

/** A brief explanation of task intent, not a promise of completion or extra authority. */
export function workflowInterpretation(plan: WorkflowPlan): string {
  if (plan.intent === "existing_artifact") return plan.artifactContext === "declared"
    ? "I understand this as work on an existing artifact, starting with its supplied context."
    : "I understand this as work on an existing artifact; I need its readable source before making artifact-specific changes.";
  if (plan.intent === "open_ended_ideation") return plan.goal === "deliver"
    ? "I understand this as finding a promising idea and carrying it through implementation and verification."
    : "I understand this as exploring and comparing ideas to give you an evidence-backed choice.";
  return plan.goal === "deliver"
    ? "I understand this as implementing your supplied concept and checking it against its requirements."
    : "I understand this as developing your supplied concept and evaluating its assumptions and risks.";
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
  if (plan.strategy !== undefined && (!plan.strategy || !["exploratory", "focused", "direct"].includes(plan.strategy.mode)
    || !["broad", "targeted", "none"].includes(plan.strategy.research)
    || (plan.strategy.mode !== "direct" && plan.strategy.research === "none"))) throw new Error("workflow plan has invalid strategy");
  if (plan.directFrame !== undefined && (plan.directFrame !== "deterministic-v1"
    || plan.intent !== "supplied_concept" || plan.strategy?.mode !== "direct" || plan.strategy.research !== "none")) throw new Error("workflow plan has invalid directFrame");
  return plan as WorkflowPlan;
}

export function loadWorkflowPlan(run: RunPaths): WorkflowPlan | undefined {
  const path = workflowPath(run);
  if (!existsSync(path)) return undefined;
  return validateWorkflowPlan(JSON.parse(readFileSync(path, "utf8")));
}

/** Create the run's plan once; later invocations reuse it and reject seed drift. */
export function ensureWorkflowPlan(run: RunPaths, options: { adaptive?: boolean } = {}): WorkflowPlan {
  const seed = readFileSync(run.seed, "utf8");
  const current = loadWorkflowPlan(run);
  if (current) {
    if (current.seedSha256 !== seedHash(seed)) throw new Error("workflow plan does not match the run seed");
    return current;
  }
  const plan = planWorkflow(seed, options);
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
