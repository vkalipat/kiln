# <img src="site/kiln.svg" width="32" height="32" alt=""> Kiln

Kiln is a terminal harness for research, ideation, and implementation. It gives frontier models local tools, persistent sessions, and task-specific teams, with saved artifacts and usage records you can inspect.

[Documentation](https://vkalipat.github.io/kiln/) · [User guide](docs/user-manual.md) · [Jev routing](docs/jev-resource-routing.md) · [All guides and evidence](docs/README.md)

## Install

Requires [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh/) 1.3.14 or newer.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install --frozen-lockfile
bun link
kiln auth login
kiln doctor --json
```

Choose subscription sign-in or API-key access in the authentication flow. Keys are entered through masked prompts. Open a terminal in your project and run `kiln` to start the interface.

To update, run `git pull --ff-only`, `bun install --frozen-lockfile`, and `bun link` in the Kiln checkout, then restart Kiln.

## Run and resume

Describe the deliverable, constraints, and evidence that would make the work complete. Follow-up messages continue the session; messages during work steer it.

```sh
kiln task "Build a CSV importer; handle malformed rows and verify the import flow" --cwd .
kiln task resume RUN_ID "Continue the remaining checks"
kiln --run RUN_ID
```

Copy the run ID from the output. `kiln task resume RUN_ID` without a message reports saved state. In the TUI, `Esc` requests a pause, `Ctrl+O` opens commands, and `Ctrl+S` changes reasoning effort.

Kiln’s frontier operator decides whether delegation helps, defines responsibilities and acceptance criteria, and reviews worker handoffs. Teams fit the task; preset roles are reusable defaults for compatibility, not a required roster.

## Jev and model selection

Enable Jev resource routing and automatic effort for new sessions:

```sh
kiln auth key jev
kiln model routing adaptive
kiln mode set auto
```

Jev selects compatible models and effort from a bounded catalog shortlist, using the task, reviewed evidence, and published costs. Team assignments can include alternative responsibilities proposed by the frontier operator. Explicit model and effort choices remain constraints; inconclusive selection uses a recorded fallback. Routes stay stable through tool loops.

To enable Jev browser and research tools for new sessions, run `kiln integrations jev enable`. See [resource routing](docs/jev-resource-routing.md) for selection details and [integrations](docs/optional-integrations.md) for browser workflows and Hindsight project memory.

## Limits and monitoring

Inspect defaults and recorded usage:

```sh
kiln task limits
kiln task monitor RUN_ID --json
```

Use `kiln task limits --uncapped` to remove aggregate dollar and active-time allocations for future native sessions. Accounting and loop monitoring remain active. Existing runs retain their saved policy. [Compute limits](docs/compute-limits.md) explains finite allocations and provider constraints.

## Usage notes

- `doctor` checks local configuration, not live authentication, quota, or service health.
- Tasks can use paid provider access. Provider, tool, and concurrency limits still apply to uncapped sessions; in-flight work can exceed finite allocations.
- Review delivered artifacts and checks. Routing qualifications establish selection behavior, not workload quality or a measured throughput gain; [evidence records](docs/README.md#validation-records) retain the scope and limitations.
- Shell and file tools run with local permissions. Define the workspace and authorize external actions deliberately. Keep credentials out of task prompts and repositories.

## Development

```sh
bun test
bun run typecheck
bun run docs:check
bun run kiln --help
```

See [architecture](docs/architecture-and-integrations.md), [model instructions](docs/model-instructions.md), and [frontier maintenance](docs/frontier-updates.md). The [documentation index](docs/README.md) also covers supported explicit workflows, operator plugins, and historical design records.
