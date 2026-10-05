import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { auditCatalog, fetchUpstreamCatalog, installedCatalog, parseCatalog, UPSTREAM_CATALOG_URL } from "../../providers/catalog-audit";
import type { CliDeps, CliIo } from "../main";

export async function catalogCommand(args: string[], flags: Record<string, string | boolean>, io: CliIo, deps: Pick<CliDeps, "fetchImpl"> = {}): Promise<number> {
  const err = io.error ?? io.write;
  if (args.length !== 1 || !["status", "check"].includes(args[0]!) || Object.keys(flags).some(k => !["json", "snapshot"].includes(k)) || (flags.json !== undefined && flags.json !== true) || (flags.snapshot !== undefined && (typeof flags.snapshot !== "string" || args[0] !== "check"))) {
    err("usage: kiln model catalog status|check [--json] [--snapshot PATH]\n"); return 2;
  }
  try {
    const installed = installedCatalog();
    let source: { kind: string; location: string | null; sha256: string; checkedAt: string | null } = { kind: "installed", location: null, sha256: installed.sha256, checkedAt: null };
    let findings = auditCatalog(installed.models, installed.models);
    if (args[0] === "check") {
      if (typeof flags.snapshot === "string") {
        const stat = statSync(flags.snapshot); if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Local catalog must be a regular file at most 32 MiB");
        const bytes = readFileSync(flags.snapshot, "utf8");
        findings = auditCatalog(installed.models, parseCatalog(bytes));
        source = { kind: "local_snapshot_unverified_origin", location: flags.snapshot, sha256: createHash("sha256").update(bytes).digest("hex"), checkedAt: null };
      } else {
        const upstream = await fetchUpstreamCatalog(deps.fetchImpl);
        findings = auditCatalog(installed.models, upstream.models);
        source = { kind: "official_upstream", location: UPSTREAM_CATALOG_URL, sha256: upstream.sha256, checkedAt: upstream.checkedAt };
      }
    }
    const report = { version: 1, advisory: true, runtimeAdmissionChanged: false, installed: { version: installed.version, sha256: installed.sha256, modelCount: installed.models.length }, source,
      freshness: source.kind === "official_upstream" ? "checked_upstream_now" : "upstream_not_checked", upstreamPublishedAt: null,
      limits: ["Metadata checks do not prove provider availability, current pricing, or request compatibility.", "New IDs remain unavailable to Kiln until the pinned catalog/adapter is updated and validated. No automatic runtime admission or live model switch occurs.", "Installed catalog version is not a release date; local snapshots do not establish upstream freshness."],
      summary: { added: findings.filter(f => f.change === "added").length, changed: findings.filter(f => f.change === "changed").length, removed: findings.filter(f => f.change === "removed").length, blocked: findings.filter(f => f.compatibility === "blocked").length }, findings };
    if (flags.json) io.write(JSON.stringify(report, null, 2) + "\n");
    else { io.write(`Catalog ${installed.version}: ${installed.models.length} installed models; ${report.freshness}\n`); io.write(`Added ${report.summary.added}; changed ${report.summary.changed}; removed ${report.summary.removed}; metadata blockers ${report.summary.blocked}.\n`); io.write("Audit only. No models admitted or switched. See docs/README.md#updates; --json includes per-model findings and source hash.\n"); }
    return 0;
  } catch (error) { err(`Catalog audit failed: ${(error as Error).message}\n`); return 2; }
}
