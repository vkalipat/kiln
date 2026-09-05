import { describe, expect, test } from "bun:test";
import { checkEnv } from "../../src/build/env";

describe("checkEnv", () => {
  test("keeps only the fixed base and explicitly declared present names", () => {
    const env = checkEnv(["DATABASE_URL", "ABSENT", "TERM"], {
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
      DATABASE_URL: "declared-secret-shaped-value",
      HIDDEN_VALUE: "must-not-pass",
      TERM: "xterm-256color",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
      DATABASE_URL: "declared-secret-shaped-value",
      TERM: "dumb",
    });
    expect(env.HIDDEN_VALUE).toBeUndefined();
    expect(env.ABSENT).toBeUndefined();
  });

  test("does not mutate the source environment", () => {
    const source = { PATH: "/bin", TERM: "color" };
    checkEnv([], source);
    expect(source).toEqual({ PATH: "/bin", TERM: "color" });
  });

  test("represents a declared __proto__ value as an own environment property", () => {
    const source: NodeJS.ProcessEnv = {};
    Object.defineProperty(source, "__proto__", { value: "explicit", enumerable: true });
    const result = checkEnv(["__proto__"], source);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toBe("explicit");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
