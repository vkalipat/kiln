import { Input, Key, matchesKey, type Component } from "@oh-my-pi/pi-tui";
import { fitLine, renderRoundedOverlay } from "./overlay";

export interface AuthInputOptions {
  readonly prompt: string;
  readonly secret: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

/** Focused one-line OAuth/API-key prompt. Secret values render only as bullets. */
export class AuthInput implements Component {
  readonly input = new Input();
  error?: string;

  constructor(readonly options: AuthInputOptions) {
    this.input.prompt = "› ";
    this.input.mask = options.secret;
    this.input.onSubmit = (value) => {
      if (!value.trim()) { this.error = "A value is required"; return; }
      this.input.setValue("");
      options.onSubmit(value);
    };
    this.input.onEscape = options.onCancel;
  }

  render(width: number): readonly string[] {
    const inner = Math.max(1, width - 4);
    const rows = [fitLine(this.options.prompt, inner), "", ...this.input.render(inner)];
    if (this.error) rows.push("", fitLine(this.error, inner));
    return renderRoundedOverlay(rows, width, {
      title: this.options.secret ? "Secure input" : "Input required",
      footer: "Enter submit · Esc cancel",
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.options.onCancel();
    else this.input.handleInput(data);
  }

  invalidate(): void { this.input.invalidate(); }

  debugState(): Record<string, unknown> {
    return { secret: this.options.secret, hasValue: this.input.getValue().length > 0 };
  }
}
