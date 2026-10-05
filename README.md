# <img src="site/kiln.svg" width="32" height="32" alt=""> Kiln

Kiln helps you build software, research questions, and compare ideas from your terminal. Describe the result you need and the checks that would show it works. The AI operator can use local tools, assign work to other agents, and save the session for later.

[Documentation site](https://vkalipat.github.io/kiln/) · [Command reference](docs/README.md) · [Architecture](docs/architecture.md) · [Validation](docs/validation.md)

## What Kiln can do

| Capability | How it works |
| --- | --- |
| Local work | Read, write, and edit files, run shell commands, evaluate code, search the web, and use the native browser. External tools need their own access. |
| Persistent tasks | Save the original request, scope, conversation, artifacts, and usage. Steer active work, pause it, or continue a saved session. |
| Task teams | Give workers separate files, dependencies, and acceptance criteria. Record handoffs for the parent operator to review, accept, or reopen. |
| Shared evidence | Save context with sources, revisions, and hashes. Review packets connect reported artifacts and checks to requirements, with gaps visible. |
| Model control | Choose connected providers and models. Use fixed or automatic reasoning effort. Optional Jev selection uses compatible choices, reviewed evidence, and catalog prices. |
| Usage monitoring | Inspect cost, pending usage estimates, repeated calls, and context growth. Local monitoring makes no model calls. |
| Browser and research workflows | Experimental Jev tools act on an owned browser or capture allowed HTTPS sources. Results retain stated checks, citations, contradictions, and unknowns. |
| Project memory | Explicit Hindsight retention and recall use a configured server and project bank. You choose which notes to send. |
| Idea comparison | A separate phase workflow supports research, prior-art checks, probes, idea comparison, project formation, builds, and reflection. |
| Assistant plugins | Codex and Claude Code can start, monitor, steer, pause, and resume detached Kiln work. Request IDs prevent duplicate launches. |

The OMP runtime supplies sessions, tools, workers, and agent messages. Kiln adds task records, shared context, team contracts, routing, and usage monitoring. See [architecture](docs/architecture.md) for the boundaries.

## Install

Install [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh/) 1.3.14 or newer.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install --frozen-lockfile
bun link
kiln auth login
kiln doctor --json
```

Choose subscription sign-in or API-key access in the login flow. API keys use masked prompts. Provider access and billing depend on your account.

Open a terminal in your project and run `kiln`. Opening the interface does not call a model. A real task can use paid models and run tools on your computer.

Verified frontier dependency updates merge automatically every six hours. To update a local installation, run `git pull --ff-only`, `bun install --frozen-lockfile`, and `bun link` in the checkout. Then restart Kiln. Keep the tracked dependency patches with the checkout.

## Run and resume

Describe the deliverable, constraints, and required checks:

```sh
kiln task "Build a CSV importer; handle malformed rows and verify the import flow" --cwd .
kiln task resume RUN_ID "Continue the remaining checks"
kiln --run RUN_ID
```

Copy the run ID from the output. A message during active work steers that turn. A follow-up after the turn ends continues the same conversation. `kiln task resume RUN_ID` without a message reports saved state without starting more work.

`Ctrl+O` opens the command palette. `Ctrl+S` changes reasoning effort, `Alt+T` shows tool details, and `Esc` requests a pause. Use `task:new` in the palette for a fresh conversation. Choose `auto` in the effort dial to restore automatic selection.

The [reference](docs/README.md#tasks) covers exact-text files, CLI steering, pause, authentication, and resume. Saved model definitions are checked on resume; changed catalog metadata can block an older run.

## Models and optional services

For Jev model selection and automatic effort in new sessions:

```sh
kiln auth key jev
kiln model routing adaptive
kiln mode set auto
```

Explicit model and effort choices remain constraints. Uncertain decisions use a recorded fallback. Routes stay stable during tool loops.

Enable experimental browser and research workflows with `kiln integrations jev enable`. Hindsight needs a separate server and project bank. See [integration setup](docs/README.md#optional-integrations) and [plugin commands](docs/README.md#assistant-plugins).

## Limits and monitoring

```sh
kiln task limits
kiln task monitor RUN_ID --json
```

Set finite defaults with `kiln task limits --budget 100 --wall-seconds 28800`. Use `kiln task limits --uncapped` to remove aggregate dollar and active-time allocations for future native sessions. Existing runs retain their saved allocations and usage.

Finite allocations control estimated usage before dispatch. In-flight requests and unknown charges can exceed the target. Uncapped sessions retain accounting and loop monitoring.

| Capacity | Current bound |
| --- | --- |
| Native workers | 32 concurrent workers; recursion depth 2 |
| Jev browser and research workflows | Four active workflows; up to 64 waiting callers |
| Research sources | Six by default; up to 12 per task |
| Shared context | 4,096 entries and 16 MiB per context document |

Provider quotas and rate limits can stop work earlier. Uncapped allocations do not remove tool or concurrency bounds. The [reference](docs/README.md#limits-and-accounting) lists all limits and accounting behavior.

## Check the result

- `doctor` checks local configuration. It does not test live authentication, quota, or service health.
- A completed turn or plugin status does not prove that the task passed its acceptance criteria. Review the artifacts and checks.
- Team scopes coordinate work; they do not sandbox file access. Shell and file tools use your local permissions.

Kiln filters credential variables from native shell and evaluation environments and redacts known secrets in tool results. Keep credentials out of prompts and repositories.

The [validation record](docs/validation.md) retains 2,375 passing tests from the October 4, 2026 audit and the earlier evidence. Synthetic timings and routing decisions do not establish live throughput or task quality.

## Development

```sh
bun test
bun run typecheck
bun run docs:check
bun run kiln --help
```

See the [reference](docs/README.md#development) for stress tests, evaluation checks, site preview, and dependency updates.
