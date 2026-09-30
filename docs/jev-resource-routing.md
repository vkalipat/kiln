# Jev resource routing

Jev selects resources for the current task from compatible model and supported effort options. The planner supplies the work description and, for teams, bounded responsibility alternatives with goals and acceptance criteria. Jev chooses an assignment; the selected reasoning model does the work.

```sh
kiln auth key jev
kiln model routing adaptive
kiln mode set auto
```

These settings apply to new native sessions. `routing.resources = "jev"` enables resource selection; automatic effort lets the selector use lower effort when appropriate. An explicit model or fixed effort remains a constraint. Existing sessions retain their saved policy.

## Selection

Candidates come from the configured providers’ compatible catalog, including smaller models outside legacy role presets. The shortlist retains reviewed models, the cheapest unreviewed option per provider and explicit/current choices, with duplicate vendor/model aliases removed. Reviewed benchmark evidence, task fit and published cost inform selection; missing quality evidence stays unknown. Known first-party Anthropic retirements are excluded. Catalog presence and configured credentials do not prove live provider entitlement.

One metered, cached Jev request asks separate model and effort questions, plus a role question when alternatives exist. All required answers must meet the confidence policy. The effort choices are light, balanced and deep: Kiln maps these to the selected model’s lowest supported effort, medium or its middle supported level, and the recorded benchmark effort or highest supported level, respectively. These mappings do not imply equal quality across models; nonreasoning models have no adjustable reasoning budget. Explicit effort remains fixed.

The selector can reconsider a route at a human task boundary, an explicit `route_step` request or a new `team_assign` assignment. Routes remain stable through tool loops, avoiding repeated classification and model switching after every tool result.

Missing or inconclusive Jev retains an eligible current route or uses a conservative reviewed fallback. Receipts distinguish Jev selection from fallback and record usage. A classifier’s confidence does not establish scientific correctness or guarantee that the cheapest option meets the task’s quality needs. Review actual outputs and checks.

Legacy role presets remain for older workflows and compatibility; they do not define the resource-mode candidate pool or impose a team roster. Native task teams perform research, idea generation, probes and review in this mode; the legacy preset-driven `ideate` tool is unavailable.

## Existing implementation patterns

Kiln follows the small classifier-before-dispatch pattern already used in public Jev routers:

- [dirien/jev-router](https://github.com/dirien/jev-router/blob/main/src/router.mjs) demonstrates routing in front of model execution.
- [satviksinha/jev-model-router](https://github.com/satviksinha/jev-model-router/blob/main/hooks/jev.ts) demonstrates integrating a routing decision at a harness hook.
- [nyattoh/model-effort-router](https://github.com/nyattoh/model-effort-router/blob/main/src/model_effort_router/router.py) demonstrates considering model and effort together.

These are design references, not runtime dependencies or copied implementations. Kiln uses its existing native dispatch, compatible catalog, Jev service and accounting rather than adding a proxy or orchestration framework.

Catalog and benchmark updates remain explicit. No representative throughput, cost or quality improvement is claimed without a paired evaluation on the intended tasks. Selection receipts and output checks provide the evidence needed to run that comparison.

A [September 30 routing qualification](testing/2026-09-30-jev-resource-routing.json) selected Haiku 4.5 at minimal effort for a routine formatting fixture. Two harder fixtures used labeled Opus 5.5/xhigh fallbacks because classification confidence was insufficient. The report preserves all nine classification calls across three attempts; no selected model or user workload was executed. This verifies a cheaper selection and conservative fallback behavior, not task quality or a throughput gain.
