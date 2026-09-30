# Challenge prompts

Use one fresh Kiln session in each challenge's existing working directory:

- [Anthropic × Adaptyv: conditional EGFR binder](adaptyv-egfr.md)
- [Virtual Cell Challenge 2026](virtual-cell-2026.md)

Paste the corresponding Markdown into the TUI, or supply the file directly:

```sh
kiln task --seed-file /absolute/path/to/kiln/docs/challenges/prompts/adaptyv-egfr.md
```

For the other session, use `virtual-cell-2026.md`. The command uses the current directory unless you supply `--cwd DIR`. Running it starts the workload; reading these files does not. Credentials belong in the relevant provider's authentication flow, never in the prompt.

The briefs define outcomes, evidence requirements and completion conditions while leaving methods and team composition flexible. Enable Jev resource selection and automatic effort before starting fresh sessions:

```sh
kiln model routing adaptive
kiln mode set auto
```

Configure Jev with `kiln auth key jev` if needed. The operator proposes task-specific responsibilities and acceptance criteria; Jev selects among compatible role/model/effort alternatives using the task, reviewed evidence and compute cost. Smaller models and lower effort remain eligible. Scientific prediction models are separate tools. Competition-specific facts are dated starting points to verify at execution time.

`kiln model roles` shows legacy defaults, not the team assigned to these tasks. Inspect routing and team-assignment receipts for actual selections and fallback sources. An explicit model or fixed effort remains authoritative. Existing sessions retain their saved policy; neither adaptive routing nor a newer prompt upgrades the installed catalog or refreshes benchmark evidence. See [Jev resource routing](../../jev-resource-routing.md).

Both briefs end with local packages ready for review. They do not authorize competition submission or publication. Account readiness, tool entitlement and successful scientific execution must be established during the run; configuration checks alone do not establish them.
