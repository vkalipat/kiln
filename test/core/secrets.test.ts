import { describe, expect, test } from "bun:test";
import { REDACTED, isSecretEnvName, redactEnv, redactText, redactValue, secretValues } from "../../src/core/secrets";

describe("isSecretEnvName", () => {
  test("matches the documented suffixes and the two oauth token names", () => {
    for (const n of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "MY_SECRET", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_CODEX_OAUTH_TOKEN"]) {
      expect(isSecretEnvName(n)).toBe(true);
    }
    for (const n of ["PATH", "HOME", "KILN_HOME", "API_KEYS_DIR", "TOKENIZER"]) expect(isSecretEnvName(n)).toBe(false);
  });
});

describe("redactEnv", () => {
  test("drops secret-named variables and keeps the rest", () => {
    const out = redactEnv({ PATH: "/usr/bin", FAKE_API_KEY: "sekrit", HOME: "/h", ANTHROPIC_OAUTH_TOKEN: "t" });
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });
  test("ignores undefined values", () => {
    expect(redactEnv({ PATH: "/usr/bin", NOTSET: undefined })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("secretValues", () => {
  test("collects long secret values only", () => {
    expect(secretValues({ A_TOKEN: "long-enough-value", B_TOKEN: "sml", PATH: "/usr/bin" })).toEqual(["long-enough-value"]);
  });
});

describe("redactText", () => {
  test("replaces an anthropic oauth token", () => {
    expect(redactText("here is sk-ant-oat01-abcdefghijklmnop ok", [])).toBe(`here is ${REDACTED} ok`);
  });
  test("replaces a bare sk- key", () => {
    expect(redactText("key=sk-abcdefghijklmnopqrstuvwx", [])).toBe(`key=${REDACTED}`);
  });
  test("replaces a known secret value wherever it appears", () => {
    expect(redactText("prefix super-secret-value suffix", ["super-secret-value"])).toBe(`prefix ${REDACTED} suffix`);
  });
  test("leaves ordinary text alone", () => {
    expect(redactText("sk-short and a normal sentence", [])).toBe("sk-short and a normal sentence");
  });
});

describe("redactValue", () => {
  test("walks objects and arrays", () => {
    const v = redactValue({ a: "sk-ant-oat01-abcdefghijklmnop", b: [{ c: "plain" }, "super-secret-value"], n: 3 }, ["super-secret-value"]);
    expect(v).toEqual({ a: REDACTED, b: [{ c: "plain" }, REDACTED], n: 3 });
  });
});
