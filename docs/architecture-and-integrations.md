# Kiln architecture and integration decisions

Verified against the working implementation on **2026-09-28**. This document distinguishes installed runtime behavior from design inspiration and pending operational qualification. For commands and daily use, see the [user manual](user-manual.md).

## One operator, explicit responsibilities

Kiln embeds the pinned OMP coding session rather than wrapping another autonomous loop around it. The native session owns tool execution, worker sessions, messaging and conversational continuity. Kiln supplies durable task state, original-request preservation, shared context, role/model admission, effort selection, budget accounting, scoped team contracts and an optional research/ideation pipeline.

The TUI and `kiln task` use the same persistent operator. Messages received during a turn steer that work; follow-ups continue the same session. `kiln run new` instead exposes the explicit frame → discover → ideate → checkpoint → form → build → reflect pipeline, with adaptive omissions and checkpoint controls. These are related entry points, not interchangeable resume formats.

A role is a responsibility; a model is the admitted provider/model implementation; effort is a supported reasoning setting. Adaptive evidence helps rank eligible choices but does not bypass credentials, tool compatibility or the saved run's constraints. A catalog fingerprint detects changed admitted definitions and selected role references on resume. It blocks drift rather than reconstructing a historical catalog. Older runs establish their baseline on first resume.

## The current toolkit

A provider-free native-session fixture on pinned runtime **18.4.2** confirmed eleven root tools: `read`, `bash`, `edit`, `eval`, `glob`, `grep`, `task`, `wait`, `todo`, `web_search` and `write`. Kiln registers its own tools through the operator extension. Discoverable tools need not appear as individual top-level model tools; the historical tool count from 18.1.14 is not a current inventory.

| Surface | Tools | Purpose |
| --- | --- | --- |
| Direct filesystem | `read`, `write`, `edit`, `glob`, `grep` | Inspect, search and change scoped artifacts |
| Direct execution | `bash`, `eval` | Shell commands and persistent code evaluation |
| Direct coordination | `task`, `wait`, `todo`; `write` to `agent://<id>` | Native workers, waiting for owned jobs/messages, task tracking and peer messages |
| Direct research | `web_search` | Search access subject to the configured provider/environment |
| Discoverable Kiln | `team`, `context_publish`, `context_query`, `route_step`, `ideate`, `ask_user` | Scoped ownership, bounded evidence sharing, routing, idea search and missing-information questions |

`hub` was removed upstream. Native task results and messages are delivered automatically; agents use `write` to `agent://<id>` for peer messages and call `wait` only when blocked. This is not a one-for-one replacement for every old hub operation. Native child-session, metering and cancellation tests exercise the pinned runtime; they do not establish external provider readiness.

The built-in Chromium browser capability is enabled through the `browser` API inside `eval`, not a standalone `browser` tool. The opt-in `browser_task` tool now adapts jev-ultrafast decisions to the existing native browser; ordinary native browser access remains available. Computer control is disabled. MCP and LSP are disabled in this embedded session; skill/rule/prompt/slash-command discovery is explicitly empty. Native automatic memory is off. Goal and autoresearch tools are registered but inactive in the audited ordinary session.

Instantiation confirms that the tools are available, not that every external backend works. The audit did not authenticate a provider, launch a browser, execute a task tool or qualify web-search access. Local shell/file tools are not a filesystem sandbox. Scope claims coordinate cooperating agents, and external actions still require task authorization.

## Parallel teams and evidence

The parent fixes interfaces, objectives, literal file/directory ownership, dependencies and acceptance criteria before native worker dispatch. `team` maintains a revisioned ledger and rejects stale updates, overlapping active claims and unmet dependencies. Only the actual parent can plan, accept or reopen; workers claim and hand off. Failed work can be reopened with preserved history.

Worker reports remain `unverified_claim`. Artifact hashes identify the bytes reported or reviewed. Parent acceptance changes the assessment to `parent_reviewed`; it is not machine proof that a command executed or that an English requirement was satisfied. Dependencies are rechecked before downstream work. Native tools remain capable of accessing the host, so a lease is not isolation.

`team review_packet` (the `team` tool's `review_packet` action with a feature ID) returns all stable criterion IDs and optional worker-declared `coverage` mappings to exact handoff artifacts and zero-based check indices. It checks current artifact/dependency identity without changing the ledger or accepting work. Unmapped criteria remain explicit; requirement completeness and criterion proof stay `not_established`, and `taskQualityValidated` remains false. This read-only action needs no `expectedRevision` and works before handoff. It supports at most 64 criteria/mappings and 64 artifact/check references per mapping. Reopening clears current mappings while preserving history and stable criterion IDs. This deterministic preparation makes no model call.

The ideation tool runs research, separate candidate generation, prior-art review, assigned probes and order-swapped pairwise comparison. It preserves artifacts, unknowns and provenance. Missing or inadequate coverage is not a clean prior-art result. Selected ideas and model judgments remain hypotheses until the relevant real-world validation occurs. No fixed accuracy, speed or cost improvement is claimed from this architecture alone.

## What each of the four linked projects contributes

| Link | Actual Kiln integration | Boundary |
| --- | --- | --- |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | Pinned MIT snapshot vendored; batched operation/target decisions adapted into opt-in native browser execution | No upstream Python agent, daemon or second Chrome process; live performance unqualified |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | Explicit `kiln memory status`, `retain`, `recall` HTTP adapter | Requires an existing server and project bank; no automatic conversation retention or session injection |
| [LangChain: Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev) | Separation of typed decisions from generation informs Jev routing | No LangChain dependency or second runtime was added |
| [Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy) | Scoped ownership, acceptance conditions, parent reverification and visible incomplete handoffs inform Kiln's native ledger | No installed unlazy orchestrator/hooks and no exponential task-budget multiplication |

### Jev: fast classification, not the coding model

Jev answers typed questions; it does not generate code or replace the main reasoning model. Kiln calls the [TypeSafe HTTP API](https://docs.typesafe.ai/api) directly. A constrained choice selects research, ideation, implementation or synthesis. Kiln then chooses a model and effort from its admitted pool. Independent review is deliberately separate: a reviewer needs a fresh worker and actual producer identity.

With `TYPESAFE_API_KEY` in the environment, new operator runs classify at explicit boundaries: ordinary prompts make no routing request; `route_step` with `kind: "auto"` can classify an ambiguous transition. `KILN_JEV_ENABLED=0` disables external classification. Missing keys keep routing local. Explicit work types bypass Jev. Routing policy is frozen per run. Saved Jev policies without a mode retain legacy `per_prompt` behavior; pre-Jev runs retain local behavior. The programmatic runtime supports explicitly selecting `per_prompt` for a new run; resume cannot silently change modes.

For explicit advisory routing:

```sh
kiln model suggest "Compare candidate approaches" --jev --json
```

Omitting `--jev` keeps this command local.

The runtime policy is frozen per run: `jev-1.13.0`, confidence threshold 0.8, 1,500 ms deadline covering transport/body processing, 64 attempts and an observed 100,000-token allowance. Identical accepted or low-confidence classifications use an in-memory cache; failed transports are not cached. Call and token counters survive resume; cached decisions do not. A final request can cross the observed token allowance. Payloads and responses are size-bounded, redirects and automatic retries are disabled, and returned models, choices and probability distributions are validated.

Missing access, malformed output, low confidence, timeout, outage or exhausted allocation preserves the existing model/effort. Cancellation prevents the main model dispatch. The journal records decision provenance, input hash, confidence, latency, usage, caching and fallback reason. It does not duplicate the classifier's input summary.

The classifier receives bounded redacted task/request excerpts or an agent-provided concise handoff description, not the full transcript, repository or auth store. Redaction is not a guarantee that arbitrary private text is removed. Supplying the key enables this external processing; use the disable switch when it is inappropriate.

Accounting reserves the full 64k context exposure before transport and settles validated input usage at the pinned price: **$0.042 per million input tokens, output free**, verified on 2026-09-28 against [TypeSafe's model documentation](https://docs.typesafe.ai/models). Unknown usage retains the reservation. The reservation is conservative accounting, not a provider billing guarantee. Numeric calculations, budgets and date comparisons stay in code; the provider itself documents [Jev's limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

### Opt-in execution workflows

`KILN_JEV_WORKFLOWS=1` on a new run registers `browser_task`, `research_task` and internal `kiln_browser_decide`. The native operator and workers share four active workflow slots, 64 workflow Jev calls and a one-million-input-token exposure cap. Every request reserves 64,000 tokens and its dollar exposure before dispatch; validated usage settles it, while unknown usage remains charged conservatively across resume. Workflow allowances are separate from routing counters but subordinate to the same root money budget and cancellation. Exact serialized state/questions, operation, pinned model and confidence policy identify shared requests. Concurrent identical callers share transport; accepted known-usage results use a bounded 32-entry/256-KiB in-memory cache. Followers and cache hits carry origin IDs and no incremental dispatch, usage or charge. Failed, low-confidence and unknown-usage results are not cached. Caller cancellation is independent until no callers remain; run cancellation stops the shared work. Cached values do not persist on resume, while accounting does. Configuration is frozen in run metadata; steering invalidates pending actions.

`browser_task` holds an existing native tab's ownership across observe/decide/act, called directly outside `eval`. It batches operation and compatible target questions over observed permitted controls, validates freshness and returns a compact receipt. Its controller uses exact action-label allowlists and supplied literal field values; it supports click/fill/select/scroll/wait, at most eight decisions and 30 seconds. It returns unsupported or ambiguous results instead of replaying uncertain input. Only a proven pre-input stale result permits reobservation and replanning within the same bounds. Fresh checks cover exact URL, text presence and field equality; the native adapter returns their results and matching observation atomically. Even `status: verified` carries `quality: specified_checks_only` and `taskQualityValidated: false`; parent review must establish full goal coverage.

The unmodified upstream snapshot is pinned to `1231850a0bf1a0c0341fe408ef1668dbbfdfac46` with its MIT license in [vendor/jev-ultrafast](../vendor/jev-ultrafast/README.md). Kiln adapts the upstream operation/target decision rules to its native browser and accounting; it does not launch the Python Agent, another daemon or a second Chrome. No dependency source is patched for this browser bridge.

`research_task` uses existing search/fetch with explicit HTTPS source-host scope, bounded concurrent capture, immutable source artifacts, hashes, retrieval metadata and passage locations. Jev labels evidence fields as supports/contradicts/mixed/not_stated/unknown. The parent synthesizes; receipt `truthVerified` remains false. Truncation and unavailable sources remain explicit. The registered tool does not wire its optional low-level browser fallback: dynamic fetch failures require a separate `browser_task` call. Hindsight retention remains independent and explicit. See [workflow limits and usage](optional-integrations.md#browser-execution-and-completion-discipline).

Enabled workflow decisions send scoped browser observations/tasks or research passages/questions to TypeSafe. Offline contracts are supplemented by a [nine-request live qualification](testing/2026-09-28-jev-live-qualification.md): three synthetic fixtures passed, with 3,733 input and 487 output tokens. Adapter-price cost was calculated as $0.000156786, not verified against an invoice. This confirms those live classification/batching/reuse cases; it does not establish representative task accuracy or a frontier-model throughput advantage. A separate native form fixture subsequently produced a verified specified-check receipt with two Jev decisions, 1,328 input and 158 output tokens, after five incomplete calibration attempts. Independent DOM inspection confirmed the field and greeting; this remains one development success, not held-out qualification.

### Hindsight: explicit project memory

The adapter follows the [published OpenAPI contract](https://hindsight.vectorize.io/openapi.json). `retain` sends one operator-selected UTF-8 file, source basename and SHA-256 document identity. `recall` returns JSON marked untrusted while preserving service provenance. Neither operation updates the authoritative request, acceptance contract or arbitrary model context.

`status` is local-only and does not prove service readiness. Retain requires a synchronous success acknowledgment; a timeout leaves outcome uncertain, and there is no automatic retry. Input files are capped at 256 KiB, queries at 16 KiB and responses at 1 MiB. Timeout defaults to 10 seconds (maximum 120 seconds); recall defaults to 2,048 tokens (maximum 16,384). HTTPS is required except loopback HTTP; URL credentials and redirects are rejected. `HINDSIGHT_API_KEY` is environment-only.

Hindsight is MIT-licensed software, but self-hosting still needs infrastructure/storage and model execution. Managed service billing is separate from Kiln's main model budget; consult [current Hindsight pricing](https://vectorize.io/pricing) before use. Kiln does not deploy it or automatically send entire conversations. Add this memory path when recurring cross-run retrieval needs justify the operating cost, rather than treating extra memory as an automatic improvement.

### unlazy: completion principles, native implementation

The useful ideas are executable acceptance criteria, explicit ownership/dependencies, truthful handoffs and parent reverification. Kiln implements those principles in its own runtime and build checks. It does not install unlazy's CLI, shell-gate approval store or stop hooks. Check reports and ledger hashes retain their limits: they are evidence records, not tamper-proof attestations or proof of semantic correctness. Budgets remain bounded by the actual run allocation.

## Authentication and maintained dependency updates

Kiln owns its welcome, connection prompts and local browser receipt. A tracked Bun patch adds an optional sanitized callback-page renderer to the pinned native OAuth controller, with matching source and declarations. The hook receives only a boolean receipt status and generic error text. Provider codes, state and tokens stay in the existing flow. PKCE, callback checks, client identity and exchange endpoints are unchanged. Receipt copy remains pending until the terminal confirms the connection.

The protocol engine is reused; the Kiln-facing UI is owned here. A fully Kiln-named provider consent application would require its own OAuth registration, any required approval and matching client configuration. No such registration was performed, and availability of a registration path is provider-specific.

The patch is applied by normal installation and must be preserved or deliberately reconciled when native dependencies change. A patch conflict should block an update rather than silently restore an OMP-branded callback or modify authentication semantics.

`kiln model catalog status|check` audits metadata without admitting new models. `bun scripts/frontier-update.ts --check` inspects upstream package versions without applying them. The [six-hour frontier updater](frontier-updates.md) selects the latest common stable version of the six pinned native packages and prepares a validated exact-version update as a draft pull request. It needs to be merged and enabled before its schedule operates; it does not auto-merge, change benchmark rankings or hot-swap a running session. The validation path includes patch application, type checking, tests, evaluation verification and leak checks, plus advisory catalog inspection. Publishing occurs in a separate job so upgraded code does not execute with the write token. See [catalog updates](model-catalog-updates.md) for source hashes, freshness labels and admission limits.

## Qualification limits

Offline tests exercise contracts, mock provider failures, routing/accounting and synthetic OAuth loopback requests. They establish neither successful live login for every provider nor improved agent performance. Representative paid runs, paired routing comparisons and end-to-end browser/memory service qualification remain distinct work. Catalog freshness is not benchmark quality; a completed model turn is not acceptance; a scientific hypothesis is not a measured result.

See [the public Jev design](jev-design.md) for implementation choices, rejected generic gates and comparative evaluation requirements.
