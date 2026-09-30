# Adaptive model routing

For native operator sessions (`kiln` or `kiln task`), enable Jev resource selection and automatic effort:

```sh
kiln auth key jev
kiln model routing adaptive
kiln mode set auto
```

Jev selects model, effort and applicable responsibility from compatible choices using the task, reviewed evidence and cost. Legacy role presets do not define this candidate pool. `kiln model plan "Build a prototype" --json` previews the eligible catalog without a paid request; it does not predict the actual Jev selection. Inspect run receipts for that decision. See [Jev resource routing](jev-resource-routing.md) for task boundaries, explicit pins and fallback behavior.

## Explicit phase workflow planning

The remainder of this section describes `kiln run new` and its frozen phase plan. This workflow remains available separately from the persistent native operator.

Adaptive routing performs the model-selection and budget-fit work before a new run starts. It does not make a paid model request or scrape leaderboards as part of planning.

```sh
kiln model routing adaptive
kiln run new "Find a business idea and build a prototype"
```

Bare `kiln` starts the native operator, not this phase workflow. Existing configurations and evaluator model assignments are not silently migrated. `kiln model routing manual` disables native Jev resource routing and restores configured role selection for future explicit phase runs.

### What adapts in phase workflows

- Role choices follow task-relevant categories in dated benchmark evidence, constrained by the installed model catalog and available providers. Science, business, and general work need not use the same ranking. Rankings inform choices; they do not prove that a model is a good Kiln judge or that an idea is correct.
- Generator/judge and builder/auditor model separation is preserved. Quality ranks before vendor diversity: an independently scored stronger model is preferred even from the same vendor, with correlated-error risk disclosed. Different vendors break score ties. Unavailable catalog entries are not invented.
- The planner estimates one complete ideation round, reallocates only the ideation/build shares when needed, and makes the affordable round count explicit. It preserves the total dollar/time targets and per-unit caps. If a complete round cannot fit the allowed allocation, it stops before the first model phase instead of silently increasing spending.
- Allocation aims for 10% headroom over projected ideation cost, retaining a build reserve and checking the configured minimum feature count. These are explicit planning assumptions, not measured costs or a guarantee that a run will finish within its target.
- Adaptive sessions receive runtime evidence guidance even when the home contains an older customized kernel. Guidance distinguishes facts, inferences, and hypotheses and respects which tools each role actually has. It does not grant tools, remove safety restrictions, or replace external checks.

### Phase-workflow computational biology preference

New adaptive runs apply a prospective workload preference when the request contains high-signal computational biology terms such as VirtualCell, Perturb-seq, single-cell analysis, bioinformatics, GFP, or protein binding. Generic spreadsheet cells, unit-cell physics, phones, and ordinary business work do not trigger it.

When the exact supported model and provider are available, the preference seats `openai-codex/gpt-6-astra` for the brain, generator, builder, prober, and reflector. Judges, critics, auditors, scouts, and arbiters still follow the existing role rankings and producer/reviewer identity constraints. The report labels these producer choices `workload_preference` and its overall selection policy `quality_first_with_workload_preference`. This is a user and workload preference, not evidence that Astra leads a biology benchmark.

If Astra or its provider is unavailable, the normal evidence-ranked and configured choices remain in place. `routing.json` records `unavailable`, the reason, and the producing-role fallbacks that were actually selected. Kiln does not claim Astra was used and does not add an automatic retry after a refusal or provider error.

Code Mode support is deliberately narrow. Kiln admits only the exact installed Astra catalog entry recognized by its host adapter, including the expected OpenAI Codex Responses transport and freeform apply-patch dialect. The model receives one custom executor backed by an isolated QuickJS cell. That cell can call only the Kiln tools currently offered to its role; arguments still pass each tool's schema, calls remain serial and recorded, and CPU, memory, wall-time, call, source, result, and output limits apply. Other Code Mode models remain ineligible.

This policy runs only during planning for a new adaptive session. Manual configurations, evaluator seats, embedded model overrides, and already frozen runs are not rewritten.

### Effort controls

`kiln mode set low|medium|high|xhigh` pins effort for future sessions. `kiln mode set auto` enables adaptive effort for Jev resource routing and restores the legacy role effort map used by phase workflows. It does not enable resource routing by itself; use both setup commands above. Model lists, budgets, provider settings and frozen runs are preserved. Add `--json` to inspect the policy and fallback map.

## Phase-workflow resumes and inspection

Each adaptive run writes `routing.json` alongside `workflow.json`. It records selected roles, effort, strict decision-tool policy, phase shares, planned rounds, and the planner's report. New reports include per-role category, metric, source, score (or an explicit unscored fallback), review counterpart, and selection explanation. These are inspectable decision criteria, not hidden model reasoning. The run summary includes that report. `kiln run show <id>` lists the file. Interrupted setup without its required plan cannot silently resume with a different configuration.

Resuming, forming, building, or judging that run uses the frozen routing instead of silently adopting a new leaderboard. Changing the home routing mode affects new runs, not frozen runs. Explicit changes to the total budget/time remain available for recovery; frozen estimates describe the original plan and are not measurements of later spending. Runs created before this feature are not retroactively replanned. Evaluator and embedding-provided model seats remain authoritative.

## Refreshing benchmark evidence

Ordinary runs use cached structured evidence. The bundled snapshot records the sources inspected for the [September 28 review of all six categories](model-routing-2026-09-28.md). The comparison prefers xhigh variants and labels exceptions. Entries preserve benchmark effort and conditions, and plans explicitly disclose tied point scores, excluded models, Code Mode models without the exact supported adapter, and effort mismatches. A fresh rank is not inferred from a model name or release date.

```sh
kiln model benchmarks show --json
kiln model benchmarks import ./reviewed-benchmarks.json --reviewed
```

Import requires a reviewed structured snapshot with source URLs, dates, and supported categories. Validation checks data shape and admissibility, not whether a website's score is truthful. Check source pages and benchmark settings before acknowledging review. New snapshots affect new plans; they do not mutate running sessions. Stale evidence is disclosed and cannot silently select a supposedly current winner.

A home-imported snapshot overrides the bundle for CLI planning and new native resource-routing sessions. Updating source code alone does not refresh that override. New resource runs save their evidence in `operator/routing-evidence.json` and reuse it on resume. Legacy native routing uses the bundle. Restart and begin a new session after reviewing an update; existing runs preserve their saved policy and evidence. The six-hour dependency updater does not refresh benchmark rankings.

Expired evidence stops new evidence-based adaptive plans with a refresh/manual-mode instruction. The snapshot declares its maximum age (bounded to 90 days); ordinary runs do not claim to have rechecked its sources.

This is deliberately not autonomous ingestion of arbitrary leaderboard prose. Sites change formats, benchmark scores may include different harnesses or effort settings, and fetched text is not a trusted configuration. Catalog updates are also separate dependency changes; a benchmark import cannot install code or introduce an unsupported provider.

## Limits

Cost projections are token-count assumptions, not live usage measurements or hard ceilings. Allocation changes also affect phase wall time and can reduce build capacity. Credentials indicate provider availability, not entitlement to every model. Role-list alternatives do not automatically retry failed provider calls. Independent review and evidence prompts reduce opportunities for hallucination but have not established a measured reliability improvement; live task evaluations are still needed.
