import { describe, expect, test } from "bun:test";
import { AuthInput } from "../../src/tui/auth-input";

describe("TUI secure auth input", () => {
  test("masks values and never includes them in debug output", () => {
    const submitted: string[] = [];
    const input = new AuthInput({ prompt: "API key", secret: true, onSubmit: (value) => submitted.push(value), onCancel: () => {} });
    input.handleInput("sk-super-secret");
    expect(input.render(60).join("\n")).not.toContain("sk-super-secret");
    expect(JSON.stringify(input.debugState())).not.toContain("sk-super-secret");
    input.handleInput("\r");
    expect(submitted).toEqual(["sk-super-secret"]);
  });

  test("cancels without submitting", () => {
    let cancelled = 0;
    const input = new AuthInput({ prompt: "Code", secret: true, onSubmit: () => { throw new Error("unexpected submit"); }, onCancel: () => { cancelled++; } });
    input.handleInput("temporary-code");
    input.handleInput("\x1b");
    expect(cancelled).toBe(1);
  });
});
