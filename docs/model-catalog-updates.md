# Model catalog updates

`kiln model catalog status --json` inspects the installed catalog without network access or initializing a Kiln home. It reports the pinned package version, model count, snapshot hash, and conservative per-model metadata checks. A package version is not a release date: status explicitly reports `upstream_not_checked`.

`kiln model catalog check --json` fetches the official [oh-my-pi catalog](https://github.com/can1357/oh-my-pi/tree/main/packages/catalog) and reports added, changed, and removed models against the installed catalog. The request is a public metadata GET with a deadline and response-size bound. It sends no prompts, credentials, configuration, or usage. `checkedAt` is this check's time, not the publication time of every model. It does not prove account availability or a provider's current pricing. Redirects fail closed.

For offline reproducibility, save the upstream JSON and use `kiln model catalog check --snapshot models.json --json`. The report labels local input `local_snapshot_unverified_origin`; a local snapshot cannot establish upstream freshness. Capture JSON reports in CI as review artifacts. `check` exits 0 when inspection succeeds, even when compatibility findings require review; network/format/usage errors exit 2. Automation must inspect `summary` and individual `findings`, not interpret exit 0 as model admission.

The compatibility audit checks the pinned transport APIs, Kiln's tool contract, cost metadata including long-context tiers, token limits, and known reasoning efforts. Missing tool metadata remains a review blocker instead of proof of compatibility. `metadata_checks_passed` means these static checks passed; it is not a provider smoke test, performance evaluation, or runtime admission. Unknown tool dialects and APIs fail closed. The existing custom-tool adapter remains scoped to its verified Codex dialect.

## Admission and ongoing maintenance

**This command audits updates; it does not install them or admit new IDs.** Kiln presently resolves models from the bundled catalog in role routing, operator model selection, and cost metering. The native SDK provides dynamic discovery (`createModelManager` and `ModelRegistry.refresh`), but refreshing that separate registry alone would leave Kiln's admission and costing inconsistent. No background discovery is wired into a running task by this command.

The [scheduled frontier update workflow](frontier-updates.md) prepares reviewable dependency/catalog changes. The update path is:

1. Check upstream catalog metadata and native package versions; record exact source hashes and versions.
2. Prepare a branch updating the related native packages together to exact versions. Preserve and reapply tracked patches, including the optional OAuth branding hook; a patch conflict blocks the update.
3. Run type checking, tests (including OAuth callback and tool-contract cases), evaluation verification, and leak checks. Review changed API/tool/cost/effort metadata. Do not silently import new benchmark rankings or change role assignments.
4. Merge only the validated update. New tasks can then explicitly select newly supported model IDs. Existing running processes retain their installed code; do not upgrade dependencies underneath active processes. New operator runs fingerprint their admitted model definitions and selected role refs. Resume rejects changed API, price, tool, token, reasoning or selection metadata before dispatch; use the original dependencies or start a reviewed new run. Older runs without this fingerprint establish a baseline on first resume.

Provider catalog availability, benchmark evidence, and configured role selection are distinct. A newly advertised model does not become a preferred model automatically. Dynamic additive admission and replay from a complete per-run catalog snapshot are future work; the current fingerprint detects drift but does not reconstruct old model definitions.
