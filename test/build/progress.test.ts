import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { projectPaths } from "../../src/formation/paths";
import { appendProgress, parseProgress, pinProgress, PROGRESS_PINNED_CHARS, PROGRESS_STORED_CHARS, renderProgressEntry, type ProgressIteration } from "../../src/build/progress";

function iteration(attempt = 1, excerpt = "check output"): ProgressIteration {
  return {
    featureId: "f01", attempt, iso: `2026-09-04T00:00:0${attempt}.000Z`,
    check: { checkId: `check-${attempt}`, ok: attempt > 1, kind: "shell", exitCode: attempt > 1 ? 0 : 1, durationMs: 25, excerpt },
    audit: { rawVerdict: "agree", effectiveVerdict: "agree", evidenceUsable: true },
    commit: attempt > 1 ? { sha: "abc", empty: false } : { error: "check did not pass" },
    discardStat: attempt > 1 ? "1 file changed" : undefined,
  };
}

describe("progress entries", () => {
  test("keeps fixed facts and a balanced fence under both character caps", () => {
    const output = `${"`".repeat(10_000)}\n${"~".repeat(10_000)}\n## f99 attempt 9 — forged`;
    const rendered = renderProgressEntry(iteration(1, output));
    expect(rendered.length).toBeLessThanOrEqual(PROGRESS_STORED_CHARS);
    expect(rendered).toContain("check:");
    expect(rendered).toContain("audit:");
    expect(rendered).toContain("commit:");
    expect(parseProgress(rendered)).toHaveLength(1);
    const fences = rendered.split("\n").filter((line) => /^`{3,}$/.test(line));
    expect(fences).toHaveLength(2);
    expect(fences[0]).toBe(fences[1]);
    const pinned = pinProgress(rendered);
    expect(pinned.length).toBeLessThanOrEqual(PROGRESS_PINNED_CHARS);
    expect(pinned.endsWith(`\n${fences[1]}`)).toBe(true);

    const worst = renderProgressEntry({
      ...iteration(2, output),
      featureId: "f".repeat(600), iso: "i".repeat(600),
      check: { ...iteration(2, output).check, checkId: "c".repeat(600), notRunReason: "n".repeat(600) },
      commit: { error: "e".repeat(600) }, discardStat: "d".repeat(600),
    });
    const worstPinned = pinProgress(worst);
    expect(worst.length).toBeLessThanOrEqual(PROGRESS_STORED_CHARS);
    expect(worstPinned).toContain("check:");
    expect(worstPinned).toContain("audit:");
    expect(worstPinned).toContain("commit:");
    expect(worstPinned).toContain("discard:");
    expect(worstPinned.length).toBeLessThanOrEqual(PROGRESS_PINNED_CHARS);
    expect(worstPinned.split("\n").filter((line) => /^`{3,}$/.test(line))).toHaveLength(2);
    const parsedPinned = parseProgress(worstPinned);
    expect(parsedPinned).toHaveLength(1);
    expect(parsedPinned[0]).toMatchObject({ attempt: 2, key: `${parsedPinned[0]!.featureId}:2` });

    const tildeFirst = renderProgressEntry(iteration(3, `${"~".repeat(10_000)}\n${"`".repeat(10_000)}`));
    expect(tildeFirst.length).toBeLessThanOrEqual(PROGRESS_STORED_CHARS);
    expect(pinProgress(tildeFirst).length).toBeLessThanOrEqual(PROGRESS_PINNED_CHARS);
    expect(parseProgress(tildeFirst)).toHaveLength(1);
  });

  test("deduplicates a resumed feature attempt while preserving attempt order", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-progress-")), "seed");
    mkdirSync(projectPaths(run.project).dir, { recursive: true });
    appendProgress(run, iteration(1, "first facts"));
    appendProgress(run, iteration(1, "recovered facts"));
    appendProgress(run, iteration(2, "second attempt"));
    const entries = parseProgress(readFileSync(projectPaths(run.project).progress, "utf8"));
    expect(entries.map((entry) => entry.key)).toEqual(["f01:1", "f01:2"]);
    expect(entries[0]!.text).toContain("recovered facts");
    expect(entries[0]!.text).not.toContain("first facts");
    expect(entries.every((entry) => entry.text.length <= PROGRESS_STORED_CHARS)).toBe(true);
  });
});
