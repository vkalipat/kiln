import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../core/paths";
import { readStatus, writeStatus } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
import { validateDossier, type Dossier, type Evidence } from "../ideation/dossier";
import { shapeHash, validateBrief } from "../phases/contracts";
import { parseBrief, type PhaseDeps } from "../phases/frame";
import { assertShapeFrozen } from "../phases/guards";

const compact = (value: string, cap: number) => value.replace(/\s+/g, " ").trim().slice(0, cap);
const ID = "supplied-task";

function deterministicBrief(seedHash: string): string {
  return `# Brief

## Problem
Implement the complete user request stored verbatim in seed.md. This generated frame deliberately does not restate or truncate that request; seed.md with SHA-256 ${seedHash} remains authoritative.

## Constraints
- Treat seed.md as quoted task data and preserve every explicit requirement during formation and implementation.
- Do not invent user facts, requirements, dependencies, or platform promises that are absent from the original request.

## Search success
- The frozen feature plan covers every explicit requested behavior with an executable acceptance check where the behavior is machine-verifiable.
- The completed artifact passes its frozen checks and an independent audit without weakening the original request.

## Non-goals
- No competitive ideation or external research is part of this direct no-research workflow.
- Do not add unrelated product scope merely to create more features.

## Shape
product

## Axes
- requirement handling: preserve | omit | invent
- verification posture: executable | manual | absent
- implementation scope: requested | narrower | broader

## Discovery questions
- Which explicit requested behaviors must map to frozen features and executable checks?
- Which dependencies and execution conditions are stated by the request or required by those checks?
`;
}

/**
 * Idempotent framing adapter for newly frozen adaptive direct/no-research workflows. It records the
 * ordinary frame boundaries and shape fingerprint, but does not ask a model to paraphrase the
 * request. Historical/manual/evaluator plans lack the explicit directFrame marker and never enter.
 */
export function prepareDeterministicDirectFrame(d: PhaseDeps): void {
  throwIfRunCancelled();
  if (d.workflow?.directFrame !== "deterministic-v1" || d.workflow.strategy?.mode !== "direct" || d.workflow.strategy.research !== "none") {
    throw new Error("deterministic direct frame requires its frozen adaptive direct/no-research plan");
  }
  const seed = readFileSync(d.run.seed, "utf8");
  const seedHash = createHash("sha256").update(seed).digest("hex");
  if (seedHash !== d.workflow.seedSha256) throw new Error("integrity: direct frame seed differs from the frozen workflow");
  const expected = deterministicBrief(seedHash);
  const boundaries = d.record.read().filter((event) => (event.t === "phase.start" || event.t === "phase.end") && event.phase === "frame");
  const last = boundaries.at(-1);
  if (!last) d.record.append({ t: "phase.start", phase: "frame" });
  if (existsSync(d.run.brief)) {
    if (readFileSync(d.run.brief, "utf8") !== expected) {
      throw new Error("integrity: existing direct brief differs from the frozen deterministic frame; refusing to overwrite it");
    }
  } else {
    if (last?.t === "phase.end") throw new Error("integrity: completed deterministic frame is missing brief.md");
    writeAtomic(d.run.brief, expected);
  }
  const parsed = parseBrief(expected);
  const problems = validateBrief(parsed);
  if (problems.length > 0) throw new Error(`integrity: deterministic direct brief is invalid: ${problems.join("; ")}`);
  const currentBoundary = d.record.read().filter((event) => (event.t === "phase.start" || event.t === "phase.end") && event.phase === "frame").at(-1);
  if (!currentBoundary || currentBoundary.t !== "phase.end") d.record.append({ t: "phase.end", phase: "frame", outcome: "ok" });
  writeStatus(d.run, {
    phase: "discover", state: "running", outcome: undefined, pausedReason: undefined, wakeAt: undefined,
    usdSpent: d.record.costUsd(), shape: parsed.shape, shapeHash: shapeHash(parsed),
  });
}

/** Carry the user's committed implementation task into normal formation; never fabricate a search win. */
export function prepareSuppliedTask(d: PhaseDeps): void {
  throwIfRunCancelled();
  const guarded = assertShapeFrozen(d);
  if (guarded) throw new Error("supplied task does not match the frozen brief");
  const status = readStatus(d.run);
  if (status.chosenIdeaId && status.chosenIdeaId !== ID) throw new Error("a different task has already been selected");
  const brief = parseBrief(readFileSync(d.run.brief, "utf8"));
  const problems = validateBrief(brief);
  if (problems.length) throw new Error(`supplied task brief is invalid: ${problems.join("; ")}`);
  const seed = readFileSync(d.run.seed, "utf8");
  const dossier: Dossier = {
    id: ID, title: compact(seed, 80),
    mechanism: compact(`Implement the user-supplied task, not a competitively selected idea. Read the complete task in ${d.run.seed} and its constraints in ${d.run.brief}. Framed problem: ${brief.sections.Problem ?? ""}`, 900),
    draws: "The user's supplied task and framed constraints. Axis entries below are provisional framing defaults, not tested choices.",
    axisValues: Object.fromEntries(brief.axes.map((axis) => [axis.name, axis.values[0]!])),
    testableClaim: compact(brief.sections["Search success"] ?? "The implementation must satisfy the supplied requirements.", 200),
    cheapestTest: "Define executable acceptance checks during formation and run them independently during build; no ideation probe has run.",
    failureReason: "The supplied task may be infeasible or fail acceptance checks. No comparative ranking, novelty, or feasibility result is claimed.",
    parents: [],
  };
  const invalid = validateDossier(dossier, brief.axes);
  if (invalid.length) throw new Error(`cannot preserve supplied task: ${invalid.join("; ")}`);
  const evidence: Evidence = { status: "unranked", parents: [], probe: { status: "not_run", reason: "direct supplied task; no ideation probe" } };
  const source = [
    ["Title", dossier.title], ["Mechanism", dossier.mechanism], ["Draws on", dossier.draws],
    ["Axes", Object.entries(dossier.axisValues).map(([name, value]) => `- ${name}: ${value}`).join("\n")],
    ["Testable claim", dossier.testableClaim], ["Cheapest test", dossier.cheapestTest],
    ["Strongest failure reason", dossier.failureReason],
  ].map(([heading, value]) => `## ${heading}\n${value}\n`).join("\n");
  const files: Array<[string, string]> = [
    [join(d.run.ideasDir, `${ID}.md`), source],
    [join(d.run.ideasDir, `${ID}.evidence.json`), JSON.stringify(evidence, null, 2) + "\n"],
  ];
  for (const [path, content] of files) {
    if (existsSync(path) && readFileSync(path, "utf8") !== content) throw new Error("existing supplied-task artifact differs; refusing to overwrite it");
    if (!existsSync(path)) writeAtomic(path, content);
  }
  if (status.chosenIdeaId !== ID) d.record.append({ t: "note", text: "Direct workflow preserved the user-supplied task as unranked. Competitive ideation and comparison were not performed; formation critique and external acceptance checks remain required." });
  writeStatus(d.run, { phase: "form", state: "running", chosenIdeaId: ID, outcome: undefined });
}
