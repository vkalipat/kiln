import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import { createBrain } from "../brain/agent";
import { loadPrompt } from "../brain/prompts";
import type { IdeaShape, KilnConfig, Role } from "../core/config";
import type { PairOrder } from "../core/events";
import { writeAtomic } from "../core/paths";
import type { RunRecord } from "../core/record";
import type { RunPaths } from "../core/run";
import { effortFor } from "../providers/models";
import type { Winner } from "./bt";

/**
 * The judge (record §7): commit-first criteria written once per round before any candidate
 * exists, one fresh stateless call per pair and ordering with a single `verdict` tool, forced
 * choice on value and feasibility, and a meta-review written from losing reasons only.
 */

export const META_REVIEW_TOKEN_CAP = 400;
/** About four characters per token; the hard cap applied to the stored meta-review. */
export const META_REVIEW_CHAR_CAP = META_REVIEW_TOKEN_CAP * 4;

export interface JudgeDeps {
  home: string;
  run: RunPaths;
  record: RunRecord;
  cfg: KilnConfig;
  models: (role: Role) => { model: Model; ref: string };
  apiKeyFor: (provider: string) => Promise<string | undefined>;
  streamFn?: StreamFn;
  effort: string;
}

export interface Criteria {
  id: string;
  text: string;
  round: number;
  shape: IdeaShape;
}

export type { Winner } from "./bt";

export interface PairVerdict {
  valueWinner: Winner;
  feasibilityWinner: Winner;
  reason: string;
  judgeModel: string;
  costUsd: number;
  retried: boolean;
}

export const VERDICT_SCHEMA = {
  type: "object",
  properties: { valueWinner: { type: "string" }, feasibilityWinner: { type: "string" }, reason: { type: "string" } },
  required: ["valueWinner", "feasibilityWinner", "reason"],
  additionalProperties: false,
} as const;

/** The judge prompt with only this run's shape block under `## Value` (record §1: one file, one shape clause). */
export function judgePromptFor(home: string, shape: IdeaShape): string {
  const md = loadPrompt(home, "judge");
  const [head, valueSection] = md.split(/^## Value\s*$/m);
  if (valueSection === undefined) return md;
  const blocks = valueSection.split(/^### /m);
  const intro = blocks[0] ?? "";
  const mine = blocks.slice(1).find((b) => b.split("\n")[0]?.trim().toLowerCase() === shape);
  const body = mine === undefined ? "" : `### ${mine.trimEnd()}\n`;
  return `${head?.trimEnd() ?? ""}\n\n## Value\n${intro.trim()}\n\n${body}`.trimEnd() + "\n";
}

function judgeBrain(deps: JudgeDeps, opts: { tools: AgentTool<any>[]; pinned: string; turnCap: number; shape: IdeaShape; terminalTools?: string[] }) {
  const { model } = deps.models("judge");
  return createBrain({
    model,
    getApiKey: () => deps.apiKeyFor(String(model.provider)),
    tools: opts.tools,
    systemPrompt: [loadPrompt(deps.home, "kernel"), judgePromptFor(deps.home, opts.shape)],
    pinned: opts.pinned,
    record: deps.record,
    role: "judge",
    phase: "ideate",
    turnCap: opts.turnCap,
    effort: effortFor(deps.cfg, "judge", model),
    streamFn: deps.streamFn,
    terminalTools: opts.terminalTools,
    shaping: { cfg: deps.cfg, runId: deps.run.id },
  });
}

function existingCriteria(dir: string, round: number, shape: IdeaShape): Criteria | undefined {
  if (!existsSync(dir)) return undefined;
  const prefix = `r${round}-`;
  const file = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".md") && !f.endsWith("-meta.md")).sort()[0];
  if (!file) return undefined;
  const text = readFileSync(join(dir, file), "utf8");
  return { id: file.slice(0, -3), text: text.trim(), round, shape };
}

/** The criteria for a round, or the recorded reason there are none. A round with no criteria
 *  cannot be judged at all - `judgePair` would pin an empty block and every line would carry
 *  `criteriaId: ""` - so the failure is a discriminant the caller has to narrow past, never a
 *  blank `Criteria` that reads as success (record §3: a `verify` failure after its one retry). */
export type CriteriaResult =
  | (Criteria & { ok: true; reused: boolean; costUsd: number })
  | { ok: false; failure: "verify"; message: string; costUsd: number };

/** Write the round's criteria before any candidate is seen; one file per round, reused on resume. */
export async function writeCriteria(deps: JudgeDeps, round: number, brief: string, shape: IdeaShape, metaReview?: string): Promise<CriteriaResult> {
  const existing = existingCriteria(deps.run.criteriaDir, round, shape);
  if (existing) return { ...existing, ok: true, reused: true, costUsd: 0 };
  const task = [
    `Round ${round}. Before seeing any candidate, write the criteria you will hold every idea to for this brief and shape: what a strong idea must do, and where such ideas usually fail. Under 250 words, as bullets. Do not name or invent any idea.`,
    "",
    "## Brief",
    brief.trim(),
    ...(metaReview ? ["", "## Meta-review of the previous round", metaReview.trim()] : []),
  ].join("\n");
  let text = "";
  let costUsd = 0;
  for (let attempt = 0; attempt < 2 && text.trim() === ""; attempt += 1) {
    const brain = judgeBrain(deps, { tools: [], pinned: `Shape: ${shape}. Write criteria only.`, turnCap: 1, shape });
    const r = await brain.run(attempt === 0 ? task : `${task}\n\nYour previous answer was empty. Write the criteria now.`);
    costUsd += r.costUsd;
    text = r.text.trim();
  }
  if (text === "") {
    const message = `judge wrote no criteria for round ${round} after one retry`;
    deps.record.append({ t: "failure", class: "verify", message });
    return { ok: false, failure: "verify", message, costUsd };
  }
  const id = `r${round}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
  writeAtomic(join(deps.run.criteriaDir, `${id}.md`), `${text}\n`);
  return { ok: true, id, text, round, shape, reused: false, costUsd };
}

/** The user turn for one comparison: A is whichever render is presented first for this order. */
export function pairUserTurn(aRender: string, bRender: string, order: PairOrder): string {
  const [first, second] = order === "ab" ? [aRender, bRender] : [bRender, aRender];
  return ["## Idea A", first.trim(), "", "## Idea B", second.trim(), "", "Compare A and B on value and on feasibility against the criteria. Call the verdict tool."].join("\n");
}

function canonical(label: string, order: PairOrder): Winner {
  const l = label.trim().toUpperCase();
  if (l !== "A" && l !== "B") return "tie";
  if (order === "ab") return l === "A" ? "a" : "b";
  return l === "A" ? "b" : "a";
}

/** One fresh stateless comparison; a missing or malformed verdict is retried once, then recorded as a tie. */
export async function judgePair(deps: JudgeDeps, criteria: Criteria, aRender: string, bRender: string, order: PairOrder): Promise<PairVerdict> {
  const judgeModel = deps.models("judge").ref;
  let costUsd = 0;
  let captured: { valueWinner: string; feasibilityWinner: string; reason: string } | undefined;
  const verdictTool: AgentTool<any> = {
    name: "verdict",
    label: "Verdict",
    intent: "omit",
    description: "Name the value winner and the feasibility winner (A or B) and the deciding difference.",
    // No enum here: the loop would reject a lowercase "b" before the tool ran; execute() validates.
    parameters: VERDICT_SCHEMA,
    examples: [{ caption: "B is more valuable, A more feasible", call: { valueWinner: "B", feasibilityWinner: "A", reason: "B's claim changes the user's weekly routine; A's test is a one-line script." } }],
    async execute(_id, p: { valueWinner?: string; feasibilityWinner?: string; reason?: string }) {
      const v = String(p.valueWinner ?? "").trim().toUpperCase();
      const f = String(p.feasibilityWinner ?? "").trim().toUpperCase();
      if ((v !== "A" && v !== "B") || (f !== "A" && f !== "B")) return { content: [{ type: "text" as const, text: "error: valueWinner and feasibilityWinner must each be A or B" }], isError: true };
      captured = { valueWinner: v, feasibilityWinner: f, reason: String(p.reason ?? "").trim() };
      return { content: [{ type: "text" as const, text: "verdict recorded" }] };
    },
  };
  let retried = false;
  let refusal: string | undefined;
  for (let attempt = 0; attempt < 2 && !captured; attempt += 1) {
    retried = attempt === 1;
    const brain = judgeBrain(deps, { tools: [verdictTool], pinned: `Criteria (written before any candidate, round ${criteria.round}):\n${criteria.text}`, turnCap: 1, shape: criteria.shape, terminalTools: ["verdict"] });
    const r = await brain.run(attempt === 0 ? pairUserTurn(aRender, bRender, order) : `${pairUserTurn(aRender, bRender, order)}\n\nYou must answer by calling the verdict tool with valueWinner and feasibilityWinner set to A or B.`);
    costUsd += r.costUsd;
    if (r.stopped === "refused") {
      refusal = r.stopDetails?.category?.trim() || "unknown";
      break;
    }
  }
  if (!captured) return { valueWinner: "tie", feasibilityWinner: "tie", reason: refusal ? `refused:${refusal}` : "no verdict after retry", judgeModel, costUsd, retried };
  return { valueWinner: canonical(captured.valueWinner, order), feasibilityWinner: canonical(captured.feasibilityWinner, order), reason: captured.reason, judgeModel, costUsd, retried };
}

function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** The round's critique of why losers lost, from their verdict reasons only; stored once per round.
 *  The run's shape is threaded through because §8 feeds this straight into the next round's
 *  criteria: summarizing a research or creative run against the product definition of value would
 *  push the wrong standard into the next round's judging. */
export async function writeMetaReview(deps: JudgeDeps, round: number, losingReasons: string[], shape: IdeaShape): Promise<{ text: string; costUsd: number }> {
  if (losingReasons.length === 0) return { text: "", costUsd: 0 };
  const path = join(deps.run.criteriaDir, `r${round}-meta.md`);
  if (existsSync(path)) return { text: readFileSync(path, "utf8").trim(), costUsd: 0 };
  const task = [
    `Round ${round} is judged. Below are the judge's reasons for every comparison an idea lost. Write a meta-review of at most ${META_REVIEW_TOKEN_CAP} tokens: what made losers lose, as patterns the next round's generators should avoid. Do not describe or name any idea.`,
    "",
    "## Losing reasons",
    ...losingReasons.map((r) => `- ${r}`),
  ].join("\n");
  const brain = judgeBrain(deps, { tools: [], pinned: "Meta-review only. No ideas, no names.", turnCap: 1, shape });
  const r = await brain.run(task);
  const text = truncateWords(r.text.trim(), META_REVIEW_CHAR_CAP);
  if (text !== "") writeAtomic(path, `${text}\n`);
  return { text, costUsd: r.costUsd };
}
