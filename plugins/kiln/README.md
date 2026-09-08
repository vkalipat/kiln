# Kiln coding-assistant plugin

A local operator skill for Codex and Claude Code, inspired by Fractal's launch-and-monitor workflow. It uses Kiln's existing CLI, providers, adaptive routing, and durable run records; it does not create worktrees or call a second coding assistant.

Requires Python 3.10+, Bun, and an installed/current `kiln` command (`bun install && bun link` from the Kiln checkout). Authenticate through Kiln before starting paid work.

## Claude Code

```sh
claude --plugin-dir /absolute/path/to/kiln/plugins/kiln
```

Then enter `/kiln:run` followed by your directive, for example:

```text
/kiln:run Explore a useful business idea with Kiln. Stop at the idea checkpoint and keep me updated. Use my current budget and model settings.
```

To operate an existing job: `/kiln:run Watch request REQUEST_ID` or `/kiln:run Pause request REQUEST_ID`. Resume is explicit; delivery after checkpoint requires an explicit request to continue through reflection.

## Codex

Install the `kiln` package in a local Codex marketplace, then select Kiln in the app or ask Codex to use the Kiln plugin. The personal install on the development machine lives at `~/plugins/kiln`, registered in `~/.agents/plugins/marketplace.json`. Open a new thread after installing.

With that personal marketplace registered, install using `codex plugin add kiln@personal`. This is a local installation, not a public listing. For Claude Code, the development machine also links the plugin from `~/.claude/skills/kiln` for automatic discovery in new sessions; other installations can use the explicit `--plugin-dir` command above.

Example: “Use the Kiln plugin to explore a business idea, stop at the checkpoint, and watch the run. Use my existing settings.”

## Operator helper

```sh
python3 scripts/kiln_operator.py start --request-id demo-1 --seed-file ./seed.txt --through checkpoint --confirm-spend
python3 scripts/kiln_operator.py status --request-id demo-1
python3 scripts/kiln_operator.py logs --request-id demo-1 --lines 40
python3 scripts/kiln_operator.py pause --request-id demo-1
python3 scripts/kiln_operator.py resume --request-id demo-1 --through reflect --confirm-spend
```

Pass `--home` to use a nondefault Kiln home, or `--kiln-bin` for an executable off PATH. Start/resume return immediately; workers and logs persist under the Kiln home's `operator/` directory. Reuse request IDs to avoid duplicate work. Never equate a worker exit with a completed project.

No hooks launch work automatically, no credentials are bundled, and installation makes no provider requests. Starting/resuming can incur real provider usage and run tools on the host. Budgets remain planning targets, not hard ceilings. This plugin does not change the parent assistant's permissions or publish anything.

Packaging follows the [Codex plugin guidance](https://developers.openai.com/plugins/build/plugins) and [Claude Code plugin format](https://code.claude.com/docs/en/plugins). The operator workflow is inspired by [Fractal](https://github.com/plasma-ai/fractal).
