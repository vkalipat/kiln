# Plug-and-play verification — 2026-09-08

Final verification: **1,629 tests passed, zero failures**, 10,113 assertions across 182 files (130.73 seconds). Type checking and `git diff --check` passed. Four delegated agents implemented or reviewed bounded portions of the work.

## Entry contract

Follow-up correction: the earlier animation check exercised the prompt activity indicator, not the welcome artwork. The welcome artwork was static; it now receives the shared ticker frame, with a regression asserting the artwork itself changes. Bare greetings/help previously entered task orchestration; they now reply locally before authentication, without creating a run. A real `kiln` → `HI` terminal check confirmed the reply and idle $0.00 state. Substantive tasks prefixed with a greeting and active-run steering still follow their normal paths. Follow-up verification: 1,635 tests passed, zero failures, plus type checking.

Open `kiln`, type a task, press Enter. A missing provider connection is requested only after submission, with the draft retained. Fresh CLI/TUI homes enable adaptive routing and autonomous selection. Existing settings are preserved; `kiln model routing adaptive` enables routing for an older home. Explicit interactive controls remain available.

A one-sentence interpretation precedes execution. It currently describes the inferred task category, not a semantic restatement of every requirement. Simple implementation requests (including “write a script” and “make a command-line calculator”) take the direct formation/build/verification route. Open-ended ideas retain research and comparison. Missing existing-artifact context is a real blocker, not permission to invent a repository.

## Exercised boundaries

- Fake-terminal tests exercise animation repaint, resize, shutdown, deferred provider onboarding, draft preservation, and exactly-once submission after connection. No animation production fix was needed for these reproduced cases.
- A real PTY launch displayed the editable welcome screen and animation; Ctrl+C exited with code zero and restored the alternate buffer and cursor. No task was submitted in that smoke test.
- CLI/workflow tests exercise delivery versus plan-only/negated requests, direct versus exploratory workflows, frozen routing and resume behavior, and JSON output compatibility.
- Role reports record selection categories, source metrics/scores, fallback disclosure, reviewer separation, and effective effort. These are decision provenance, not hidden model reasoning or a benchmark win claim.
- Clarification answers persist in a permission-restricted, size-bounded artifact and enter resumed frame context. Answered questions are not repeated; reconnect can retry the same unanswered question without allowing a different questionnaire. Harness file tools cannot rewrite this artifact.
- Three new provider-free cases cover business, local software, and benign literature tasks. Zero-budget entry and repeated resumes dispatch no model/tool work; increasing the budget resumes the same run. Existing end-to-end tests cover transient errors, cancellation, process death, real filesystem/Git checks, repair, and audited delivery.
- A bounded live protocol check succeeded on `anthropic/claude-fable-5-1` and `openai-codex/gpt-5.5`: both invoked the requested tool correctly. Combined recorded usage was $0.0305925. Each model had at most two turns, 512 output tokens per call, and a 60-second timeout; the combined $2 planning target was not a hard provider billing ceiling.

## Context and learning boundaries

Kiln uses phase artifacts, feature-local sessions, evidence bundles, and durable records to transfer context. The clarification fix closes a concrete restart loss without adding an external memory service. This follows the focused-context and durable-note approach described in [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), checked during this review. This source is design guidance, not evidence that Kiln is state of the art.

Reflection automatically proposes playbook improvements after build terminals. Evaluating and promoting those changes still requires the existing explicit budgeted evolution workflow and held-out gates. Kiln does not silently spend additional evaluation budgets, rewrite itself, or promote self-graded changes. Context pressure is measured; general within-session compaction is not implemented. Fresh phase/feature contexts reduce accumulation but do not prove arbitrary-length task support.

Provider-free tests validate software behavior, not idea quality. The live check validates tool interoperability only, not complete live-model delivery or superiority over another harness. Model rankings are dated reviewed evidence, not an automatically refreshed claim about today's best model. Shell tools are host processes, not a sandbox; use isolation for untrusted tasks. Autonomous mode does not confer additional authority for external or destructive actions.

## Reproduce

```sh
bun test
bun run typecheck
bun test test/tui test/workflow test/routing test/brain/ask-user.test.ts test/usecases/plug-play-stress.test.ts
```

Optional live protocol check (incurs provider usage): `bun run scripts/live-smoke.ts --confirm-spend`.

The first full-suite attempt encountered two timeouts (seed-fixture copying and process-output capture). Five focused repetitions passed. A later full run reproduced a long clone-copy stall in a legacy-home fixture. Home, seed, and leakcheck fixtures now share the repository's established byte-copy workaround; three repetitions of those tests passed. Production process deadlines were not relaxed. See the final verification result reported with this change for subsequent full-suite counts.
