import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../core/paths";
import { readStatus, writeStatus } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
import { validateDossier, type Dossier, type Evidence } from "../ideation/dossier";
import { validateBrief } from "../phases/contracts";
import { parseBrief, type PhaseDeps } from "../phases/frame";
import { assertShapeFrozen } from "../phases/guards";

const compact = (value: string, cap: number) => value.replace(/\s+/g, " ").trim().slice(0, cap);
const ID = "supplied-task";

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
