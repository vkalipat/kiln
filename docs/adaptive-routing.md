# Adaptive model routing

Adaptive routing performs the model-selection and budget-fit work before a new run starts. It does not make a paid model request or scrape leaderboards as part of planning.

```sh
kiln model routing adaptive
kiln model plan "Find a business idea and build a prototype" --json
kiln run new "Find a business idea and build a prototype"
```

The TUI uses the same run path. In its command palette (`Ctrl+O`), choose `model: adaptive`, `model: manual`, or `model: preview` to preview the current prompt draft. Enable routing once, then submit seeds normally. `kiln model routing manual` restores configured role lists for future runs. Manual mode remains the installation default; existing configurations and evaluator model assignments are not silently migrated.

## What adapts

- Role choices follow task-relevant categories in dated benchmark evidence, constrained by the installed model catalog and available providers. Science, business, and general work need not use the same ranking. Rankings inform choices; they do not prove that a model is a good Kiln judge or that an idea is correct.
- Generator/judge and builder/auditor separation is preserved. When only one provider is usable, different model identities provide a weaker alternative to cross-provider review. Unavailable catalog entries are not invented.
- The planner estimates one complete ideation round, reallocates only the ideation/build shares when needed, and makes the affordable round count explicit. It preserves the total dollar/time targets and per-unit caps. If a complete round cannot fit the allowed allocation, it stops before the first model phase instead of silently increasing spending.
- Allocation aims for 10% headroom over projected ideation cost, retaining a build reserve and checking the configured minimum feature count. These are explicit planning assumptions, not measured costs or a guarantee that a run will finish within its target.
- Adaptive sessions receive runtime evidence guidance even when the home contains an older customized kernel. Guidance distinguishes facts, inferences, and hypotheses and respects which tools each role actually has. It does not grant tools, remove safety restrictions, or replace external checks.

## Stable resumes and inspection

Each adaptive run writes `routing.json` alongside `workflow.json`. It records selected roles, effort, strict decision-tool policy, phase shares, planned rounds, and the planner's report. The run summary includes that report. `kiln run show <id>` lists the file. Interrupted setup without its required plan cannot silently resume with a different configuration.

Resuming, forming, building, or judging that run uses the frozen routing instead of silently adopting a new leaderboard. Changing the home routing mode affects new runs, not frozen runs. Explicit changes to the total budget/time remain available for recovery; frozen estimates describe the original plan and are not measurements of later spending. Runs created before this feature are not retroactively replanned. Evaluator and embedding-provided model seats remain authoritative.

## Refreshing benchmark evidence

Ordinary runs use cached structured evidence. The bundled snapshot records the sources inspected for the [September 8 routing review](model-routing-2026-09-08.md). A fresh rank is not inferred from a model name or release date.

```sh
kiln model benchmarks show --json
kiln model benchmarks import ./reviewed-benchmarks.json --reviewed
```

Import requires a reviewed structured snapshot with source URLs, dates, and supported categories. Validation checks data shape and admissibility, not whether a website's score is truthful. Check source pages and benchmark settings before acknowledging review. New snapshots affect new plans; they do not mutate running sessions. Stale evidence is disclosed and cannot silently select a supposedly current winner.

Expired evidence stops new adaptive plans with a refresh/manual-mode instruction. The snapshot declares its maximum age (bounded to 90 days); ordinary runs do not claim to have rechecked its sources.

This is deliberately not autonomous ingestion of arbitrary leaderboard prose. Sites change formats, benchmark scores may include different harnesses or effort settings, and fetched text is not a trusted configuration. Catalog updates are also separate dependency changes; a benchmark import cannot install code or introduce an unsupported provider.

## Limits

Cost projections are token-count assumptions, not live usage measurements or hard ceilings. Allocation changes also affect phase wall time and can reduce build capacity. Credentials indicate provider availability, not entitlement to every model. Role-list alternatives do not automatically retry failed provider calls. Independent review and evidence prompts reduce opportunities for hallucination but have not established a measured reliability improvement; live task evaluations are still needed.
