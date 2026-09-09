import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainResult } from "../../src/brain/agent";
import { createDisposableDeadline, runValidatedFile } from "../../src/phases/shared";

const done = (text = "ok"): BrainResult => ({ text, turns: 1, costUsd: 0, stopped: "done" });

/** A brain stand-in that runs a scripted side effect per prompt and remembers what it was asked. */
function scripted(steps: Array<(path: string) => void>, result: () => BrainResult = done) {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    brain: {
      async run(prompt: string) {
        prompts.push(prompt);
        steps[n++]?.("");
        return result();
      },
    },
  };
}

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), "kiln-")), "out.md");
}

describe("runValidatedFile", () => {
  test("returns the parsed value when the first attempt validates", async () => {
    const path = tmpFile();
    const s = scripted([() => writeFileSync(path, "good")]);
    const r = await runValidatedFile({ brain: s.brain, path, parse: (md) => md.trim(), validate: (p) => (p === "good" ? [] : ["bad"]), prompt: "write it", fix: (ps) => `fix ${ps.join(",")}` });
    expect(r.problems).toEqual([]);
    expect(r.parsed).toBe("good");
    expect(r.attempts).toBe(1);
    expect(s.prompts).toEqual(["write it"]);
  });

  test("re-asks exactly once with the problems, then gives up", async () => {
    const path = tmpFile();
    const s = scripted([() => writeFileSync(path, "bad"), () => writeFileSync(path, "still bad")]);
    const r = await runValidatedFile({ brain: s.brain, path, parse: (md) => md.trim(), validate: (p) => (p === "good" ? [] : [`not good: ${p}`]), prompt: "write it", fix: (ps) => `fix ${ps.join(",")}` });
    expect(r.problems).toEqual(["not good: still bad"]);
    expect(r.attempts).toBe(2);
    expect(s.prompts.length).toBe(2);
    expect(s.prompts[1]).toBe("fix not good: bad");
  });

  test("a second attempt that fixes the file succeeds", async () => {
    const path = tmpFile();
    const s = scripted([() => writeFileSync(path, "bad"), () => writeFileSync(path, "good")]);
    const r = await runValidatedFile({ brain: s.brain, path, parse: (md) => md.trim(), validate: (p) => (p === "good" ? [] : ["bad"]), prompt: "write it", fix: () => "fix it" });
    expect(r.problems).toEqual([]);
    expect(r.attempts).toBe(2);
  });

  test("a missing file is validated as empty content, not an exception", async () => {
    const path = tmpFile();
    const seen: string[] = [];
    const s = scripted([() => {}, () => {}]);
    await runValidatedFile({ brain: s.brain, path, parse: (md) => { seen.push(md); return md; }, validate: () => ["empty"], prompt: "p", fix: () => "f" });
    expect(seen).toEqual(["", ""]);
  });

  test("halt stops before the re-ask and reports itself", async () => {
    const path = tmpFile();
    const s = scripted([() => writeFileSync(path, "bad")], () => ({ text: "", turns: 1, costUsd: 0, stopped: "turn_cap" }));
    const r = await runValidatedFile({ brain: s.brain, path, parse: (md) => md, validate: () => ["bad"], prompt: "p", fix: () => "f", halt: (br) => br.stopped === "turn_cap" });
    expect(r.halted).toBe(true);
    expect(s.prompts.length).toBe(1);
    expect(r.result.stopped).toBe("turn_cap");
  });

  test("halt still returns the artifact validation observed after the completed turn", async () => {
    const path = tmpFile();
    const s = scripted([() => writeFileSync(path, "good")], () => ({ text: "", turns: 1, costUsd: 0, stopped: "turn_cap" }));
    const r = await runValidatedFile({
      brain: s.brain,
      path,
      parse: (md) => md.trim(),
      validate: (parsed) => parsed === "good" ? [] : ["bad"],
      prompt: "p",
      fix: () => "f",
      halt: (result) => result.stopped === "turn_cap",
    });
    expect(r).toMatchObject({ halted: true, parsed: "good", problems: [], attempts: 1 });
    expect(s.prompts).toHaveLength(1);
  });

  test("attempts is configurable", async () => {
    const path = tmpFile();
    const s = scripted([() => {}, () => {}, () => {}]);
    const r = await runValidatedFile({ brain: s.brain, path, parse: (md) => md, validate: () => ["bad"], prompt: "p", fix: () => "f", attempts: 3 });
    expect(r.attempts).toBe(3);
    expect(s.prompts.length).toBe(3);
  });

  test("onResult observes the initial invalid write and its corrective re-ask exactly once", async () => {
    const path = tmpFile(); const seen: BrainResult[] = [];
    let n = 0;
    const brain = { async run() { n += 1; writeFileSync(path, n === 1 ? "bad" : "good"); return done(`call-${n}`); } };
    const result = await runValidatedFile({
      brain, path, parse: (text) => text, validate: (text) => text === "good" ? [] : ["bad"],
      prompt: "write", fix: () => "fix", onResult: (value) => seen.push(value),
    });
    expect(result.problems).toEqual([]);
    expect(seen.map((value) => value.text)).toEqual(["call-1", "call-2"]);
  });
});

describe("createDisposableDeadline", () => {
  test("does not keep a Bun child alive while strongly referenced", async () => {
    const module = new URL("../../src/phases/shared.ts", import.meta.url).href;
    const source = `import { createDisposableDeadline } from ${JSON.stringify(module)}; globalThis.held = createDisposableDeadline(60_000); console.log("created");`;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    const outcome = await Promise.race([child.exited.then((code) => ({ kind: "exit" as const, code })), Bun.sleep(1_000).then(() => ({ kind: "timeout" as const }))]);
    if (outcome.kind === "timeout") child.kill();
    expect(outcome).toEqual({ kind: "exit", code: 0 });
  });

  test("dispose clears a pending deadline without aborting completed work", async () => {
    const deadline = createDisposableDeadline(10);
    deadline.dispose(); deadline.dispose();
    await Bun.sleep(20);
    expect(deadline.signal.aborted).toBe(false);
  });

  test("an undisposed deadline aborts with a timeout error", async () => {
    const deadline = createDisposableDeadline(1);
    await Bun.sleep(10);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ name: "TimeoutError" });
    deadline.dispose();
  });
});
