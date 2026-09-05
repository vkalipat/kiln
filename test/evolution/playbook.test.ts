import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaybook } from "../../src/brain/prompts";
import type { PlaybookDelta } from "../../src/build/delta";
import {
  MAX_ACTIVE_BULLETS,
  activeBulletCount,
  applyDelta,
  parsePlaybook,
  playbookHash,
  serializePlaybook,
} from "../../src/evolution/playbook";

const options = { by: "candidate-7", at: "2026-09-05T12:30:00.000Z" };

function delta(patch: Partial<PlaybookDelta>): PlaybookDelta {
  return {
    op: "edit",
    section: "build",
    id: "B1",
    text: "Keep one visible feature per session.",
    why: "It isolates failures.",
    evidence: [],
    ...patch,
  };
}

describe("playbook document", () => {
  test("round-trips the bundled markdown with operator corrections byte-for-byte", () => {
    const md = loadPlaybook(mkdtempSync(join(tmpdir(), "kiln-playbook-")));
    const parsed = parsePlaybook(md);
    expect(serializePlaybook(parsed)).toBe(md);
    expect(parsed.sections.map((section) => section.name)).toEqual(["lenses", "frame", "discover", "ideate", "form", "build"]);
    expect(parsed.sections.flatMap((section) => section.bullets)).toHaveLength(19);
    const corrected = parsed.sections.flatMap((section) => section.bullets).filter((bullet) => ["B1", "B2", "B3", "FM1", "FM2"].includes(bullet.id));
    expect(corrected).toHaveLength(5);
    expect(corrected.every((bullet) => bullet.text.includes("Why:") && bullet.helpful === 0 && bullet.harmful === 0)).toBe(true);
  });

  test("retains line endings and final-newline state", () => {
    const md = "# playbook\r\n\r\n## build\r\n- B1 [helpful:2 harmful:1] Legacy lesson.";
    expect(serializePlaybook(parsePlaybook(md))).toBe(md);
    const edited = applyDelta(md, delta({}), options);
    expect(edited).toBe("# playbook\r\n\r\n## build\r\n- B1 [helpful:2 harmful:1] Keep one visible feature per session. Why: It isolates failures.");
  });

  test("rejects unknown sections, duplicate ids, malformed counters, and wrong prefixes", () => {
    for (const md of [
      "## scout\n",
      "## build\n- B1 lesson\n",
      "## build\n- M1 [helpful:0 harmful:0] Wrong prefix.\n",
      "## build\n- B1 [helpful:0 harmful:0] One.\n- B1 [helpful:0 harmful:0] Two.\n",
    ]) expect(() => parsePlaybook(md)).toThrow();
  });
});

describe("playbook deltas", () => {
  test("add assigns the next never-used section id, including retired ids", () => {
    const md = [
      "# playbook",
      "",
      "## build",
      "- B3 [helpful:4 harmful:1] Active legacy lesson.",
      "",
      "## retired",
      "- B9 [helpful:2 harmful:3] Old lesson. (retired 2026-01-01T00:00:00.000Z by candidate-1)",
      "",
    ].join("\n");
    const result = applyDelta(md, delta({ op: "add", id: "B4", text: "Verify the smallest runnable slice.", why: "Fast feedback limits drift." }), options);
    expect(result).toContain("- B10 [helpful:0 harmful:0] Verify the smallest runnable slice. Why: Fast feedback limits drift.");
    expect(result).not.toContain("- B4 [helpful:0 harmful:0]");
    expect(activeBulletCount(result)).toBe(2);
  });

  test("edit preserves counters by default and resets both only when requested", () => {
    const md = "## build\n- B1 [helpful:12 harmful:3] Legacy lesson.\n";
    const preserved = applyDelta(md, delta({}), options);
    expect(preserved).toContain("- B1 [helpful:12 harmful:3] Keep one visible feature per session. Why: It isolates failures.");
    const reset = applyDelta(md, delta({}), { ...options, resetCounters: true });
    expect(reset).toContain("- B1 [helpful:0 harmful:0] Keep one visible feature per session. Why: It isolates failures.");
  });

  test("retire moves the original line with counters intact and records provenance", () => {
    const md = "# playbook\n\n## build\n- B1 [helpful:12 harmful:3] Legacy lesson.\n";
    const retired = applyDelta(md, delta({ op: "retire", text: "" }), { ...options, resetCounters: true });
    expect(retired).toBe([
      "# playbook",
      "",
      "## build",
      "",
      "## retired",
      "- B1 [helpful:12 harmful:3] Legacy lesson. (retired 2026-09-05T12:30:00.000Z by candidate-7)",
      "",
    ].join("\n"));
    expect(activeBulletCount(retired)).toBe(0);
    expect(parsePlaybook(retired).sections.find((section) => section.name === "retired")?.bullets[0]).toMatchObject({ id: "B1", helpful: 12, harmful: 3 });
  });

  test("retire appends to an existing retired section without disturbing other bytes", () => {
    const md = "## build\n- B1 [helpful:1 harmful:0] Active.\n\n## retired\n- B8 [helpful:0 harmful:2] Earlier. (retired 2026-01-01T00:00:00.000Z by operator)\n";
    const result = applyDelta(md, delta({ op: "retire", text: "" }), options);
    expect(result).toContain("- B8 [helpful:0 harmful:2] Earlier.");
    expect(result).toContain("- B1 [helpful:1 harmful:0] Active. (retired 2026-09-05T12:30:00.000Z by candidate-7)\n");
  });

  test("retire preserves the absence of a final newline", () => {
    const md = "## build\n- B1 [helpful:1 harmful:2] Active.";
    const result = applyDelta(md, delta({ op: "retire", text: "" }), options);
    expect(result.endsWith("\n")).toBe(false);
    expect(result).toEndWith("- B1 [helpful:1 harmful:2] Active. (retired 2026-09-05T12:30:00.000Z by candidate-7)");
  });

  test("refuses an add at the 120-active-bullet limit but always permits a retirement", () => {
    const bullets = Array.from({ length: MAX_ACTIVE_BULLETS }, (_, index) => `- B${index + 1} [helpful:0 harmful:0] Lesson ${index + 1}.`).join("\n");
    const md = `## build\n${bullets}\n`;
    expect(activeBulletCount(md)).toBe(120);
    expect(() => applyDelta(md, delta({ op: "add", id: undefined }), options)).toThrow(/120 active/);
    expect(activeBulletCount(applyDelta(md, delta({ op: "retire", text: "" }), options))).toBe(119);
  });

  test("hash ignores counter changes and observes instruction changes", () => {
    const md = readFileSync(join(import.meta.dir, "../../playbook/playbook.md"), "utf8");
    expect(playbookHash(md.replace("helpful:0 harmful:0", "helpful:91 harmful:7"))).toBe(playbookHash(md));
    expect(playbookHash(md.replace("Invert a shared assumption", "Challenge a shared assumption"))).not.toBe(playbookHash(md));
  });
});
