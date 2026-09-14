import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { projectPaths } from "../../src/formation/paths";
import { appendAudit, auditEvidenceComplete, AUDIT_CAPS_PINNED, AUDIT_CAPS_STORED, pinAudit, readAudits, renderAudit, type Audit } from "../../src/build/audit-contract";

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
  test("full evidence is redacted, hash checked, and never inferred from legacy or pinned summaries", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-audits-full-")), "seed");
    mkdirSync(projectPaths(run.project).dir, { recursive: true });
    const original = audit();
    const secret = "sk-1234567890abcdefghijklmnop";
    original.raw.regressions = [...original.raw.regressions, `Credential accidentally reported: ${secret}`];
    original.evidence = { version: 2, complete: true, payloadHash: "computed on persistence", scopeHash: "frozen-scope" };
    const stored = appendAudit(run, original);
    expect(auditEvidenceComplete(stored)).toBe(true);
    expect(auditEvidenceComplete(readAudits(run)[0]!)).toBe(true);
    expect(readFileSync(run.audits, "utf8")).not.toContain(secret);
    expect(stored.raw.regressions.at(-1)).toContain("[REDACTED]");
    expect(stored.raw.verified).toEqual(original.raw.verified);
    expect(auditEvidenceComplete(pinAudit(stored))).toBe(false);
    expect(auditEvidenceComplete(audit())).toBe(false);
    writeFileSync(run.audits, readFileSync(run.audits, "utf8").replace("0-vvv", "tampered"));
    expect(() => readAudits(run)).toThrow("evidence hash or provenance mismatch");
  });
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
    expect(first.raw).toEqual(audit(1).raw);
    const latest = readFileSync(projectPaths(run.project).audit, "utf8");
    expect(latest).toBe(renderAudit(second));
    expect(latest).toContain("Audit f01 attempt 2");
    expect(latest).not.toContain("Audit f01 attempt 1");
  });

  test("ignores only a torn final append and rejects terminated or interior corruption", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-audits-corrupt-")), "seed");
    const first = JSON.stringify(audit(1));
    const second = JSON.stringify(audit(2));

    writeFileSync(run.audits, `${first}\n{torn`);
    expect(readAudits(run)).toHaveLength(1);
    appendAudit(run, audit(2));
    expect(readAudits(run).map((item) => item.attempt)).toEqual([1, 2]);
    expect(readFileSync(run.audits, "utf8")).not.toContain("{torn");
    writeFileSync(run.audits, `${first}\n{bad\n`);
    expect(() => readAudits(run)).toThrow("malformed audits.jsonl line 2");
    writeFileSync(run.audits, `${first}\n{bad\n${second}\n`);
    expect(() => readAudits(run)).toThrow("malformed audits.jsonl line 2");
  });

  test("refuses a symlinked audit journal without changing its target", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-audits-link-")), "seed");
    const outside = join(mkdtempSync(join(tmpdir(), "kiln-audits-outside-")), "outside.jsonl");
    writeFileSync(outside, "sentinel\n");
    symlinkSync(outside, run.audits);

    expect(() => appendAudit(run, audit(1))).toThrow("audits.jsonl must be a regular file");
    expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
  });
});
