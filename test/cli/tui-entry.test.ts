import { expect, test } from "bun:test";
import { main } from "../../src/cli/main";
import { askCli } from "../../src/cli/runtime";
import { RunControl, RunCancelledError, withRunControl } from "../../src/core/run-control";

test("TUI entry passes explicit home and run id to its launch seam", async () => {
  let options: unknown;
  expect(await main(["tui", "--home", "/tmp/kiln-tui-home", "--run", "run-1"], { write: () => {} }, {
    launchTui: async (value) => { options = value; },
  })).toBe(0);
  expect(options).toEqual({ home: "/tmp/kiln-tui-home", runId: "run-1" });
});

test("CLI input can be cancelled even when an injected input never settles", async () => {
  const control = new RunControl();
  const pending = withRunControl(control, () => askCli("confirm?", { write: () => {}, ask: () => new Promise(() => {}) }, {}));
  control.cancel("stop waiting");
  await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
});
