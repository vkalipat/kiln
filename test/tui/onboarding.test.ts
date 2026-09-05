import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
  PROVIDER_ONBOARDING_CHOICES,
  ProviderOnboarding,
  providerOnboardingChoice,
  type ProviderOnboardingChoice,
} from "../../src/tui/onboarding";

const WIDTHS = [20, 40, 80, 120] as const;

describe("provider onboarding", () => {
  test("offers four stable choices mapped to controller palette commands", () => {
    expect(PROVIDER_ONBOARDING_CHOICES.map((choice) => choice.id)).toEqual([
      "anthropic-subscription",
      "chatgpt-subscription",
      "anthropic-api-key",
      "openai-api-key",
    ]);
    expect(PROVIDER_ONBOARDING_CHOICES.map(({ commandId, args }) => [commandId, ...args])).toEqual([
      ["auth: login anthropic", "--method", "oauth"],
      ["auth: login openai", "--method", "oauth"],
      ["auth: login anthropic", "--method", "api-key"],
      ["auth: login openai", "--method", "api-key"],
    ]);
    expect(providerOnboardingChoice("chatgpt-subscription")?.label).toBe("ChatGPT subscription");
    expect(providerOnboardingChoice("unknown")).toBeUndefined();
  });

  test("renders its title and environment discovery guidance at compact widths", () => {
    const onboarding = new ProviderOnboarding();
    for (const width of WIDTHS) {
      const lines = onboarding.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const rendered = onboarding.render(80).join("\n");
    expect(rendered).toContain("Connect a provider");
    expect(rendered).toContain("Environment credentials are detected automatically.");
    expect(rendered).toContain("ANTHROPIC_API_KEY · OPENAI_API_KEY");
  });

  test("selects with Enter and cancels with Escape", () => {
    const selected: ProviderOnboardingChoice[] = [];
    let cancelled = 0;
    const onboarding = new ProviderOnboarding({
      onSelect: (choice) => selected.push(choice),
      onCancel: () => { cancelled += 1; },
    });

    onboarding.handleInput("\x1b[B");
    onboarding.handleInput("\r");
    expect(selected[0]?.id).toBe("chatgpt-subscription");

    onboarding.handleInput("\x1b");
    expect(cancelled).toBe(1);
  });
});
