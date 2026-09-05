import { Key, matchesKey, type Component } from "@oh-my-pi/pi-tui";
import type { TuiConfigEffort, TuiEffort } from "./contracts";
import { renderRoundedOverlay } from "./overlay";
import { ansi, EFFORT_STYLE } from "./theme";

export const EFFORTS: readonly TuiEffort[] = ["low", "medium", "high", "ultra"] as const;

export function toConfigEffort(effort: TuiEffort): TuiConfigEffort {
  return effort === "ultra" ? "xhigh" : effort;
}

export function fromConfigEffort(effort: TuiConfigEffort): TuiEffort {
  return effort === "xhigh" ? "ultra" : effort;
}

export const effortToConfig = toConfigEffort;
export const configToEffort = fromConfigEffort;

export function nextEffort(effort: TuiEffort, step = 1): TuiEffort {
  const index = EFFORTS.indexOf(effort);
  const offset = ((step % EFFORTS.length) + EFFORTS.length) % EFFORTS.length;
  return EFFORTS[(index + offset) % EFFORTS.length]!;
}

const DESCRIPTION: Readonly<Record<TuiEffort, string>> = {
  low: "Quick work with a small reasoning budget",
  medium: "Balanced reasoning for everyday work",
  high: "Deeper reasoning for demanding work",
  ultra: "Maximum reasoning for the hardest work",
};

export interface EffortDialOptions {
  onSelect?: (effort: TuiEffort, configEffort: TuiConfigEffort) => void | Promise<void>;
  onCancel?: () => void;
}

/** Keyboard-driven low/medium/high/ultra selector. Ultra persists as `xhigh`. */
export class EffortDial implements Component {
  effort: TuiEffort;
  onSelect?: EffortDialOptions["onSelect"];
  onCancel?: EffortDialOptions["onCancel"];

  constructor(effort: TuiEffort | TuiConfigEffort = "medium", options: EffortDialOptions = {}) {
    this.effort = effort === "xhigh" ? "ultra" : effort;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
  }

  setEffort(effort: TuiEffort | TuiConfigEffort): void {
    this.effort = effort === "xhigh" ? "ultra" : effort;
  }

  cycle(step = 1, commit = false): TuiEffort {
    this.effort = nextEffort(this.effort, step);
    if (commit) this.commit();
    return this.effort;
  }

  commit(): void {
    void this.onSelect?.(this.effort, toConfigEffort(this.effort));
  }

  render(width: number): readonly string[] {
    const selected = EFFORTS.indexOf(this.effort);
    const track = EFFORTS.map((effort, index) => {
      const glyph = index === selected ? "•" : "·";
      return index === selected ? EFFORT_STYLE[effort](ansi.bold(glyph)) : ansi.dim(glyph);
    }).join("     ");
    const labels = EFFORTS.map((effort) => {
      const padded = effort.padEnd(effort === "medium" ? 8 : 7);
      return effort === this.effort ? EFFORT_STYLE[effort](ansi.bold(padded)) : ansi.dim(padded);
    }).join("").trimEnd();
    return renderRoundedOverlay(
      [track, labels, "", DESCRIPTION[this.effort]],
      width,
      { title: "Effort", footer: "←/→ choose · Enter apply · Esc close" },
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) this.cycle(-1);
    else if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) this.cycle(1);
    else if (matchesKey(data, Key.ctrl("s"))) this.cycle(1, true);
    else if (matchesKey(data, Key.enter) || data === "\n") this.commit();
    else if (matchesKey(data, Key.escape)) this.onCancel?.();
  }

  debugState(): Record<string, unknown> {
    return { effort: this.effort, configEffort: toConfigEffort(this.effort) };
  }
}
