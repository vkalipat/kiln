# Kiln reference

Start with the [README](../README.md) for installation and capabilities. This reference covers commands, settings, and operating limits.

- [Tasks](#tasks) and [authentication](#authentication)
- [Models and routing](#models-and-routing) and [teams](#teams-and-shared-context)
- [Limits and accounting](#limits-and-accounting)
- [Optional integrations](#optional-integrations)
- [Phase workflows](#phase-workflows) and [assistant plugins](#assistant-plugins)
- [Updates](#updates) and [development](#development)
- [Architecture](architecture.md) and [validation](validation.md)

## Tasks

`kiln` opens the terminal interface. `kiln task` uses the same persistent operator. Opening the interface, a plain greeting, and local readiness checks make no model calls. A greeting that includes a task can start work.

```sh
kiln task "Implement the importer and verify malformed input handling" --cwd . --budget 10 --wall-seconds 900
kiln task new --seed-file ./task.txt --cwd . --json
kiln task resume RUN_ID "Continue the remaining checks"
kiln task steer RUN_ID --seed-file ./direction.txt
kiln task pause RUN_ID
kiln task monitor RUN_ID --json
kiln --run RUN_ID
```

Use these commands for the operation you need. `--seed-file` preserves the exact file contents as the request. `--json` returns a structured report. `--` ends option parsing. Invalid, repeated, incomplete, or inapplicable task options fail before dispatch.

During an active turn, a new message steers that work. After a turn ends, a follow-up continues the same conversation. CLI steering needs an active local owner. Use `resume` for a settled turn. `resume` without a message reports saved state without dispatching more work.

`--cwd DIR` selects the working project. State defaults to `~/.kiln`; `KILN_HOME` or a supported `--home DIR` flag selects another home. Saved tasks retain their directory, models, effort policy, allocations, and usage. A conflicting resume allocation is rejected.

| Terminal control | Action |
| --- | --- |
| Enter | Send the prompt |
| Ctrl+O | Open the command palette |
| Ctrl+S | Change reasoning effort |
| Alt+T | Expand or collapse tool details |
| Esc | Request a pause |
| Ctrl+C | Exit |

`NO_ANIMATION=1 kiln` uses static welcome artwork. The palette includes `task:new`, `task:monitor`, `task:limits`, integration controls, and `mode:auto`. `task:new` creates a fresh native conversation and allocation. `run:new` opens the phase workflow.

The effort dial has automatic and fixed settings. `ultra` maps to stored `xhigh`. Choosing `auto` restores adaptive effort; a fixed choice remains authoritative. The display identifies the main operator's model, separate from worker routes and pending recommendations.

## Authentication

```sh
kiln auth login
kiln auth login anthropic
kiln auth login openai
kiln auth login openai --device
kiln auth login openai --no-browser
kiln auth key openai
kiln auth status --json
kiln auth logout openai
```

Choose subscription sign-in or API-key billing in the login flow. API keys and manual authorization input use masked prompts. For automation, pipe a key from your secret manager to `kiln auth key openai --api-key-stdin`.

Provider environment variables can supply access without copying their values into Kiln's credential file. `auth status` discovers credentials locally. It does not test whether the provider accepts them. `logout all` removes stored credentials; environment variables can still provide access.

The local OAuth return page uses Kiln branding. The terminal confirms connection after token exchange. Provider-hosted consent uses the upstream application's registered identity. Kiln has no separate registered OAuth application.

`kiln doctor --json` checks local dependencies, model compatibility, and credential configuration without network calls. `--require jev,hindsight` makes missing requested integration settings blockers. A ready result does not establish live authentication, entitlement, quota, or service health.

## Models and routing

```sh
kiln model roles --json
kiln model plan "Build a prototype" --json
kiln model routing manual
kiln mode set high
kiln mode show
```

`roles` shows bootstrap and legacy defaults. It does not show the current task team. `plan` previews eligible choices locally; it does not predict a Jev decision. Manual routing uses configured selection. A fixed effort setting affects future work, while saved runs retain their policy.

### Jev selection

```sh
kiln auth key jev
kiln model routing adaptive
kiln mode set auto
```

These settings enable Jev resource selection and automatic effort for new native sessions. Jev chooses among compatible models, supported effort levels, and supplied responsibility alternatives in one call. The shortlist has at most 32 choices. It keeps reviewed models, new catalog family revisions, and price and context alternatives. Reviewed benchmark evidence, task fit, and catalog prices inform selection. Missing quality evidence stays unknown. GPT-6.1 Sol is available through the installed OpenAI API and Codex entries; it supports low, medium, high, xhigh, and max effort. Account access still applies.

One metered request asks separate model and effort questions, plus a role question when needed. Explicit model and effort choices constrain the decision. Selection can change at a human task boundary, an explicit `route_step`, or a new `team_assign`. It stays stable inside tool loops.

Missing or inconclusive Jev retains an eligible current route or uses a recorded conservative fallback. A provider failure does not trigger an automatic model switch. Native teams handle research, idea generation, probes, and review in resource mode. The legacy preset-based `ideate` tool is unavailable in that mode.

Step suggestions are separate from resource selection:

```sh
kiln model suggest "Implement and test the parser" --step implement --json
kiln model suggest "Compare candidate approaches" --step synthesize --jev --json
```

The first command is local. The second sends the supplied summary to TypeSafe. Neither changes or dispatches the main model.

### Benchmark evidence

```sh
kiln model benchmarks show --json
kiln model benchmarks import ./reviewed-benchmarks.json --reviewed
```

Import needs a reviewed structured snapshot with source URLs, dates, and supported categories. Validation checks its shape and admissibility, not the truth of a website's score. The snapshot's maximum age is bounded to 90 days. Expired evidence stops new evidence-based phase plans with a refresh or manual-mode instruction.

A home-imported snapshot overrides bundled evidence for new resource sessions and CLI planning. Resource runs save it in `operator/routing-evidence.json` and reuse it on resume. Updating dependencies does not refresh rankings or rewrite existing runs.

## Teams and shared context

The parent operator plans features with objectives, literal relative file or directory scopes, dependencies, and acceptance criteria. Scope paths use no globs. Workers query the ledger revision, claim ready features, and return artifact hashes with check reports. The ledger rejects stale updates, overlapping active claims, and unmet dependencies.

Only the real parent can plan, accept, or reopen features. Reopening preserves prior handoffs and review history. Mutations return compact receipts with the changed features, revision, and ledger hash. Query for other features or history when needed.

`team_assign` saves an exact model and effort assignment. The native spawn hook checks parent identity, dependencies, contract freshness, and conflicting selectors before applying it. Workers send peer messages through `write` to `agent://<id>`. Results arrive automatically; `wait` handles an owned job or message dependency.

The `team` tool's `review_packet` action returns stable criterion IDs, artifact identity, and worker-declared coverage. Coverage maps each `criterionId` to exact artifacts and zero-based `checkIndices`. Unmapped requirements remain visible. The packet supports up to 64 criteria and mappings, with 64 artifact or check references per mapping.

Worker reports remain unverified claims. Parent acceptance records review and checks artifact identity. Hashes establish which bytes were reported; they do not prove that a command ran or an English requirement passed. The parent must review completeness and run meaningful checks.

`context_publish` and `context_query` share bounded saved evidence with revisions, source information, and hashes. External material and worker messages remain evidence, not new authorization. Team scopes coordinate work; shell and file tools still use local permissions.

## Limits and accounting

```sh
kiln task limits
kiln task limits --budget 100 --wall-seconds 28800
kiln task limits --uncapped
kiln task monitor RUN_ID --json
```

Choose either finite or uncapped defaults. `--uncapped` sets both aggregate allocations to JSON `null`. Individual allocation flags accept positive numbers or `unlimited`; changing one preserves the other. Do not combine those flags with `--uncapped`. A task-specific override does not change defaults.

Finite native allocations control estimated exposure before dispatch. They are not absolute invoice caps. Admitted in-flight work can cross the target. The shared meter reserves possible input, output, and thinking usage, then settles known actual usage. Interrupted or unknown requests retain exposure. Budget denial for a child stops that child while preserving parent work.

Uncapped sessions retain accounting, cancellation, compaction, and loop monitoring. When both allocations are uncapped, new sessions also default to uncapped aggregate Jev allowances. Explicit Jev limits and saved policies remain authoritative. Legacy phase runs and invoked ideation batches retain finite planning targets.

### Capacity bounds

| Component | Current bound |
| --- | --- |
| Native workers | 32 concurrent tasks; recursion depth 2. Generic workers receive a wrap-up notice at 200 requests and a forced partial yield toward 300. Specialized workers can have lower limits. |
| Jev browser and research workflows | Four active workflows; 64 waiting callers in a FIFO queue. Waiting calls can be cancelled. A full queue refuses another caller. |
| Research capture | Six sources by default, maximum 12; up to four concurrent captures and three classification batches. Each source retains at most 12,000 characters. |
| Finite Jev allowance | New runs with a finite aggregate allocation default to 64 calls and 1,000,000 input tokens of estimated exposure. Each request reserves 64,000 possible input tokens. |
| Shared context | 4,096 entries and a 16 MiB document |
| Team ledger | 128 features, 32 historical transitions per feature, and a 2 MiB document |
| Assignment ledger | 1,024 assignments and a 2,000,000-byte document |
| Monitor | 256 session records and 64 notices; evictions remain counted |

Provider quotas, request rates, context windows, output limits, and service access can stop work earlier. Uncapped allocations do not remove these bounds.

### Monitor and storage

The monitor makes no model calls. `compute-monitor.json` stores bounded fingerprints, counters, and usage summaries. `task monitor` returns the latest saved snapshot rather than a continuous stream.

| Signal within one session and turn | Result |
| --- | --- |
| Identical failed tool calls | Warning at 3; pause at 6 |
| Identical successful calls and results | Warning at 4; pause at 8 |
| Recognized polling or status checks | Warning without an automatic repetition pause |
| Serialized context grows at least 50% across three comparisons | Context-growth warning |
| A call cannot be fingerprinted safely | Coverage warning and repetition streak reset |

A new turn resets repetition streaks and retains accumulated usage. The monitor cannot judge semantic progress, task quality, or scientific validity. Missing usage is not zero usage. Serialized bytes are not tokenizer counts.

Accounting appends flushed deltas to `operator-meter.json.jsonl` and periodically checkpoints `operator-meter.json`. Clean close writes another checkpoint. Readers must replay both files through `readOperatorLedger`; the JSON alone can lag during active work. Keep both files when copying a run. Missing, torn, or mismatched history refuses dispatch.

## Optional integrations

### Jev workflows

```sh
kiln auth key jev
kiln integrations jev enable
kiln integrations jev status --json
kiln integrations jev disable
```

Enable or disable changes the default for new sessions without contacting TypeSafe. A nonempty `TYPESAFE_API_KEY` overrides the stored key. `KILN_JEV_WORKFLOWS=1` is an invocation override. `KILN_JEV_WORKFLOWS=0` removes workflow tools, including on resume. `KILN_JEV_ENABLED=0` disables external decisions. These overrides do not erase saved policy.

The shared service pins `jev-1.13.0`, uses a 0.8 confidence threshold, and defaults to a 1,500 ms request timeout. Routing sends bounded summaries and candidate metadata. Browser decisions send task details and observations. Research decisions send captured passages and evidence questions. Only send content you intend that service to receive.

Identical decisions can share one request or reuse a known-usage accepted result. Failures, low confidence, and unknown usage are not cached. The cache has 32 entries and a 256 KiB bound. Usage survives resume; cache contents do not. Unknown usage can exhaust a finite token allowance before its call limit.

#### Browser

`browser_task` is an operator tool, not a shell command. Call it directly outside `eval` on an existing native tab owned by the session. Supply exact permitted labels, literal field values, and one to eight outcome checks.

Supported actions are click, fill, select, scroll, and wait. Checks are `url_equals`, `text_includes`, or `field_equals`. A segment allows eight decisions over 30 seconds. Ambiguous targets, unsupported controls, and uncertain action effects return control without automatic replay. Authentication and recognized consequential controls need native handling.

A `verified` receipt means the supplied fresh checks passed. It retains `quality: specified_checks_only` and `taskQualityValidated: false`. The parent must assess whether those checks establish the requested result.

#### Research

`research_task` accepts a question, required evidence fields, explicit HTTPS URLs, and exact allowed hosts. It can also use up to three search queries. Defaults are six sources, three concurrent fetches, and a 30-second deadline. Maxima are 12 sources, 12 fields, four fetches, and 120 seconds. Inline evidence defaults to 1,800 characters, with a 6,000-character maximum.

Captures retain hashes, URLs, retrieval times, and passage locations. Jev labels support, contradiction, mixed evidence, not-stated, or unknown. Opposing unresolved answers remain unknown with citations retained. `truthVerified` remains false. Failed dynamic-page fetches remain gaps; browser work is a separate call.

Classification plans its chunks before its first Jev request. A 12-source, 12-field plan needs 72 calls and cannot fit a fresh finite 64-call allowance. It returns captured evidence, unknown fields, and a capacity reason without partial classification spend. Preflight does not reserve every future call; simultaneous workflows can still consume capacity.

### Hindsight

Use an existing server and explicit project bank:

```sh
kiln auth key hindsight
kiln memory status --url http://127.0.0.1:8888 --bank example-project
kiln memory retain --file ./verified-project-notes.md --url http://127.0.0.1:8888 --bank example-project
kiln memory recall "Which checks caught regressions?" --url http://127.0.0.1:8888 --bank example-project --max-tokens 2048
```

`KILN_HINDSIGHT_URL` and `KILN_HINDSIGHT_BANK` replace the URL and bank flags. A nonempty `HINDSIGHT_API_KEY` overrides the stored key. HTTPS is required except for loopback HTTP. Saving a key does not create a server or bank.

`status` checks local configuration. `retain` sends the named UTF-8 file, limited to 256 KiB, with its hash and basename. A timeout can leave the outcome unknown; there is no automatic retry. `recall` returns untrusted JSON with service provenance. Neither command automatically injects memory into model turns.

The timeout defaults to 10 seconds and can reach 120 seconds through `--timeout-ms`. Recall defaults to 2,048 tokens, with a 16,384-token maximum. Responses have a 1 MiB limit. Hosting, storage, and service usage remain your responsibility.

## Phase workflows

`kiln run new` uses a separate durable phase pipeline. Its phases are frame, discover, ideate, checkpoint, form, build, and reflect. The frozen plan can omit unnecessary discovery or competitive ideation. Opening a saved phase run preserves its workflow.

```sh
kiln run new "Explore ways to compare household energy use" --through checkpoint
kiln ideas frontier RUN_ID --json
kiln ideas pick RUN_ID IDEA_ID
kiln project form RUN_ID
kiln project build RUN_ID --yes
kiln run resume RUN_ID --through reflect
kiln project audit RUN_ID --json
```

`--through` selects this invocation's endpoint. `--out DIR` selects the formed project's destination. `--single-session` selects the experimental persistent-builder arm. `--reinit` repeats project initialization. Use `run list`, `run show`, and `run record` to inspect saved work; `build pause` requests a build pause.

Formation validates the plan, obtains independent review, and locks the reviewed artifacts. Builds run executable checks and an independent audit of the exact repository bytes. Project-side plans are inspection mirrors; the run record is authoritative. Reflection records a candidate rather than editing the live playbook.

Adaptive phase planning uses dated role evidence and budget projections. It preserves producer/reviewer separation and refuses a complete ideation round that cannot fit. Projections are assumptions, not measured cost or invoice ceilings. Manual choices, evaluator seats, and frozen runs remain authoritative.

For new computational-biology phase plans, an available compatible Astra entry can be a recorded workload preference. This is a selection policy, not benchmark superiority. The Code Mode adapter admits installed Codex entries with the supported Responses API, custom tool mode, and freeform patch contract. Admission follows that contract rather than a single model name.

After a transient discovery outage, inspect the diagnostic and resume when connectivity returns. Kiln preserves completed valid research and does not treat missing research as findings. `run recover-frame RUN_ID` can recover a narrowly supported old frame failure without provider calls. It does not run the next phase.

Inspect changed artifacts before using `kiln project relock RUN_ID --confirm` after an integrity failure. Relocking is explicit; a routine resume does not bypass evidence checks.

Two dated task briefs remain available: [conditional EGFR binder](challenges/prompts/adaptyv-egfr.md) and [Virtual Cell Challenge](challenges/prompts/virtual-cell-2026.md). They are inputs for later user-directed work, not completed results. Their source dates and exact scientific contracts remain in the briefs.

## Assistant plugins

The plugin needs Python 3.10+, Bun, and an installed `kiln` command. Authenticate through Kiln before starting work. Claude Code can load the repository package directly:

```sh
claude --plugin-dir /absolute/path/to/kiln/plugins/kiln
```

Use `/kiln:run` followed by the task or an existing request ID. Codex can install the package from a configured local marketplace. With a marketplace named `personal`, use `codex plugin add kiln@personal`. This describes a local install, not a public marketplace listing.

From the repository root, operate the native engine with the helper:

```sh
python3 plugins/kiln/scripts/kiln_operator.py start --engine native --request-id native-1 --seed-file ./task.txt --cwd . --through turn --confirm-spend
python3 plugins/kiln/scripts/kiln_operator.py status --request-id native-1
python3 plugins/kiln/scripts/kiln_operator.py logs --request-id native-1 --lines 40
python3 plugins/kiln/scripts/kiln_operator.py steer --request-id native-1 --seed-file ./direction.txt
python3 plugins/kiln/scripts/kiln_operator.py pause --request-id native-1
python3 plugins/kiln/scripts/kiln_operator.py resume --request-id native-1 --seed-file ./followup.txt --confirm-spend
```

Start and resume return immediately while the worker and logs persist. Reuse request IDs to avoid duplicate launches. `--home` selects state; `--kiln-bin` selects the executable. Native start accepts the directory and allocation options; resume retains them. Steering accepts at most 32 queued directions, each at most 65,536 bytes. It rejects stale generations and requests without a live local owner.

The helper defaults to `legacy` for existing scripts. Select `--engine legacy --through checkpoint` for a phase run, then explicitly resume through `reflect` for delivery. A completed native turn needs an explicit follow-up file.

Status combines process state, authoritative run state, and endpoint. A stopped legacy checkpoint reports `awaiting_delivery`. A failed run reports `failed`. Native `completed` means its turn ended; `taskQualityValidated` remains false. Inspect the artifacts and checks before declaring the task complete.

The [run skill](../plugins/kiln/skills/run/SKILL.md) contains the assistant's operating instructions. Installation starts no task, bundles no credentials, and changes no parent permissions.

## Updates

After pulling an update, install the locked dependencies and restart Kiln. Do not replace dependencies underneath an active process. New native runs fingerprint admitted model definitions and selected role references. Resume rejects changed API, cost, tool, token, reasoning, or selection metadata. Restore compatible dependencies or start a reviewed new task. Older runs without a fingerprint establish one on first resume.

```sh
kiln model catalog status --json
kiln model catalog check --json
kiln model catalog check --snapshot models.json --json
bun scripts/frontier-update.ts --check
```

`catalog status` inspects installed metadata offline. `catalog check` fetches official upstream metadata, or reads the supplied snapshot. It reports changes without installing code or admitting models. Exit 0 means inspection succeeded, even when findings contain blockers. A local snapshot does not establish upstream freshness.

The [frontier workflow](../.github/workflows/frontier-update.yml) checks the six native packages every six hours. It validates, opens a dependency PR, and merges the exact verified change automatically. Compatible model entries then become available in the updated installation. It does not refresh benchmark rankings or change a running session. Local checkouts still need the locked installation and a restart described above.

Updates use the latest common stable version and exact pins. Validation requires patch-context checks, installation, typecheck, documentation checks, full tests, evaluator verification, and leak checks. Both reviewed OAuth and shell/evaluation patches must survive. Failed gates stop the update. A separate publication job runs no upgraded code. It checks the current base, exact package and lockfile bytes, and PR commit before merging. Repository protections still apply. A prior verified draft can complete without another push; altered PRs and orphaned branches stop the update.

The updater's `--apply` mode requires a clean disposable Actions checkout on an automation branch. Keep this mode out of a working project. Inspect the [updater](../scripts/frontier-update.ts) for its restrictions and artifact verification.

## Development

```sh
bun test
bun run typecheck
bun run docs:check
bun bin/kiln.ts evals verify --home . --json
bun bin/kiln.ts evals leakcheck --home . --json
bun run scripts/stress-kiln.ts all
bun test test/stress
bun run scripts/usecases/autonomous-tooling.ts all
```

The stress matrix and use-case demonstrations use fixture model and network responses. They test software behavior without paid provider calls. Standalone stress runs retain their temporary root in the report; tests remove their own fixtures.

Evaluation seeds, split metadata, and the judge rubric are hash-bound inputs. Their [rubric](../evals/README.md) is part of that contract. Do not rewrite their hashes to hide drift. Paid evaluation commands require an explicit budget. Calibration, effort comparisons, M1/M2, and evolution evaluations are separate workloads, not installation checks.

| Paid operation | Purpose |
| --- | --- |
| `kiln evals calibrate --labels human` | Check judge decisions against human labels; agent labels cannot authorize judge-based promotion |
| `kiln evals effort ROLE` | Compare supported effort levels for an exact role, model, and seating profile |
| `kiln evals m1` | Compare the full loop with declared baseline and model arms |
| `kiln evals m2 --projects N` | Compare fresh and persistent builder sessions on cloned projects |
| `kiln evolve eval CANDIDATE_ID` | Compare a candidate with the champion on development and held-out seeds |
| `kiln evolve apply` | Apply an explicit operator correction after structural validation and a model-backed conflict check |

These operation names need their required options, including evaluation budgets; use `kiln --help` for command syntax. Evaluation progress and reports survive interruption. Held-out seeds require an active evaluation ID. Reflection alone does not promote a candidate. Promotion needs the declared evaluation and calibration evidence.

Preview the static documentation site from the repository root:

```sh
python3 -m http.server 8094 --bind 127.0.0.1 --directory site
```

Check desktop and mobile layouts, the Contents menu, Escape, section links, and command copying. `.github/workflows/docs.yml` publishes `site/` to GitHub Pages when that directory changes on `main`. Keep site commands and links aligned with this reference.

`bun run docs:check --external` also checks external HTTP targets. Blocked or unavailable services remain unverified. See [validation](validation.md) for retained results and their limits.
