import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../../src/core/run";
import { projectPaths } from "../../src/formation/paths";
import { archiveBlocked } from "../../src/build/blocked";
import { renderAudit, type Audit } from "../../src/build/audit-contract";

const audit: Audit = {
  featureId: "f02", attempt: 3, checkId: "check-last", sourceEventSeq: 44, createdAt: "2026-09-04T00:00:00.000Z", shape: "full",
  raw: { verified: ["v"], claimedUnverified: ["u"], regressions: ["r"], nextSessionNotes: "next", checkQuality: { adequate: false, reason: "weak" }, verdict: "disagree" },
  model: { provider: "openai", model: "auditor", ref: "openai/auditor" },
};

describe("blocked evidence archive", () => {
  test("atomically preserves check bytes, stored audit, source sequences and hashes", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-blocked-")), "seed");
    const project = projectPaths(run.project);
    mkdirSync(project.checksDir, { recursive: true });
    mkdirSync(project.blockedDir, { recursive: true });
    const checkPath = join(project.checksDir, "evidence.bin");
    const bytes = Buffer.from([0, 255, 10, 13, 42]);
    writeFileSync(checkPath, bytes);
    const manifest = archiveBlocked(run, "f02", { check: { path: checkPath, eventSeq: 41 }, audit });
    expect(manifest.check.present).toBe(true);
    expect(manifest.audit.present).toBe(true);
    expect(manifest.check.sourceEventSeq).toBe(41);
    expect(manifest.audit.sourceEventSeq).toBe(44);
    expect(readFileSync(manifest.check.archivedPath!).equals(bytes)).toBe(true);
    expect(readFileSync(manifest.audit.archivedPath!, "utf8")).toBe(renderAudit(audit));
    expect(manifest.check.sha256).toHaveLength(64);
    expect(manifest.audit.sha256).toHaveLength(64);
    expect(JSON.parse(readFileSync(join(project.blockedDir, "f02", "manifest.json"), "utf8"))).toEqual(manifest);
  });

  test("represents missing evidence explicitly and refuses path-shaped feature ids", () => {
    const run = createRun(mkdtempSync(join(tmpdir(), "kiln-blocked-empty-")), "seed");
    mkdirSync(projectPaths(run.project).blockedDir, { recursive: true });
    const manifest = archiveBlocked(run, "f03", { check: { path: join(run.dir, "absent"), eventSeq: 7 } });
    expect(manifest.check).toMatchObject({ present: false, sourceEventSeq: 7, archivedPath: null, sha256: null });
    expect(manifest.audit).toMatchObject({ present: false, sourceEventSeq: null, archivedPath: null, sha256: null });
    expect(() => archiveBlocked(run, "../escape")).toThrow("invalid blocked feature id");
  });
});
