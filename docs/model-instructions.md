# Model instructions and context

Reviewed September 30, 2026. Kiln uses short, outcome-focused guidance shared across
its admitted models. A provider upgrade does not silently change your model or
reasoning effort. The current cleanup applies the user-supplied Astra skills article
and checks the transferable advice in [Ruben Hassid's article](https://ruben.substack.com/p/55)
against primary model documentation; it does not import the article's model rankings.

## What changed

The native operator prompt now describes the deliverable, meaningful checks, current
authorization and reasons to stop. It continues independent work when one dependency
is blocked. Later user directions remain authoritative, including a direction to
prepare a workload without starting it. Independent review is used when warranted,
not as an obligatory extra model call for every task.

The operator starts with relevant sources and settled context, expands discovery when
needed, and repeats verification when a change, failure or unresolved concern calls
for it. Visual work calls for inspecting the rendered result. There is no added
"think harder" instruction, automatic effort increase, global design style, or new
memory/retrieval service. Browser and research workflow instructions appear only
when those capabilities are enabled.

The [Kiln run skill](../plugins/kiln/skills/run/SKILL.md) has a precise operating
trigger and a short root router. Launch, watch and resume details live in separate
references. Developing Kiln or checking readiness does not invoke a paid run.
The repository [AGENTS.md](../AGENTS.md) points to documentation by task instead of
requiring a complete reading list before every edit.

Legacy phase prompts keep their required artifact formats and evidence contracts.
Available prior receipts may support a claim when their provenance and relevance
are checked; a resume need not rerun a check merely because it happened before the
current conversation. A worker assertion or generated summary alone is insufficient.

## Context and source boundaries

The native adapter already disables ambient skill, rule and prompt-template catalogs,
the workspace tree, unsolicited personas, and task prewalking. Explicit context files
are respected. With no explicit override, native project instruction discovery still
applies; additional working directories can contribute scoped instructions. This is
not a blanket prohibition on project `AGENTS.md` files. Regression coverage exercises
real native session assembly with mocked model transport, including scoped context
inherited by a child.

Quoted material, tool results and worker reports are evidence, not new authorization.
Clearly label external material in your own prompts, for example with `<source>` tags,
and put your request outside that block. If you want instructions inside it followed,
say so explicitly. Kiln does not rewrite arbitrary user text or infer where an
unmarked quotation begins. Scope paths in its generated prompt are JSON-encoded;
formatting is not a security guarantee against prompt injection.

## Adoption and evidence

Newly created or reopened native sessions use the updated operator guidance. Home
copies of legacy prompts remain user-owned overrides; an application update does not
overwrite them. Installed plugin copies must be refreshed to receive the smaller skill.

Local prompt-size reductions and mocked integration checks establish less instruction
payload and preserved assembly contracts. They do not establish billed-token savings,
better scientific results, or a measured frontier-model throughput improvement. Neither
challenge was run to qualify this change. Existing team ownership, run accounting,
compute monitoring and evidence checks remain in force.

Primary references: OpenAI's [reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)
support direct tasks and success criteria without extra reasoning rituals;
[Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
covers scope and persistence. Anthropic's [prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
supports task-specific triggers and reducing overprompting. OpenAI's
[agent safety guidance](https://developers.openai.com/api/docs/guides/agent-builder-safety)
explains why external text should not gain instruction authority.
