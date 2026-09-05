# Kiln

Kiln is a local, terminal-first harness that turns a rough seed into ranked ideas and a verified first project. It researches the space, tests assumptions, forms a frozen build plan, implements one feature at a time, and records the evidence needed to resume or audit the run.

```text
seed -> frame -> discover -> ideate -> choose -> form -> build -> reflect
```

## Quick start

Kiln requires [Bun](https://bun.sh/) 1.3.14 or newer and Git.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install
bun link
kiln
```

The first launch opens a provider chooser. Connect a Claude or ChatGPT subscription with OAuth, or enter an Anthropic or OpenAI API key. Existing provider environment variables work too. Kiln does not make a model request until you submit a seed.

Inside the TUI, type an idea and press Enter. Use `/login` to change providers, `Ctrl+O` for commands, `Ctrl+S` for effort, `Esc` to pause, and `Ctrl+C` to exit.

Prefer a command line?

```sh
kiln auth login anthropic
kiln run new "A local tool to compare household energy use" --through reflect
```

See [docs/usage.md](docs/usage.md) for the full CLI, TUI controls, recovery rules, and evaluation commands.

## What is implemented

- Three isolated idea islands search with different lenses. A quality-diversity archive rejects near duplicates, scouts check prior art, and short executable probes test feasibility when possible.
- A commit-first pairwise judge compares candidates in both orders. Kiln keeps a Pareto frontier and asks for one human choice, or makes the choice in autonomous mode.
- Formation produces a spec, executable acceptance criteria, and an initialization script, then freezes them before implementation begins.
- Each feature gets a fresh builder context. An independent auditor checks a detached copy of the exact repository bytes, and only external checks can mark the feature complete.
- Runs are file-backed, Git-native, and resumable after interruption. The append-only record includes model calls, tool calls, costs, status changes, checks, audits, and commit evidence.
- The full-screen TUI and scriptable CLI share the same lifecycle. The TUI supports live steering and an effort dial; CLI commands cover pause, resume, inspection, per-role model effort, and structured JSON output.
- Reflection can propose small playbook or prompt changes. Promotion requires isolated development and held-out evaluation, integrity checks, statistical gates, and a reversible Git transaction.
- Claude and ChatGPT subscription OAuth use the provider flows from the pi libraries. API keys can be entered with a masked prompt and are stored locally.

## Evidence and limits

The clean standalone checkout passes 1,376 automated tests, including dedicated onboarding coverage and [two provider-free autonomy demonstrations](docs/testing/usecases.md). Both use production CLI, build, and reflect orchestration with real filesystem tools, shell checks, Git commits and trailers, detached audit snapshots, journals, and recovery. One resumes a post-commit interruption without another builder call; the other records a failed check, repairs it in a fresh attempt, and finishes with one clean commit.

The demonstrations mock builder, auditor, and reflector responses, credentials, and usage. No paid provider experiment has been run yet, so Kiln has been tested as software but has not established live-model coding quality or an advantage over a one-shot model. Evaluation commands require an explicit budget and confirmation.

Automated TUI tests use a fake terminal. A manual live-terminal smoke test confirmed launch and clean alternate-buffer exit.

Kiln is a single-operator local prototype. Its shell and file tools run on the host without a sandbox, so use a disposable checkout or container for untrusted work. A run budget is a planning target checked at turn boundaries, not a hard spending ceiling; an in-flight provider turn is allowed to finish.

## Origins

Kiln began as a smaller answer to a much larger agent-orchestration design: find the least machinery needed to move from an open-ended idea to an independently verified artifact, then improve that machinery without letting it grade itself.

Its implementation and interaction model draw from:

- [oh-my-pi](https://github.com/can1357/oh-my-pi) for the native agent loop, provider adapters, subscription OAuth, model catalog, and terminal primitives.
- [Amp's Neo TUI](https://ampcode.com/news/neo) for the focused transcript, command palette, effort dial, and keyboard-first terminal experience.
- [Anthropic's long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) and [Ralph](https://ghuntley.com/ralph/) for fresh work sessions with durable progress in files and Git.
- [Google's AI co-scientist](https://arxiv.org/abs/2502.18864), [FunSearch](https://doi.org/10.1038/s41586-023-06924-6), [AlphaEvolve](https://arxiv.org/abs/2506.13131), and [ShinkaEvolve](https://arxiv.org/abs/2509.19349) for islands, archives, pairwise selection, novelty rejection, and evaluator-driven evolution.
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954), [GEPA](https://arxiv.org/abs/2507.19457), and [ACE](https://arxiv.org/abs/2510.04618) for guarded, traceable changes to prompts and playbooks.
- [Fractal](https://github.com/plasma-ai/fractal) for the original emphasis on Git-native workspaces, budgets, audit trails, and explicit completion contracts.

Kiln adapts these ideas to open-ended ideation and local project formation. It is not affiliated with those projects.

The [design records](docs/design/README.md) preserve the research trail, rejected alternatives, and later corrections behind the implementation.

## Development

```sh
bun test
bun run typecheck
bun run kiln --help
```

The repository is private and under active development.
