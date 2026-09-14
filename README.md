# Kiln

Kiln is a local, terminal-first agent harness for researching ideas and delivering verified work. Open it, describe the task, and it selects a workflow and compatible models from your connected providers.

Its focus is two things:

- **Reliable agent handoffs.** Workers receive original requirements, relevant canonical artifacts, evidence and assigned scope. Long checks and reviews remain available in full; bounded context views never replace their authoritative records.
- **Task-appropriate orchestration.** Explicit local implementation tasks avoid competitive ideation. Research and idea searches use bounded parallel workers, evidence gathering and comparison. Work is repeated when validation or review requires it.

## Start

Requires [Bun](https://bun.sh/) 1.3.14+ and Git.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install
bun link
kiln
```

Type your task and press Enter. If a provider is missing, Kiln retains the prompt while you connect a Claude or ChatGPT subscription through OAuth, or enter an API key. Launch and local greetings such as `HI` make no model requests.

Fresh installations enable adaptive routing and autonomous selection. Kiln shows a one-sentence interpretation and records its workflow, model choices and resource estimates. Existing settings and frozen runs are preserved. Missing source material or authority can still require your input.

```sh
kiln auth login anthropic
kiln run new "Build a local CSV validation CLI with tests and usage documentation" --through reflect --autonomous --yes
```

TUI: `/login` connects providers, `Ctrl+O` opens commands, `Ctrl+S` changes effort, `Esc` pauses, and `Ctrl+C` exits. See [usage and recovery](docs/usage.md).

## Capabilities

- **Evidence-led ideation:** independent lenses, a diversity archive, scout-owned source provenance, explicit prior-art coverage review, executable feasibility probes where appropriate, and pairwise judging in both presentation orders. Inadequate research remains unknown.
- **Verified delivery:** a validated specification and frozen acceptance criteria, feature-scoped builders, actual executable checks, and independent audits of detached repository snapshots. Unavailable audit evidence cannot approve a feature.
- **Inspectable context:** exact task requirements, ownership-aware review, full retained audit evidence, and source/hash references for material too large to inline.
- **Bounded work:** portfolio sizing, affordable research units, answer-time reserves, task-specific workflows, and provider-supported reasoning/cache settings. Estimates are not guarantees.
- **Durable operation:** file-backed runs, completed-research checkpoints, Git evidence, live steering, interrupted-work recovery, and recorded model/tool usage. Recovery does not reset spent budgets or silently replace accepted requirements.
- **Gated improvement:** reflection proposes playbook changes; promotion requires separate evaluation and integrity checks. A suggestion is not automatically a verified lesson.

[Adaptive routing details](docs/adaptive-routing.md) explain model eligibility and role selection. Reviewed benchmark evidence informs routing; Kiln does not claim every selected model leads every live leaderboard.

### Codex and Claude Code

The [operator plugin](plugins/kiln/README.md) lets a coding assistant launch, monitor, pause and resume a run. Claude Code can load it with `claude --plugin-dir ./plugins/kiln`, then `/kiln:run <directive>`. Codex uses the same operator skill through its plugin system. Installation does not start provider work.

## Evidence and limits

A live CSV task completed with **16/16 independent behavioral checks**, 14 generated tests and a usable independent audit. Its simple tool-using baseline hit a per-call output limit without delivering. A separate CLI recovery passed 7/7 external checks and 11 generated tests. These are small development qualifications, not proof of general benchmark superiority.

The latest live ideation recovery completed discovery and generated eight draft candidates, but its evaluation spending guard stopped it before evidence review and ranking finished. That is progress, not a validated shortlist. Completed-research persistence was fixed afterward and regression-tested; full live ideation qualification remains open. See the [development results](docs/testing/2026-09-10-completion-development.md) and [consolidation record](docs/testing/2026-09-13-consolidation.md). These examples do not establish AGI, biological-discovery or clinical reliability.

Kiln is a single-operator local tool. **Shell commands are not OS-sandboxed.** Use an appropriately isolated environment for untrusted work. Shell scratch defaults are unique and run-local, but this is not filesystem isolation. Run dollar budgets are planning targets checked at turn boundaries; an admitted provider turn may finish above its target. Evaluations require explicit spending authorization.

## Inspiration

Kiln combines ideas from [oh-my-pi](https://github.com/can1357/oh-my-pi) for agent loops, providers and terminal primitives; [Amp's Neo TUI](https://ampcode.com/news/neo) for the interaction model; [Anthropic's long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Ralph](https://ghuntley.com/ralph/) and [Fractal](https://github.com/plasma-ai/fractal) for durable, Git-native work.

Its search and evaluation foundations draw from [AI co-scientist](https://arxiv.org/abs/2502.18864), [FunSearch](https://doi.org/10.1038/s41586-023-06924-6), [AlphaEvolve](https://arxiv.org/abs/2506.13131), [ShinkaEvolve](https://arxiv.org/abs/2509.19349), [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954), [GEPA](https://arxiv.org/abs/2507.19457) and [ACE](https://arxiv.org/abs/2510.04618). Kiln is not affiliated with these projects. [Historical design records](docs/design/README.md) retain the original reasoning and corrections.

## Development

```sh
bun test
bun run typecheck
bun run kiln --help
```
