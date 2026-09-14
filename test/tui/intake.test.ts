import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController } from "../../src/tui/controller";
import { currentRunControl } from "../../src/core/run-control";

test("bare greetings and help reply locally without starting orchestration", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-intake-"));
  let calls = 0;
  const controller = new RunController({ home, cli: async () => { calls++; return 0; } });
  for (const seed of ["HI", "  Hello!  ", "hey there", "help", "what can you do?", "how do I use kiln?"]) {
    await controller.start({ seed });
    expect(calls).toBe(0);
    expect(controller.getSnapshot().runId).toBeUndefined();
    expect(controller.getSnapshot().transcript.at(-2)).toMatchObject({ kind: "user", text: seed.trim() });
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "brain", text: expect.stringContaining("Describe") });
  }
  expect(readdirSync(join(home, "evolution", "work")).filter((name) => name.startsWith("tui-seed-"))).toEqual([]);
});

test("greetings that include tasks and short task seeds still start a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-intake-"));
  const seeds: string[] = [];
  const controller = new RunController({ home, cli: async (argv) => {
    seeds.push(readFileSync(argv[argv.indexOf("--seed-file") + 1]!, "utf8"));
    return 0;
  } });
  for (const seed of ["Hi, build a timer", "help me build a dashboard", "hello world app", "timer", "HI protocol implementation"]) {
    await controller.start({ seed });
  }
  expect(seeds).toEqual(["Hi, build a timer", "help me build a dashboard", "hello world app", "timer", "HI protocol implementation"]);
});

test("HI remains steering during a run and an answer during a prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-intake-"));
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const asked = Promise.withResolvers<void>();
  const steered: string[] = [];
  let answer: string | undefined;
  const controller = new RunController({ home, cli: async (_argv, io) => {
    const source = currentRunControl()!.registerSource({ role: "brain", phase: "frame", steer: (text) => steered.push(text) });
    ready.resolve();
    await release.promise;
    source.dispose();
    const pending = io.ask!("Choose a label:");
    asked.resolve();
    answer = await pending;
    return 0;
  } });
  const running = controller.start({ seed: "Build a timer" });
  await ready.promise;
  try {
    expect(await controller.send("HI")).toMatchObject({ status: "delivered" });
    expect(steered).toEqual(["HI"]);
  } finally {
    release.resolve();
  }
  await asked.promise;
  expect(await controller.send("HI")).toEqual({ status: "answered" });
  await running;
  expect(answer).toBe("HI");
});
