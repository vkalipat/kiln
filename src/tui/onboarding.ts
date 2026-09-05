import { SelectList, type Component, type SelectItem } from "@oh-my-pi/pi-tui";
import { fitLine, RoundedOverlay } from "./overlay";
import type { PaletteCommand } from "./palette";
import { selectListTheme } from "./theme";

export type ProviderOnboardingChoiceId =
  | "anthropic-subscription"
  | "chatgpt-subscription"
  | "anthropic-api-key"
  | "openai-api-key";

export interface ProviderOnboardingChoice {
  /** Stable identifier for restoring or testing the selected onboarding choice. */
  readonly id: ProviderOnboardingChoiceId;
  readonly label: string;
  readonly description: string;
  /** Existing command-palette identifier understood by RunController.execute. */
  readonly commandId: PaletteCommand["id"];
  /** Explicit login method appended to the palette command argv. */
  readonly args: readonly ["--method", "oauth" | "api-key"];
}

export const PROVIDER_ONBOARDING_CHOICES: readonly ProviderOnboardingChoice[] = [
  {
    id: "anthropic-subscription",
    label: "Anthropic subscription",
    description: "Sign in with Anthropic OAuth",
    commandId: "auth: login anthropic",
    args: ["--method", "oauth"],
  },
  {
    id: "chatgpt-subscription",
    label: "ChatGPT subscription",
    description: "Sign in with ChatGPT OAuth",
    commandId: "auth: login openai",
    args: ["--method", "oauth"],
  },
  {
    id: "anthropic-api-key",
    label: "Anthropic API key",
    description: "Enter a key for Anthropic",
    commandId: "auth: login anthropic",
    args: ["--method", "api-key"],
  },
  {
    id: "openai-api-key",
    label: "OpenAI API key",
    description: "Enter a key for OpenAI",
    commandId: "auth: login openai",
    args: ["--method", "api-key"],
  },
] as const;

const CHOICE_BY_ID = new Map(PROVIDER_ONBOARDING_CHOICES.map((choice) => [choice.id, choice]));

/** Resolve a persisted choice id to the palette command invocation used by the controller. */
export function providerOnboardingChoice(id: string): ProviderOnboardingChoice | undefined {
  return CHOICE_BY_ID.get(id as ProviderOnboardingChoiceId);
}

class OnboardingBody implements Component {
  constructor(readonly list: SelectList) {}

  render(width: number): readonly string[] {
    return [
      fitLine("Environment credentials are detected automatically.", width),
      fitLine("ANTHROPIC_API_KEY · OPENAI_API_KEY", width),
      fitLine("", width),
      ...this.list.render(width),
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export interface ProviderOnboardingOptions {
  maxVisible?: number;
  onSelect?: (choice: ProviderOnboardingChoice) => void;
  onCancel?: () => void;
}

/** Compact first-run provider chooser backed by pi-tui's keyboard-accessible SelectList. */
export class ProviderOnboarding implements Component {
  readonly choices = PROVIDER_ONBOARDING_CHOICES;
  readonly list: SelectList;
  readonly overlay: RoundedOverlay;
  onSelect?: (choice: ProviderOnboardingChoice) => void;
  onCancel?: () => void;

  constructor(options: ProviderOnboardingOptions = {}) {
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    const items: SelectItem[] = this.choices.map((choice) => ({
      value: choice.id,
      label: choice.label,
      description: choice.description,
    }));
    this.list = new SelectList(items, options.maxVisible ?? 4, selectListTheme, {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 24,
    });
    this.list.onSelect = (item) => {
      const choice = providerOnboardingChoice(item.value);
      if (choice) this.onSelect?.(choice);
    };
    this.list.onCancel = () => this.onCancel?.();
    this.overlay = new RoundedOverlay(new OnboardingBody(this.list), {
      title: "Connect a provider",
      footer: "Enter connect · Esc cancel",
    });
  }

  getSelectedChoice(): ProviderOnboardingChoice | undefined {
    const id = this.list.getSelectedItem()?.value;
    return id ? providerOnboardingChoice(id) : undefined;
  }

  render(width: number): readonly string[] {
    return this.overlay.render(width);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  debugState(): Record<string, unknown> {
    return { ...this.list.debugState(), selectedChoice: this.getSelectedChoice()?.id ?? null };
  }
}
