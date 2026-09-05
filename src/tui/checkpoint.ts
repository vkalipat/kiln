import { extractPrintableText, Key, matchesKey, type Component } from "@oh-my-pi/pi-tui";
import type { TuiCheckpointAnswer, TuiCheckpointIdea, TuiCheckpointSnapshot } from "./contracts";
import { renderRoundedOverlay } from "./overlay";
import { ansi } from "./theme";

export type CheckpointStage =
  | "best"
  | "worst"
  | "decision"
  | "pick"
  | "reject"
  | "reject_reason"
  | "another_round";

export interface CheckpointModalOptions {
  onAnswer?: (answer: TuiCheckpointAnswer) => void | Promise<void>;
  onCancel?: () => void;
}

const DECISIONS = ["Pick an idea", "Reject an idea", "Another round"] as const;

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.trunc(index), Math.max(0, length - 1)));
}

/** Stateful best-worst checkpoint flow, followed by the checkpoint decision. */
export class CheckpointModal implements Component {
  snapshot: TuiCheckpointSnapshot;
  stage: CheckpointStage;
  groupIndex: number;
  selectedIndex = 0;
  best?: string;
  targetId?: string;
  input = "";
  error?: string;
  lastAnswer?: TuiCheckpointAnswer;
  onAnswer?: CheckpointModalOptions["onAnswer"];
  onCancel?: CheckpointModalOptions["onCancel"];

  constructor(snapshot: TuiCheckpointSnapshot, options: CheckpointModalOptions = {}) {
    this.snapshot = snapshot;
    this.groupIndex = clampIndex(snapshot.groupIndex, snapshot.groups.length + 1);
    this.stage = this.groupIndex < snapshot.groups.length ? "best" : "decision";
    this.onAnswer = options.onAnswer;
    this.onCancel = options.onCancel;
  }

  setSnapshot(snapshot: TuiCheckpointSnapshot): void {
    this.snapshot = snapshot;
    this.groupIndex = clampIndex(snapshot.groupIndex, snapshot.groups.length + 1);
    this.stage = this.groupIndex < snapshot.groups.length ? "best" : "decision";
    this.selectedIndex = 0;
    this.best = undefined;
    this.targetId = undefined;
    this.input = "";
    this.error = undefined;
  }

  get currentGroup(): readonly string[] {
    return this.snapshot.groups[this.groupIndex] ?? [];
  }

  render(width: number): readonly string[] {
    const contentWidth = Math.max(1, Math.trunc(width) - 4);
    const rows = this.stage === "best" || this.stage === "worst"
      ? this.#renderBestWorst(contentWidth)
      : this.#renderDecision(contentWidth);
    if (this.error) rows.push("", ansi.red(this.error));
    rows.push("", ...this.#renderLadders());
    return renderRoundedOverlay(rows, width, {
      title: `Checkpoint · round ${this.snapshot.round}`,
      footer: this.#footer(),
    });
  }

  handleInput(data: string): void {
    this.error = undefined;
    if (matchesKey(data, Key.escape)) {
      this.#back();
      return;
    }
    if (this.stage === "reject_reason" || this.stage === "another_round") {
      this.#handleTextInput(data);
      return;
    }
    if (matchesKey(data, Key.up)) this.#move(-1);
    else if (matchesKey(data, Key.down)) this.#move(1);
    else if (matchesKey(data, Key.enter) || data === "\n") this.chooseCurrent();
    else if (/^[1-9]$/.test(data)) {
      this.selectedIndex = clampIndex(Number(data) - 1, this.#choiceCount());
      this.chooseCurrent();
    }
  }

  chooseCurrent(): void {
    if (this.stage === "best") {
      const id = this.currentGroup[this.selectedIndex];
      if (!id) return;
      this.best = id;
      this.stage = "worst";
      this.#move(1);
      return;
    }
    if (this.stage === "worst") {
      const worst = this.currentGroup[this.selectedIndex];
      if (!worst || worst === this.best || !this.best) {
        this.error = "Best and worst must be different ideas.";
        return;
      }
      this.#emit({ kind: "bws", groupIndex: this.groupIndex, best: this.best, worst });
      this.groupIndex += 1;
      this.best = undefined;
      this.selectedIndex = 0;
      this.stage = this.groupIndex < this.snapshot.groups.length ? "best" : "decision";
      return;
    }
    if (this.stage === "decision") {
      this.stage = (["pick", "reject", "another_round"] as const)[this.selectedIndex] ?? "pick";
      this.selectedIndex = 0;
      this.input = "";
      return;
    }
    if (this.stage === "pick") {
      const id = this.snapshot.ideas[this.selectedIndex]?.id;
      if (id) this.#emit({ kind: "pick", id });
      return;
    }
    if (this.stage === "reject") {
      const id = this.snapshot.ideas[this.selectedIndex]?.id;
      if (id) {
        this.targetId = id;
        this.stage = "reject_reason";
        this.input = "";
      }
    }
  }

  debugState(): Record<string, unknown> {
    return {
      round: this.snapshot.round,
      stage: this.stage,
      groupIndex: this.groupIndex,
      selectedIndex: this.selectedIndex,
      best: this.best ?? null,
      targetId: this.targetId ?? null,
      input: this.input,
      lastAnswer: this.lastAnswer ?? null,
    };
  }

  #renderBestWorst(width: number): string[] {
    const role = this.stage === "best" ? "BEST" : "WORST";
    const rows = [
      `Group ${Math.min(this.groupIndex + 1, this.snapshot.groups.length)} of ${this.snapshot.groups.length} · choose ${role}`,
      "",
    ];
    const ideas = new Map(this.snapshot.ideas.map((idea) => [idea.id, idea]));
    this.currentGroup.forEach((id, index) => rows.push(this.#ideaRow(ideas.get(id) ?? { id }, index, width)));
    if (this.currentGroup.length !== 4) rows.push(ansi.yellow(`Expected four choices; received ${this.currentGroup.length}.`));
    return rows;
  }

  #renderDecision(width: number): string[] {
    if (this.stage === "decision") {
      return ["Comparisons complete. Choose what happens next:", "", ...DECISIONS.map((label, index) => this.#choiceRow(label, index))];
    }
    if (this.stage === "pick" || this.stage === "reject") {
      const verb = this.stage === "pick" ? "pick" : "reject";
      return [`Choose an idea to ${verb}:`, "", ...this.snapshot.ideas.map((idea, index) => this.#ideaRow(idea, index, width))];
    }
    const prompt = this.stage === "reject_reason"
      ? `Why reject ${this.targetId ?? "this idea"}?`
      : "What should the next round explore?";
    return [prompt, "", `${ansi.blue(">")} ${this.input}▌`];
  }

  #ideaRow(idea: TuiCheckpointIdea, index: number, width: number): string {
    const selected = index === this.selectedIndex;
    const cursor = selected ? ansi.yellow("›") : " ";
    const best = idea.id === this.best ? ansi.green(" [BEST]") : "";
    const title = idea.title ? `${idea.id} · ${idea.title}` : idea.id;
    const summary = width >= 68 && idea.summary ? ` — ${idea.summary.replace(/[\r\n]+/g, " ")}` : "";
    return `${cursor} ${title}${best}${summary}`;
  }

  #choiceRow(label: string, index: number): string {
    return `${index === this.selectedIndex ? ansi.yellow("›") : " "} ${label}`;
  }

  #renderLadders(): string[] {
    const value = this.snapshot.valueLadder.length > 0 ? this.snapshot.valueLadder.join(" > ") : "unranked";
    const feasibility = this.snapshot.feasibilityLadder.length > 0 ? this.snapshot.feasibilityLadder.join(" > ") : "unranked";
    return [`${ansi.bold("Value")}        ${value}`, `${ansi.bold("Feasibility")}  ${feasibility}`];
  }

  #choiceCount(): number {
    if (this.stage === "best" || this.stage === "worst") return this.currentGroup.length;
    if (this.stage === "decision") return DECISIONS.length;
    if (this.stage === "pick" || this.stage === "reject") return this.snapshot.ideas.length;
    return 0;
  }

  #move(step: number): void {
    const count = this.#choiceCount();
    if (count === 0) return;
    for (let attempts = 0; attempts < count; attempts += 1) {
      this.selectedIndex = (this.selectedIndex + step + count) % count;
      if (this.stage !== "worst" || this.currentGroup[this.selectedIndex] !== this.best) break;
    }
  }

  #handleTextInput(data: string): void {
    if (matchesKey(data, Key.enter) || data === "\n") {
      const text = this.input.trim();
      if (!text) {
        this.error = this.stage === "reject_reason" ? "A rejection reason is required." : "Steering is required.";
      } else if (this.stage === "reject_reason" && this.targetId) {
        this.#emit({ kind: "reject", id: this.targetId, reason: text });
      } else if (this.stage === "another_round") {
        this.#emit({ kind: "another_round", steering: text });
      }
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      const characters = [...this.input];
      characters.pop();
      this.input = characters.join("");
      return;
    }
    const printable = extractPrintableText(data);
    if (printable) this.input += printable.replace(/[\r\n]/g, " ");
  }

  #back(): void {
    if (this.stage === "best" || this.stage === "decision") this.onCancel?.();
    else if (this.stage === "worst") {
      this.stage = "best";
      this.selectedIndex = Math.max(0, this.currentGroup.indexOf(this.best ?? ""));
      this.best = undefined;
    } else if (this.stage === "reject_reason") {
      this.stage = "reject";
      this.input = "";
    } else {
      this.stage = "decision";
      this.selectedIndex = 0;
      this.input = "";
    }
  }

  #emit(answer: TuiCheckpointAnswer): void {
    this.lastAnswer = answer;
    try {
      const result = this.onAnswer?.(answer);
      if (result) void result.catch((error: unknown) => { this.error = error instanceof Error ? error.message : String(error); });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  #footer(): string {
    if (this.stage === "reject_reason" || this.stage === "another_round") return "type · Enter submit · Esc back";
    return "↑/↓ choose · Enter select · Esc back";
  }
}
