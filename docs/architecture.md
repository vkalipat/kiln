# Kiln architecture

Kiln embeds one native OMP operator rather than starting another agent loop around it. The current checkout pins all six native packages to 18.6.1. Commands and operating bounds are in the [reference](README.md). Evidence is in [validation](validation.md).

## Runtime boundaries

| Component | Responsibility |
| --- | --- |
| OMP runtime | Agent sessions, tool execution, workers, peer messages, conversation continuity, and automatic compaction |
| Kiln operator | Original requests, durable task records, shared context, team contracts, model admission, effort policy, accounting, and monitoring |
| Kiln phase pipeline | Research, candidate generation, prior-art review, probes, idea comparison, project formation, builds, and reflection |
| Optional TypeSafe service | Typed Jev classification and bounded resource or workflow decisions |
| Optional Hindsight service | Explicit retention and recall from a configured project bank |

Jev chooses resources; the selected reasoning model does the work. Kiln uses the TypeSafe API through its existing metered service. It does not add a proxy, another coding assistant, or a mandatory memory layer.

The native session exposes filesystem, shell, code evaluation, search, task, and coordination tools. Native browser control uses the browser API inside `eval`. Optional `browser_task` adapts decisions to that existing owned browser. MCP, LSP, computer control, automatic memory, and ambient skill catalogs are disabled in this embedded session.

Tool registration does not establish backend access. Shell and file tools use host permissions. Team scopes coordinate cooperating workers without filesystem isolation.

## Task state and evidence

The terminal interface and `kiln task` use the same persistent operator. A running message steers the current turn; a settled follow-up continues the session. `kiln run new` has a separate phase record and checkpoint model. Their resume formats are not interchangeable.

The [session adapter](../src/operator/session.ts) owns native session construction. The [runtime](../src/operator/runtime.ts) connects tools, routing, cancellation, and accounting. Resume preserves saved policy and checks the model catalog fingerprint before dispatch.

[Shared context](../src/operator/context.ts) saves revisioned evidence with sources and hashes. The [team ledger](../src/operator/team.ts) tracks ownership, dependencies, handoffs, acceptance, and history. Assignment records bind the exact feature contract, catalog, model, and effort to a dispatch name.

Worker reports are claims. Parent acceptance records review and current artifact identity. Review packets expose requirement coverage without claiming that commands ran or every requirement passed. External text and worker messages do not change the user's authorization.

The operator instructions focus on the requested outcome and meaningful checks. Project `AGENTS.md` discovery still applies where configured. Existing home prompt overrides remain user-owned. Source results are evidence rather than instructions to follow automatically.

## Accounting and cancellation

The [meter](../src/operator/meter.ts) reserves conservative exposure before provider transport and settles validated usage. The [ledger reader](../src/operator/meter-ledger.ts) replays the checkpoint and flushed journal together. Unknown requests retain exposure; damaged history refuses dispatch.

Native workers share admission and cancellation with their owning run. An unaffordable request cannot block smaller affordable work at the queue head. A child's budget denial or admission timeout stops that child rather than the parent.

The [monitor](../src/operator/compute-monitor.ts) consumes row deltas and records bounded fingerprints. It warns or pauses on exact repetition and warns on context growth. It makes no model calls and cannot assess semantic progress.

## Integration boundaries

The browser controller adapts a pinned MIT [jev-ultrafast snapshot](../vendor/jev-ultrafast/README.md). It keeps native tab ownership and freshness checks. It does not run the upstream Python agent or start another browser process.

Research saves captured source artifacts with hashes and passage locations. Classification labels remain unverified. Failed retrieval, truncation, contradictions, and unknown usage stay visible. Hindsight is an explicit HTTP adapter; it does not retain conversations or inject recalled material automatically.

Public router and unlazy projects informed the design. They are not copied runtime dependencies or separate installed orchestrators. Kiln's context, ownership, and accounting code remains local to this repository.

## Credential handling

Two tracked Bun patches extend the native runtime. The OAuth patch adds a sanitized Kiln callback page. The coding-agent patch supplies owning session settings to Bash and filters shell and evaluation environments.

The callback hook receives only safe receipt status and generic error text. Provider codes, state, and tokens remain inside the native flow. Provider consent still identifies the registered upstream application.

Native tool results and model context redact known secrets before persistence and later dispatch. Parent and child sessions use protected environment settings. These are credential hygiene measures, not a sandbox against arbitrary host files or unknown secrets.

Dependency updates must preserve both reviewed patches and their exact installed source and declaration contexts. The [frontier updater](../scripts/frontier-update.ts) rejects missing, changed, or misplaced post-images. Its isolated publisher merges only the exact validated dependency files on the tested base. Install and restart after a dependency update.
