import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../brain/agent";
import { loadPlaybook, loadPrompt, playbookSection } from "../brain/prompts";
import { brainTools, scoutTools, type ExitKind, type ToolContext } from "../brain/tools";
import { classifyFailure, type FailureClass } from "../core/failure";
import { writeStatus } from "../core/run";
import { throwIfRunCancelled } from "../core/run-control";
import { effortFor } from "../providers/models";
import { runScout, type ScoutResult } from "../scouts/scout";
import { LANDSCAPE_SECTIONS, bullets, discoverContract, sections } from "./contracts";
import { parseBrief, stopFailure, type PhaseDeps, type PhaseResult } from "./frame";
import { assertShapeFrozen } from "./guards";
import { runValidatedFile } from "./shared";

export function parseLandscape(md: string) {
  const s = sections(md);
  const missing = LANDSCAPE_SECTIONS.filter((n) => !(n in s));
  return { sections: s, missing, obvious: bullets(s["Obvious list"] ?? ""), atoms: bullets(s["Atoms"] ?? ""), tensions: bullets(s["Tensions"] ?? ""), domains: bullets(s["Distant domains"] ?? "") };
}

const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** How a scout that did not answer is described, to the record and to the brain reading its file.
 *  A spent turn cap reads as a spent budget so `classifyFailure` lands on `budget`, not `verify`. */
function scoutFailure(r: ScoutResult): { class: FailureClass; message: string; category?: string } | undefined {
  if (r.stopped === "refused") {
    const category = r.stopDetails?.category?.trim() || "unknown";
    return { class: "refusal", message: `scout refused: ${category}`, category };
  }
  if (r.stopped !== "error" && r.stopped !== "turn_cap") return undefined;
  const message = r.stopped === "turn_cap" ? "budget exhausted: the scout hit its turn cap before answering" : r.error ?? "scout error";
  return { class: classifyFailure({ message, stopDetails: r.stopDetails }), message };
}

export async function runDiscover(d: PhaseDeps): Promise<PhaseResult> {
  throwIfRunCancelled();
  const turnCap = d.cfg.budgets.turns.discover;
  const finish = (res: PhaseResult): PhaseResult => {
    d.record.append({ t: "phase.end", phase: "discover", outcome: res.outcome });
    if (res.outcome === "ok") writeStatus(d.run, { phase: "ideate" });
    else if (res.outcome === "honest_exit") writeStatus(d.run, { state: "done", outcome: { kind: "honest_exit", exitKind: res.kind, reasons: res.reasons } });
    else if (res.outcome === "failed") writeStatus(d.run, { state: "failed", outcome: { kind: "failure", failureClass: res.failureClass, message: res.message } });
    else writeStatus(d.run, { state: "stopped", outcome: { kind: "stopped", stopKind: res.stopKind, truncatedRound: res.truncatedRound, frontierEmpty: res.frontierEmpty } });
    return res;
  };

  const frozen = assertShapeFrozen(d);
  if (frozen) return frozen;
  const brief = readFileSync(d.run.brief, "utf8");
  const parsedBrief = parseBrief(brief);

  d.record.append({ t: "phase.start", phase: "discover" });
  const { questions } = parsedBrief;
  const scoutModel = d.models("scout").model;
  const scoutCtx: ToolContext = { cwd: d.run.dir, roots: [d.run.dir], run: d.run, record: d.record, fetchImpl: d.fetchImpl };
  // A scout that fails silently is worse than one that fails loudly: the brain would read an empty
  // findings file and build a landscape on nothing. Each failure is recorded and written into the
  // file the brain reads, so a partial discovery is visible in the output rather than inferred.
  const outcomes = await Promise.all(
    questions.slice(0, 4).map(async (q, i) => {
      const r = await runScout({
        question: q,
        brief,
        model: scoutModel,
        getApiKey: () => d.apiKeyFor(String(scoutModel.provider)),
        tools: scoutTools(scoutCtx),
        record: d.record,
        home: d.home,
        cfg: d.cfg,
        runId: d.run.id,
        role: "scout",
        phase: "discover",
        streamFn: d.streamFn,
      });
      const failure = scoutFailure(r);
      if (failure) d.record.append({ t: "failure", class: failure.class, message: `scout failed on "${q}": ${failure.message}`, ...(failure.category ? { category: failure.category } : {}) });
      const findings = failure?.class === "refusal"
        ? `(scout refused: ${failure.category})`
        : failure ? `(scout failed: ${failure.class}: ${failure.message})` : r.findings;
      writeFileSync(join(d.run.discoveryDir, `${i + 1}-${slug(q)}.md`), `# Question\n${q}\n\n# Findings\n${findings}\n`);
      return failure;
    }),
  );
  if (outcomes.length > 0 && outcomes.every((o) => o !== undefined)) {
    const classes = new Set(outcomes.map((o) => o!.class));
    // Scouts that failed for the same reason name it; a mixed batch is reported as transient,
    // the class that says "the same run could go differently".
    const failureClass = classes.size === 1 ? [...classes][0]! : "transient";
    return finish({ outcome: "failed", failureClass, message: `all ${outcomes.length} scouts failed in discover: ${outcomes[0]!.message}` });
  }

  let exit: { kind: ExitKind; reasons: string[] } | undefined;
  const ctx: ToolContext = {
    cwd: d.run.dir,
    roots: [d.run.dir],
    run: d.run,
    record: d.record,
    fetchImpl: d.fetchImpl,
    onExit: (kind, reasons) => { exit = { kind, reasons }; },
    // A scout the brain asked for gets the same treatment as the batch above: a failure is
    // journalled and handed back as text, so the brain sees that its question went unanswered
    // instead of an empty string it might read as "nothing exists".
    spawnScout: async (question) => {
      const r = await runScout({
        question,
        brief,
        model: scoutModel,
        getApiKey: () => d.apiKeyFor(String(scoutModel.provider)),
        tools: scoutTools(scoutCtx),
        record: d.record,
        home: d.home,
        cfg: d.cfg,
        runId: d.run.id,
        role: "scout",
        phase: "discover",
        streamFn: d.streamFn,
      });
      const failure = scoutFailure(r);
      if (!failure) return r.findings;
      d.record.append({ t: "failure", class: failure.class, message: `scout failed on "${question}": ${failure.message}`, ...(failure.category ? { category: failure.category } : {}) });
      return failure.class === "refusal" ? `(scout refused: ${failure.category})` : `(scout failed: ${failure.class}: ${failure.message})`;
    },
  };
  // Read through a function rather than the bare `exit` variable: TS's flow analysis for a `let`
  // mutated only inside a closure does not reliably re-widen it across an intervening `await`
  // once it has been narrowed to `undefined`, which would make later `if (exit)` checks unsound.
  const takeExit = (): { kind: ExitKind; reasons: string[] } | undefined => exit;
  const brainModel = d.models("brain").model;
  const brain = createBrain({
    model: brainModel,
    getApiKey: () => d.apiKeyFor(String(brainModel.provider)),
    tools: brainTools(ctx, "discover"),
    systemPrompt: [loadPrompt(d.home, "kernel"), loadPrompt(d.home, "brain"), `## Playbook (discover)\n${playbookSection(loadPlaybook(d.home), "discover")}`],
    pinned: discoverContract(d.run, questions, turnCap),
    record: d.record,
    role: "brain",
    phase: "discover",
    turnCap,
    effort: effortFor(d.cfg, "brain", brainModel),
    streamFn: d.streamFn,
    onText: d.onText,
    onTool: d.onTool,
    shaping: { cfg: d.cfg, runId: d.run.id },
  });
  const v = await runValidatedFile({
    brain,
    path: d.run.landscape,
    parse: parseLandscape,
    validate: (p) => (p.missing.length > 0 ? [`missing sections: ${p.missing.join(", ")}`] : []),
    prompt: `Brief:\n${brief}\n\nScout findings are in ${d.run.discoveryDir}. Read them, then write ${d.run.landscape}.`,
    fix: (problems, path) => `${path} is not usable yet: ${problems.join("; ")}. Rewrite the whole file with every required section.`,
    halt: (r) => takeExit() !== undefined || stopFailure("discover", turnCap, r) !== undefined,
  });
  const exited = takeExit();
  if (exited) return finish({ outcome: "honest_exit", ...exited });
  const stop = stopFailure("discover", turnCap, v.result);
  if (stop) return finish(stop);
  if (v.problems.length > 0) return finish({ outcome: "failed", failureClass: "verify", message: `landscape ${v.problems.join("; ")}` });
  return finish({ outcome: "ok" });
}
