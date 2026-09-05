import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainTools, shapeResult, type ToolContext } from "../../src/brain/tools";
import { RunRecord } from "../../src/core/record";
import { createRun } from "../../src/core/run";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "kiln-output-hygiene-"));
  const run = createRun(home, "seed");
  const cwd = mkdtempSync(join(tmpdir(), "kiln-output-hygiene-cwd-"));
  const record = new RunRecord(run.record);
  const context: ToolContext = { cwd, roots: [cwd, run.dir], run, record };
  const read = brainTools(context, "discover").find((tool) => tool.name === "read")!;
  const callRead = async (path: string) => {
    const result = await read.execute("id", { path } as never);
    return {
      text: (result.content[0] as { text: string }).text,
      isError: result.isError === true,
    };
  };
  return { context, cwd, run, record, callRead };
}

function spillPath(note: string): string {
  const match = note.match(/full output: (.+)]$/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("tool-output binary and base64 hygiene", () => {
  test("shapeResult replaces NUL-containing text with one line and preserves the full spill", () => {
    const { context } = setup();
    const output = "before\0after";
    const shaped = shapeResult(context, "bash", output);

    expect(shaped.split("\n")).toHaveLength(1);
    expect(shaped).not.toContain("\0");
    expect(readFileSync(spillPath(shaped), "utf8")).toBe(output);
  });

  test("shapeResult spills a base64-like run only when it is longer than 2,000 characters", () => {
    const { context } = setup();
    const boundary = `payload:${"A".repeat(2_000)}`;
    const output = `payload:${"A".repeat(2_001)}`;

    expect(shapeResult(context, "web_fetch", boundary)).toBe(boundary);
    const shaped = shapeResult(context, "web_fetch", output);
    expect(shaped.split("\n")).toHaveLength(1);
    expect(shaped).not.toContain("A".repeat(2_001));
    expect(readFileSync(spillPath(shaped), "utf8")).toBe(output);
  });

  test("read refuses a file with a NUL in the first 8 KiB without injecting its contents", async () => {
    const { callRead, cwd, record } = setup();
    const path = join(cwd, "binary.dat");
    writeFileSync(path, Buffer.concat([
      Buffer.from("safe prefix"),
      Buffer.from([0]),
      Buffer.from("RAW-BINARY-MARKER"),
    ]));

    const result = await callRead(path);
    expect(result).toEqual({ text: "error: binary file", isError: true });
    expect(result.text).not.toContain("RAW-BINARY-MARKER");
    expect(record.read().find((event) => event.t === "tool.call" && event.name === "read")).toMatchObject({
      ok: false,
      excerpt: "error: binary file",
    });
  });

  test("read shaping keeps a NUL beyond the 8 KiB probe out of the model result", async () => {
    const { callRead, cwd } = setup();
    const path = join(cwd, "late-nul.dat");
    writeFileSync(path, Buffer.concat([
      Buffer.alloc(8 * 1024, 0x61),
      Buffer.from([0]),
      Buffer.from("LATE-BINARY-MARKER"),
    ]));

    const result = await callRead(path);
    expect(result.isError).toBe(false);
    expect(result.text.split("\n")).toHaveLength(1);
    expect(result.text).not.toContain("\0");
    expect(result.text).not.toContain("LATE-BINARY-MARKER");
  });
});
