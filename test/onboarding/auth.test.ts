import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAuthState, providerChoice } from "../../src/onboarding/auth";
import { AuthStore } from "../../src/providers/auth";

describe("onboarding auth discovery", () => {
  test("recognizes aliases without conflating OpenAI key and subscription providers", () => {
    expect(providerChoice("claude")?.login).toBe("anthropic");
    expect(providerChoice("chatgpt")?.login).toBe("openai-codex");
    expect(providerChoice("openai")?.apiKey).toBe("openai");
  });

  test("environment credentials skip onboarding without creating auth.json", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-onboarding-auth-"));
    const path = join(home, "auth.json");
    const store = new AuthStore(path, {
      getEnvApiKey: (provider) => provider === "anthropic" ? "env-secret" : undefined,
      getDefinition: () => undefined,
    });
    expect(localAuthState(home, store)).toEqual({ required: false, configured: ["anthropic"] });
    expect(existsSync(path)).toBe(false);
  });
});
