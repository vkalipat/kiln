# Kiln documentation

Start with the [documentation site](https://vkalipat.github.io/kiln/) or [user manual](user-manual.md). The native terminal operator is the main entry point for new tasks.

## Using Kiln

- [User manual](user-manual.md): installation, authentication, terminal controls, tasks, teams, and resume.
- [Jev resource routing](jev-resource-routing.md): task-specific responsibilities, compatible models, effort selection, and recorded fallbacks.
- [Compute limits and monitoring](compute-limits.md): allocations, accounting, loop monitoring, and cancellation.
- [Optional integrations](optional-integrations.md): Jev browser and research tools, credentials, and Hindsight memory.
- [Model instructions](model-instructions.md): focused prompts, contextual skill loading, and completion boundaries.
- [Operator plugin](../plugins/kiln/README.md): use Kiln from Codex or Claude Code.

## Architecture and maintenance

- [Architecture and integrations](architecture-and-integrations.md): native runtime, task teams, storage, tools, and external services.
- [Frontier updates](frontier-updates.md): dependency update checks and release workflow.
- [Model catalog updates](model-catalog-updates.md): model availability and compatibility maintenance.
- [Documentation site](../site/README.md): preview, accessibility checks, and publishing.

## Advanced and legacy workflows

These interfaces remain available for explicit phase runs and compatibility. They are separate from the native task conversation and its Jev resource assignments.

- [Explicit workflow commands](user-manual.md#6-explicit-workflow-runs): start and resume phase-based runs.
- [CLI usage reference](usage.md): project formation, builds, idea selection, evaluation, and recovery commands.
- [Adaptive routing](adaptive-routing.md): frozen phase routing, legacy roles, benchmark evidence, and planning allocations.
- [Jev execution design](jev-design.md): browser and research workflow architecture and evaluation boundaries.
- [Design records](design/README.md): original designs and subsequent corrections.

## Validation records

Read each record’s inputs, checks, and limitations before applying its findings to another task. Routing checks do not establish downstream task quality, and synthetic fixtures do not establish scientific performance.

- [September 30 Jev routing qualification](testing/2026-09-30-jev-resource-routing.json): recorded classifications, selections, and fallbacks; selected models were not executed.
- [Jev workflow checks](testing/2026-09-28-jev-workflows.md) and [live qualification](testing/2026-09-28-jev-live-qualification.md): browser/research fixtures and retained attempts.
- [Local acceptance record](testing/2026-09-28-v1.md) and [frontier maintenance checks](testing/2026-09-28-frontier.md): dated software validation and integration behavior.
- [Use-case evaluations](testing/usecases.md): task fixtures and evaluation approach.
- [Virtual Cell readiness](testing/2026-09-14-vcc-readiness.md): utility and synthetic integration results, with biological performance distinguished.
- [Change evaluation](testing/2026-09-13-change-evaluation.md) and [consolidation](testing/2026-09-13-consolidation.md): earlier delivery and ideation trials.
- [Challenge preparation](challenges/2026-readiness.md): task requirements and preparation boundaries.

## Historical references

- [September 28 model snapshot](model-routing-2026-09-28.md), [September 9 snapshot](model-routing-2026-09-09.md), and [September 8 snapshot](model-routing-2026-09-08.md).

Dated reports and design proposals describe their recorded state; use the current guides above for commands and behavior.
