import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/providers/auth";
import { RunController } from "../../src/tui/controller";
import type { TuiEvent } from "../../src/tui/contracts";

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}

describe("TUI provider authentication", () => {
  test("completes manual OAuth input without putting the code in the transcript", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-tui-auth-"));
    const store = new AuthStore(join(home, "auth.json"), {
      getEnvApiKey: () => undefined,
      getDefinition: () => ({ login: async (callbacks) => {
        callbacks.onAuth({ url: "https://login.example/full" });
        expect(await callbacks.onManualCodeInput?.()).toBe("one-time-secret");
        return { refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
      } }),
    });
    const events: TuiEvent[] = [];
    const controller = new RunController({ home, cliDeps: { authStoreFactory: () => store, openUrl: () => {} } });
    controller.subscribe((event) => events.push(event));
    const running = controller.execute("auth: login anthropic");
    await until(() => events.some((event) => event.type === "input_requested"));
    expect(JSON.stringify(controller.getSnapshot().transcript)).toContain("https://login.example/full");
    await controller.send("one-time-secret");
    await running;
    expect(controller.getSnapshot().auth?.required).toBe(false);
    expect(controller.getSnapshot().auth?.configured).toContain("anthropic");
    expect(JSON.stringify(controller.getSnapshot().transcript)).not.toContain("one-time-secret");
  });

  test("Escape-style cancellation aborts the provider flow and stores nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-tui-auth-cancel-"));
    let aborted = false; let opened = false;
    const store = new AuthStore(join(home, "auth.json"), {
      getEnvApiKey: () => undefined,
      getDefinition: () => ({ login: (callbacks) => new Promise((_resolve, reject) => {
        opened = true; callbacks.onAuth({ url: "https://login.example/full" });
        callbacks.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
      }) }),
    });
    const controller = new RunController({ home, cliDeps: { authStoreFactory: () => store, openUrl: () => {} } });
    const running = controller.execute("auth: login anthropic");
    await until(() => opened);
    await controller.cancel();
    await running;
    expect(aborted).toBe(true);
    expect(store.providers()).toEqual([]);
  });

  test("blocks login during an active run without disturbing that run", async () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-tui-auth-active-"));
    let release!: () => void; let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new RunController({ home, cli: async () => { entered = true; await gate; return 0; } });
    const running = controller.start({ seed: "keep this run alive" });
    await until(() => entered);
    await expect(controller.execute("auth: login anthropic")).rejects.toThrow("already active");
    expect(controller.getSnapshot().runId).toBeDefined();
    release();
    await running;
  });
});
