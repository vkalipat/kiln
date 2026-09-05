import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { projectPaths } from "../../src/formation/paths";
import { appendAudit, AUDIT_CAPS_PINNED, AUDIT_CAPS_STORED, pinAudit, readAudits, renderAudit, type Audit } from "../../src/build/audit-contract";

function audit(attempt = 1): Audit {
  const values = Array.from({ length: 10 }, (_, index) => `${index}-${"v".repeat(260)}`);
  return {
    featureId: "f01", attempt, checkId: `check-${attempt}`, sourceEventSeq: attempt * 10,
    createdAt: `2026-09-04T00:00:0${attempt}.000Z`, shape: "full",
    raw: {
      verified: values, claimedUnverified: values, regressions: values,
      nextSessionNotes: "n".repeat(1_500), checkQuality: { adequate: false, reason: "q".repeat(300) }, verdict: "disagree",
    },
    model: { provider: "anthropic", model: "critic", ref: "anthropic/critic", effort: "high" },
  };
}

describe("audit contract", () => {
  test("stored and pinned caps are independent, prefix-only, pure and idempotent", () => {
    const original = audit();
    const before = structuredClone(original);
    const pinned = pinAudit(original);
    expect(original).toEqual(before);
    expect(pinAudit(pinned)).toEqual(pinned);
    expect(pinned.raw.verified).toHaveLength(AUDIT_CAPS_PINNED.items);
    expect(pinned.raw.verified.every((item) => item.length === AUDIT_CAPS_PINNED.itemChars)).toBe(true);
    expect(pinned.raw.nextSessionNotes).toHaveLength(AUDIT_CAPS_PINNED.notesChars);
    expect(pinned.raw.checkQuality.reason).toHaveLength(AUDIT_CAPS_PINNED.reasonChars);
    expect(original.raw.verified[0]!.startsWith(pinned.raw.verified[0]!)).toBe(true);
  });

  test("appends stored payloads while audit.md contains only the latest", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-audits-")), "seed");
    mkdirSync(projectPaths(run.project).dir, { recursive: true });
    const first = appendAudit(run, audit(1));
    appendAudit(run, audit(1)); // exact source replay is idempotent
    const second = appendAudit(run, audit(2));
    const replay = appendAudit(run, audit(1));
    expect(readAudits(run)).toHaveLength(2);
    expect(replay.sourceEventSeq).toBe(second.sourceEventSeq);
    expect(first.raw.verified).toHaveLength(AUDIT_CAPS_STORED.items);
    expect(first.raw.verified.every((item) => item.length === AUDIT_CAPS_STORED.itemChars)).toBe(true);
    const latest = readFileSync(projectPaths(run.project).audit, "utf8");
    expect(latest).toBe(renderAudit(second));
    expect(latest).toContain("Audit f01 attempt 2");
    expect(latest).not.toContain("Audit f01 attempt 1");
  });
});
