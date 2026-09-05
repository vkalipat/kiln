import type { RunRecord } from "../core/record";
import type { RunPaths } from "../core/run";
import { bwsGroups, readFrontier } from "../phases/checkpoint";
import type { TuiCheckpointAnswer, TuiCheckpointSnapshot } from "./contracts";

export type ControllerAskKind = "bws" | "decision" | "generic";

export interface ControllerAskDescription {
  kind: ControllerAskKind;
  groupIndex?: number;
  checkpoint?: TuiCheckpointSnapshot;
}

function promptGroup(prompt: string): { index: number; ids: string[] } | undefined {
  const match = /Group\s+(\d+):\s*([^\n]+)\nEnter best/i.exec(prompt);
  if (!match) return undefined;
  return {
    index: Math.max(0, Number(match[1]) - 1),
    ids: match[2]!.split(",").map((id) => id.trim()).filter(Boolean),
  };
}

function checkpointSnapshot(run: RunPaths, record: RunRecord, prompt: string): TuiCheckpointSnapshot {
  const frontier = readFrontier({ run });
  const cells = Object.fromEntries(frontier.ideas.map((idea) => [idea.id, idea.cell]));
  const groups = frontier.shown.length >= 4 ? bwsGroups(frontier.shown, cells) : [];
  const prompted = promptGroup(prompt);
  if (prompted && prompted.ids.length > 0) groups[prompted.index] = prompted.ids;
  const answered = record.read().filter((event) => event.t === "checkpoint.bws").length;
  const groupIndex = prompted?.index ?? (prompt.includes("Choose: pick") ? groups.length : Math.min(answered, groups.length));
  return {
    round: frontier.round,
    ideas: frontier.ideas.filter((idea) => frontier.shown.includes(idea.id)).map((idea) => ({
      id: idea.id,
      value: idea.value?.mean,
      feasibility: idea.feasibility?.mean,
      cell: idea.cell,
    })),
    groups,
    groupIndex,
    valueLadder: frontier.ladders.value.filter((id) => frontier.shown.includes(id)),
    feasibilityLadder: frontier.ladders.feasibility.filter((id) => frontier.shown.includes(id)),
  };
}

export function describeControllerAsk(run: RunPaths | undefined, record: RunRecord | undefined, prompt: string): ControllerAskDescription {
  const group = promptGroup(prompt);
  const kind: ControllerAskKind = group ? "bws" : prompt.includes("Choose: pick") ? "decision" : "generic";
  if (!run || !record || kind === "generic") return { kind };
  return { kind, ...(group ? { groupIndex: group.index } : {}), checkpoint: checkpointSnapshot(run, record, prompt) };
}

export function checkpointAnswerText(answer: TuiCheckpointAnswer): string {
  if (answer.kind === "bws") return `best ${answer.best} worst ${answer.worst}`;
  if (answer.kind === "pick") return `pick ${answer.id}`;
  if (answer.kind === "reject") return `reject ${answer.id} ${answer.reason.trim()}`;
  return `another ${answer.steering.trim()}`;
}

export function validateCheckpointAnswer(answer: TuiCheckpointAnswer, ask: ControllerAskDescription): void {
  if (ask.kind === "generic") throw new Error("the active prompt is not a checkpoint question");
  if (ask.kind === "bws") {
    if (answer.kind !== "bws") throw new Error("the checkpoint is waiting for a best-worst answer");
    if (ask.groupIndex !== answer.groupIndex) throw new Error(`the checkpoint is waiting for group ${(ask.groupIndex ?? 0) + 1}`);
    const group = ask.checkpoint?.groups[answer.groupIndex] ?? [];
    if (answer.best === answer.worst || !group.includes(answer.best) || !group.includes(answer.worst)) throw new Error("best and worst must be distinct ideas in the active group");
    return;
  }
  if (answer.kind === "bws") throw new Error("best-worst comparisons are already complete");
  if (answer.kind === "reject" && !answer.reason.trim()) throw new Error("a rejection reason is required");
  if (answer.kind === "another_round" && !answer.steering.trim()) throw new Error("steering is required for another round");
}
