# Optional harness integrations

Kiln uses its native operator, durable context, admitted model pool, and ideation pipeline. Installing Kiln or opening its TUI does not contact these services. Jev can classify explicit work transitions and power opt-in browser/research workflows when its key is configured; Hindsight remains explicitly invoked project memory.

## Jev runtime routing and step suggestions

With `TYPESAFE_API_KEY` available, new native operator runs use boundary routing: ordinary prompts make no routing request, while `route_step` with `kind: "auto"` can call Jev at an ambiguous work transition. Jev chooses among research, ideation, implementation, and synthesis. Kiln then applies its existing credential, compatibility, role and effort rules to select an admitted model. Explicit step requests bypass Jev, and independent review still requires a separate worker and producer identity.

Boundary routing sends the agent's concise work description. Legacy or explicitly configured `per_prompt` routing sends bounded, redacted original-task and current-request excerpts. It does not receive the full transcript, repository files, or authentication store. Redaction is not a guarantee that arbitrary private text is removed. Set `KILN_JEV_ENABLED=0` to disable automatic external classification. Without a key, routing stays local. Routing mode is frozen per run. Existing Jev runs saved without a mode retain their previous `per_prompt` behavior; runs predating Jev retain local routing. Changing a saved mode requires a new run. The programmatic runtime option supports explicit `per_prompt` mode; there is no CLI mode flag.

Each run freezes the model (`jev-1.13.0`), confidence threshold (0.8), timeout (1500 ms) and aggregate allowances. New native runs with at least one finite aggregate allocation default to 64 calls and an observed 100,000-token allowance; when both native dollar and active-time allocations are `null`, these default aggregate Jev allowances are uncapped. Explicit allowances and saved resume policies remain authoritative. These are policy defaults, not measured accuracy guarantees; the final request can cross the observed token allowance. Identical decisions are cached in memory. Call/token counters survive resume. Missing credentials, low confidence, invalid responses, exhausted allocation, or unavailable service preserve the live model and effort; cancellation prevents the main model dispatch.

The shared run meter reserves Jev's 64k context exposure before transport and settles validated input usage at the pinned model's published rate ($0.042/million input tokens, output free; checked 2026-09-28). Unknown usage retains the reservation. The run journal records the choice, input hash, model, confidence, latency, usage, cache hits and fallback reason without copying the classification summary. Pricing and context limits follow the [official model documentation](https://docs.typesafe.ai/models). No new model alias is admitted automatically using an old price.

For an explicit suggestion without dispatch:

```sh
kiln model suggest "Implement and test the CSV parser" --step implement --json
kiln model suggest "Compare approaches to this research problem" --step synthesize --jev --json
```

The first command is local. The second sends only the supplied summary to TypeSafe, using `TYPESAFE_API_KEY` from the environment. Do not include credentials or private material you do not intend to send. Configure the key through your normal secret manager; Kiln does not save it in a run.

The advisor offers four work types: research, ideation, implementation, and synthesis. `--step` supplies the fallback (default: synthesis). Jev is pinned to `jev-1.13.0`; a low-confidence, invalid, unavailable, or timed-out response keeps the fallback. Results expose decision provenance and latency. Kiln's existing compatibility and credential filters then suggest a model and effort. Missing eligible access produces no model suggestion. This command never changes or dispatches a native model. Independent review still requires the actual producer identity through the operator's `route_step` tool.

Provider-free runtime tests verify selection, caching, cancellation, budget accounting and fallback. They do not establish improved task success, latency or end-to-end cost; those claims require a paired live evaluation on representative tasks. The design follows Jev's constrained classification API and the separation of selection from generation described in the [official API](https://docs.typesafe.ai/api) and [LangChain harness article](https://www.langchain.com/blog/building-a-harness-with-jev).

## Hindsight project memory

Use an existing Hindsight server and an explicit project bank:

```sh
kiln memory status --url http://127.0.0.1:8888 --bank example-project
kiln memory retain --file ./verified-project-notes.md --url http://127.0.0.1:8888 --bank example-project
kiln memory recall "Which acceptance checks caught regressions?" --url http://127.0.0.1:8888 --bank example-project --max-tokens 2048
```

`KILN_HINDSIGHT_URL` and `KILN_HINDSIGHT_BANK` can replace the URL and bank flags. Authentication uses `HINDSIGHT_API_KEY` from the environment. HTTPS is required except for loopback HTTP. URL credentials, redirects, and credential flags are rejected.

`status` checks local configuration only. `retain` sends only the named UTF-8 file, limited to 256 KiB, with a content hash and source basename. It requires a confirmed synchronous service response. A timeout can leave retention outcome unknown; Kiln does not automatically retry. `recall` returns bounded JSON explicitly marked as untrusted, retaining service provenance. Recalled material does not become a current requirement or an accepted check. Output is always JSON, including without `--json`.

The request timeout defaults to 10 seconds and is adjustable with `--timeout-ms` up to 120000. Recall defaults to a 2048-token budget, adjustable up to 16384. Responses are capped at 1 MiB. These are request bounds, not guarantees of service latency or billing. Server hosting, storage and model usage remain the operator's responsibility. The wire contract follows Hindsight's [published OpenAPI](https://hindsight.vectorize.io/openapi.json); see its [repository](https://github.com/vectorize-io/hindsight) for deployment.

There is no automatic retention/recall wrapper around model turns. Existing run artifacts and native context remain authoritative. Adopt project memory when repeated cross-run retrieval failures justify its latency and operating cost.

## Browser execution and completion discipline

Enable the experimental tools for a **new native operator run**, with `TYPESAFE_API_KEY` already supplied by your secret manager:

```sh
KILN_JEV_WORKFLOWS=1 kiln
```

This registers `browser_task`, `research_task`, and the internal `kiln_browser_decide` service. These are operator tools, not shell subcommands. `KILN_JEV_WORKFLOWS=0` prevents workflow tool registration for that invocation, including resume; `KILN_JEV_ENABLED=0` disables Jev decisions without removing enabled workflow tools. These overrides do not rewrite the saved policy: removing them on a later resume can restore an originally enabled policy. Enabling workflows is frozen at run creation: starting an old run with the flag does not add them retroactively.

**Browser:** ask the operator to use `browser_task` directly, outside `eval`, on an existing native tab owned by its session. Provide a task, one to eight outcome checks, and exact permitted click/fill/select labels. Supported actions are click, fill, select, scroll and wait; filling requires literal values keyed by exact field label. Checks are `url_equals`, `text_includes` or `field_equals`. The default and maximum segment is eight decisions and 30 seconds. Ambiguous labels, unsupported controls and uncertain action effects return control without replay. A changed target may be reobserved and replanned only when native execution proves no input was dispatched, within the same decision/time allowance. Authentication and recognized consequential controls return to supervised native handling.

Jev chooses an operation and compatible observed target from one batched request. Native ownership and freshness checks surround execution. A receipt with `status: "verified"` means only the supplied fresh checks passed: `quality` remains `specified_checks_only` and `taskQualityValidated` remains `false`. The native adapter returns check results and their observation atomically. The parent must assess whether those checks cover the user's goal. Text generation, arbitrary navigation and every browser control are not supported by this bounded tool.

**Research:** `research_task` accepts a question, named required evidence fields, explicit HTTPS source URLs and exact allowed source hosts, optionally up to three search queries. Defaults are six sources, three concurrent fetches, 30 seconds, 12,000 captured characters per source and 1,800 inline characters; maxima are twelve sources, four fetches, 120 seconds and 6,000 inline characters. HTTPS host filtering is not a DNS sandbox. Retrieved text goes to immutable captured artifacts with hashes, URLs, retrieval times and passage locations. Jev labels support, contradiction, mixed evidence, not-stated or unknown; these labels do not establish source truth. `truthVerified` is always `false`. Captures can be truncated, and missing costs remain unknown. The registered tool has **no automatic browser fallback**: dynamic-page fetch failures remain explicit gaps, and the operator can call `browser_task` separately.

The operator admits at most four active browser/research workflows in total, across workers. Their separate shared Jev allocation defaults to 64 calls and 1,000,000 input-token exposure for new native runs with at least one finite aggregate allocation. When both native allocations are `null`, these default aggregate allowances are uncapped; explicit and saved allowances remain unchanged. Per-request bounds and the four-workflow concurrency limit still apply. Each request reserves 64,000 possible input tokens before dispatch; validated usage settles the reservation, while unknown/interrupted usage retains it, including on resume. For a finite allowance, unknown usage can exhaust the token allocation before 64 calls. Identical concurrent workflow decisions share one physical request; accepted known-usage answers can be reused from a bounded in-memory cache (32 entries, 256 KiB). Identity includes the exact serialized state/questions, operation, pinned model and confidence policy. Cache hits and followers have no additional dispatch/usage/charge and reference the origin request. They do not bypass browser freshness checks. Failures, low-confidence and unknown-usage results are not cached. Cancellation of one caller does not cancel remaining consumers; all callers cancelling or run cancellation aborts the shared request. Cache contents do not survive resume and are cleared on run cancellation; recorded usage counters do survive. Steering cancels its pending workflow callers; exact cached decisions still require current task/state identity and browser freshness checks. The root run's money and cancellation limits still apply. Steering invalidates pending workflow actions. Receipts and captured evidence remain in run artifacts; compact results return to the planner.

This is an actual native adaptation of [jev-ultrafast](https://github.com/browser-use/jev-ultrafast), with its unmodified snapshot vendored at commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46` and MIT license preserved in [vendor provenance](../vendor/jev-ultrafast/README.md). The operation/target controller is adapted to native tab ownership and Kiln accounting. It does not launch the upstream Python agent, a daemon or a second Chrome process. Browser observations and task details, or captured research passages and evidence questions, are sent to TypeSafe for enabled decisions. A [nine-request live qualification](testing/2026-09-28-jev-live-qualification.md) passed three synthetic fixtures. Batched requests used fewer input tokens and less observed time than sequential Jev requests on two fixtures; a third confirmed in-flight/cache reuse. A later native form development fixture completed with two Jev decisions after five incomplete attempts; all outcomes are retained in the report. There is no representative end-to-end throughput or frontier-model baseline.

[unlazy](https://github.com/Leonxlnx/unlazy) informs scoped ownership, explicit acceptance, and parent review. Kiln keeps its existing runtime and the actual saved run allocation, which may be finite or explicitly uncapped. It does not install another task orchestrator or multiply every subtask's budget by tree depth. Build acceptance is revalidated at every builder handoff; a timed-out command cannot pass because its cleanup exits successfully, and a directory cannot satisfy a required file artifact.

For design rationale, alternatives and measurement boundaries, see [Jev design](jev-design.md).
