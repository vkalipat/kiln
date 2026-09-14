# Kiln

Kiln is a local, terminal-first agent harness for researching ideas and delivering verified work. Give it a task and it chooses a workflow, assigns compatible models from your connected providers, and saves the work as an inspectable run.

It is built around two practical problems:

- Agents lose requirements and evidence between handoffs. Kiln keeps the original request, frozen contracts, source-backed research, checks, and audits on disk.
- Different tasks need different amounts of orchestration. A clear implementation request skips competitive ideation. An open search gets research, parallel idea generation, evidence checks, probes, and comparison before anything is selected.

Kiln is under active development. Its delivery path has small live qualifications; the full ideation path has not yet completed a live quality qualification.

## Quick start

Kiln requires [Bun](https://bun.sh/) 1.3.14 or newer and Git.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install
bun link
kiln
```

Bare `kiln` opens the TUI. Type a task and press Enter. Kiln retains the prompt while you connect a provider, so onboarding does not discard your work. Launching the TUI, opening menus, and entering local greetings do not make model requests.

Inside the TUI, use `/login`. Or connect a Claude or ChatGPT subscription through OAuth:

```sh
kiln auth login anthropic
kiln auth login openai
kiln auth status
```

API keys also work through a masked prompt (`kiln auth key anthropic` or `kiln auth key openai`) or the provider environment variables.

Update a source installation with `git pull --ff-only && bun install && bun link`.

Without a global link, use `bun run kiln`. Kiln stores its configuration and runs under `~/.kiln` by default. Set `KILN_HOME` or pass `--home DIR` to use another existing home.

## Run a task

The TUI shows the current phase, activity, cost, and output. `Ctrl+O` opens the command palette, `Ctrl+S` changes effort, `Alt+T` expands tool details, and `Esc` requests a saved pause.

The CLI uses the same run path:

```sh
kiln model plan "Find a practical GFP minibinder research direction" --json
kiln run new "Find a practical GFP minibinder research direction" --through checkpoint
kiln run new "Build a local CSV validation CLI with tests" --through reflect --yes
kiln run show RUN_ID
kiln run record RUN_ID
kiln run resume RUN_ID --through reflect
```

An explicit delivery request normally runs autonomously through build and reflection. An exploration request stops at the idea checkpoint for a choice. Use `--interactive` to require human checkpoints or `--autonomous` to continue at eligible checkpoints. `--through` sets the endpoint for that invocation without rewriting the frozen workflow.

## How the workflow adapts

| Request | Default route | What Kiln avoids |
| --- | --- | --- |
| Open-ended idea search | frame, discover, ideate, checkpoint | Prematurely building the first familiar idea |
| Supplied concept that needs investigation | frame, targeted discovery, focused ideation, checkpoint | Replacing the user's concept with an unrelated one |
| Clear local implementation with no research need | deterministic frame, form, build, reflect | A framing model call and competitive ideation |
| Existing artifact without readable source | bounded planning and human checkpoint | Pretending it inspected or changed the artifact |

The phase chain is `frame`, `discover`, `ideate`, `checkpoint`, `form`, `build`, and `reflect`. The frozen `workflow.json` records which phases apply and why.

### Research and ideation

Discovery sends bounded questions to parallel scouts and records source URLs with each scout's findings. Failed searches do not prove that evidence is absent. Coverage must be assessed before prior art can be marked not falsified.

Ideation uses separate lens and mutation islands, then checks retained candidates for prior art and feasible tests. Executable probes are used when the claim can be tested safely and locally. Probes receive the selector's exact assignment and must distinguish a precondition check from an end-to-end test; unavailable inputs are not permission to substitute a toy success. A refused optional probe rejects that candidate without retrying the refused request or discarding unrelated candidates. Kiln provides no wet-lab or clinical execution authority or validation.

Tournament pairs are judged in both presentation orders. The comparison graph preserves a configured minimum number of comparisons per entrant before the frontier is published. Adaptive sizing reduces candidate breadth when a complete evidence and comparison round would not fit the planning allocation.

### Context between agents

Workers do not share hidden model state. They exchange durable artifacts and bounded handoffs:

- the exact original request and frozen workflow remain authoritative;
- research packets carry findings, provenance, fingerprints, and explicit gaps;
- selected dossiers are included directly when they fit and referenced by path and hash when they do not;
- full check and audit output stays on disk even when a later prompt receives a compact view.

Completed compatible research can survive an interrupted reviewer or synthesis step. Resume reuses it without replaying scouts, but stale, failed, or coverage-inadequate caches cannot become approvals.

### Formation, build, and audit

Formation turns the selected task into `spec.md`, `features.json`, and `acceptance.lock`. An independent critic reviews the exact artifact bytes. On the optimized direct route, a clean first review can freeze them immediately; a requested correction must be applied and reviewed again.

Features are planned around independently useful behavior, with their corresponding tests and documentation included. A small utility should not require separate builder/auditor cycles merely because its code, tests, and README live in different files. Larger independent behaviors can still be split.

On that direct route, the builder receives the original request in a stable quoted context plus its current feature scope. Each feature has executable acceptance checks where the behavior is machine-verifiable. Kiln records Git evidence, check output, progress, and append-only state.

An independent auditor reviews a detached copy of the exact repository snapshot and the complete frozen feature scope. Missing or unusable audit evidence cannot approve a feature. Resume keeps prior attempts, spending, elapsed time, and accepted artifacts.

## Models, effort, and budgets

Fresh homes enable adaptive routing and autonomous selection. Planning itself makes no provider request. It uses a dated, operator-reviewed benchmark snapshot, then filters candidates by connected provider, installed catalog entry, text and tool support, transport, pricing, and producer/reviewer separation.

Quality rank comes before vendor diversity. Same-vendor reviewers are allowed when they are the strongest eligible independent model, and the plan records the correlated-error warning. The chosen roles, alternatives, effective effort, budget shares, ideation dimensions, and decision-tool policy are frozen in `routing.json`. Resume does not silently adopt a later leaderboard or config change.

For computational biology and Virtual Cell tasks, new adaptive runs prefer `openai-codex/gpt-6-astra` for producing roles when connected; independent reviewers retain their ranked seats. This is an explicit workload preference, not a biology benchmark victory. Astra uses a tested, bounded QuickJS Code Mode adapter over the same role-specific tools, validation, context, cancellation, and journal. Missing access is disclosed; refused requests are not retried on another model.

```sh
kiln model roles
kiln model routing adaptive
kiln model routing manual
kiln model benchmarks show --json
kiln mode set auto
kiln mode set xhigh
```

`xhigh` is displayed as `ultra` in the TUI. It requests the highest configured reasoning effort supported by each seat; it does not automatically swap a frozen run to a newer model. See [adaptive routing](docs/adaptive-routing.md) for eligibility, evidence refresh, and budget fitting.

`auto` restores role-based defaults: high for planning/building/critique, medium for generation/judging/audit/reflection, and low for retrieval/probes/arbitration. Compatible measured effort settings still take precedence. Explicit effort levels apply to every role; new defaults do not rewrite existing runs.

Run dollar allocations are planning targets, not hard invoice ceilings or completion guarantees: an admitted provider turn may finish above its target. Turn limits and phase deadlines remain enforced; wall limits differ by phase, with some checked at work-unit boundaries. Cost estimates depend on assumed token counts and latency. Model benchmark rank, tool availability, and Kiln's full-program quality are separate questions.

## What is default and what is opt-in

| Behavior | Setting |
| --- | --- |
| Adaptive workflow and model routing in a fresh home | Default |
| Autonomous continuation for explicit delivery | Default; use `--interactive` to stop at checkpoints |
| Prompt caching when the provider supports it | Default |
| Manual model lists | Opt in with `kiln model routing manual` |
| Bare ideation baseline | Opt in with `--bare` |
| Persistent single-session builder experiment | Opt in with `--single-session` |
| Paid evaluations and playbook promotion | Explicit commands, budgets, and gates required |
| Codex or Claude Code operator plugin | Separate local installation |

Reflection always writes a digest and may propose a playbook delta. It does not modify the live playbook. Promotion requires separate evaluation, integrity checks, and an eligible result. This is gated configuration improvement, not automatic self-modification.

## Inspect, watch, and recover

```sh
kiln run list
kiln run show RUN_ID
kiln project status RUN_ID --json
kiln project audit RUN_ID --json
kiln build pause RUN_ID
kiln run resume RUN_ID
```

The [Kiln operator plugin](plugins/kiln/README.md) lets Codex or Claude Code launch, watch, pause, and resume the same durable run. Stable request IDs prevent duplicate launches. It does not create worktrees, bundle credentials, or start paid work merely by being installed.

Detailed recovery rules, auth variants, TUI controls, and evaluation commands are in the [usage guide](docs/usage.md). The [design index](docs/design/README.md) links the original records and later corrections.

## Artifacts

A run directory contains ordinary files that can be inspected without Kiln:

| Artifact | Purpose |
| --- | --- |
| `seed.md`, `workflow.json`, `routing.json` | Original request and frozen execution choices |
| `brief.md`, `landscape.md`, `discovery/` | Framing and source-backed research |
| `ideas/`, `probes/`, `tournament.jsonl`, `frontier.json` | Candidate dossiers, checks, comparisons, and shortlist |
| `features.json`, `acceptance.lock`, `state.jsonl`, `audits.jsonl` | Frozen build contract and verification history |
| `record.jsonl`, `status.json`, `metrics.json` | Event journal, resumable state, usage, and cost |
| `project/` and `reflect/` | Delivered repository and proposed learning digest |

## Evidence and limits

One live CSV delivery completed 16 of 16 independent behavioral checks, produced 14 generated tests, and ended with a usable independent audit at $4.47223725 recorded usage. Its simple tool-using baseline hit a per-call output limit and delivered no artifact. A separate CLI recovery completed 7 of 7 external checks with 11 generated tests.

These are small development qualifications, not broad benchmark wins. The CSV baseline's output limit is a material condition. Provider-free tests also show that direct tasks remove one framing invocation and one redundant clean-review cycle while retaining correction and re-review, but those counts are not measured provider latency or cost.

A live VCC-related **JSON validation utility** passed the same 20 external checks before and after cohesive-feature planning. Requests fell from 37 to 19, total reported token counters (including caches) from 526,124 to 228,082, estimated cost from $4.85 to $2.06, and native time from 16.3 to 5.5 minutes. Both runs retained critique, revision, independent audit, and reflection. This is one developmental comparison, not a general effect estimate. The official `cell-eval2` CPU integration also passed on a pinned synthetic fixture; **real biological prediction performance remains unmeasured**. Details and limitations are in the [Virtual Cell readiness record](docs/testing/2026-09-14-vcc-readiness.md).

The September 13 live ideation continuation completed a landscape and generated eight draft candidates, then stopped at its external evaluation spending guard before evidence review, probes, tournament, frontier, or checkpoint. A separate Virtual Cell trial reached probes but failed on provider refusals; its synthetic probe was not biological validation. Neither delivered a validated shortlist. See the [consolidation record](docs/testing/2026-09-13-consolidation.md), [change evaluation](docs/testing/2026-09-13-change-evaluation.md), and [Virtual Cell readiness record](docs/testing/2026-09-14-vcc-readiness.md).

Kiln does not establish AGI, general benchmark superiority, biological-discovery reliability, or clinical reliability. Independent reviewers can share model and data biases; agreement is not fact verification.

Kiln is a single-operator local tool. Its shell and file tools run on the host without an OS sandbox. Use a disposable checkout or container for untrusted work, inspect generated checks, and do not grant credentials or deployment authority that the task does not require.

## Inspiration

Kiln draws from [oh-my-pi](https://github.com/can1357/oh-my-pi) for agent loops, providers, and terminal primitives; [Amp's Neo TUI](https://ampcode.com/news/neo) for the interaction model; and [Anthropic's long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Ralph](https://ghuntley.com/ralph/), and [Fractal](https://github.com/plasma-ai/fractal) for durable, Git-native work.

Its search and evaluation design draws from [AI co-scientist](https://arxiv.org/abs/2502.18864), [FunSearch](https://doi.org/10.1038/s41586-023-06924-6), [AlphaEvolve](https://arxiv.org/abs/2506.13131), [ShinkaEvolve](https://arxiv.org/abs/2509.19349), [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954), [GEPA](https://arxiv.org/abs/2507.19457), and [ACE](https://arxiv.org/abs/2510.04618). Kiln is not affiliated with these projects.

## Development

```sh
bun test
bun run typecheck
bun run kiln --help
```
