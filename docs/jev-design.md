# Jev in Kiln: execution with fewer planning turns

Browser and research execution design. The browser and research workflows are experimental and opt-in. A [nine-request live qualification](testing/2026-09-28-jev-live-qualification.md) passed three synthetic fixtures and confirmed their batching/reuse behavior. A native form fixture then completed in two Jev decisions after five incomplete development attempts; all outcomes are retained in that report. Representative workflow throughput, cost-per-success and semantic quality remain unqualified. See [usage and limits](optional-integrations.md) and [workflow validation](testing/2026-09-28-jev-workflows.md).

## What Jev owns

Kiln uses Jev for finite decisions over supplied state. A frontier model establishes the objective, writes code or prose, and assesses the final result. Code owns permissions, accounting, exact checks and execution. Jev does not grant authority or establish scientific truth.

The main architectural choice is to reduce returns to the expensive planner during a supported execution segment. `browser_task` observes the existing owned native tab, asks operation and compatible target questions together, validates freshness, acts, and returns compact evidence. `research_task` captures bounded source text and labels its relationship to explicit evidence questions; the parent handles synthesis. These execution loops keep their own bounded decisions. Separately, [resource routing](jev-resource-routing.md) selects model and effort at human task boundaries, explicit `route_step` requests and new team assignments.

This follows the separation of judgment from generation in [LangChain's harness article](https://www.langchain.com/blog/building-a-harness-with-jev) and the [TypeSafe batched-question pattern](https://docs.typesafe.ai/patterns/fan-out). Questions in a batch refer to the same existing state; an answer cannot depend on a future observation or another answer that has not been consumed yet.

## Reuse the browser, not a second runtime

Kiln vendors the unmodified snapshot from [jev-ultrafast commit 1231850](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46), with its MIT license and [local provenance](../vendor/jev-ultrafast/README.md). Its controller adapts the upstream operation/target decisions to native tab ownership, cancellation and shared accounting. It does not launch the upstream Python Agent, a daemon or an extra Chrome process.

Known deterministic action sequences can already run through native execution without Jev. The experimental controller targets tasks whose next action depends on newly observed state. Exact field values come from the task; it does not generate typing text. Source collection uses existing search/fetch; dynamic-page gaps require a separate browser task.

## Selected improvements and boundaries

- Reuse an identical in-flight or accepted decision only for the exact bounded state, questions, operation, model and confidence policy. One physical request has one accounting identity. This saves duplicate work without inventing a semantic cache match.
- Native browser completion reports checks and their observation together. Shared task/check context guides all decision heads, already-satisfied literal fills are omitted from fresh state, and primitive code checks can trigger atomic verification without another model decision. Recover from stale controls only when the executor proves no input was dispatched, within the existing decision/time allowance. Never retry an input with uncertain effects.
- Prepare team review evidence deterministically from declared criteria and artifact identities. Evidence organization does not accept a handoff or prove that a claimed test ran.

These execution features avoid a classifier before every tool or approval. More classifications are not inherently more efficient: classification followed by unchanged generation is additional work. Deterministic caching, source identity checks, test predicates and arithmetic should remain code. Jev's [documented limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include numeric precision, indirection, distracting state and adversarial content; confidence cannot replace an independent verifier.

Automatic memory retention, candidate rejection based solely on topical relevance, scientific originality judgments, test removal and automatic parent acceptance are outside this design. Hindsight remains explicit project memory. Generic exploration controllers and broad model cascades are deferred until a concrete workload demonstrates removable work.

## How improvement must be established

Compare competent native execution, compact native execution with the same frontier chooser, and that same executor with Jev. Include deterministic scripts where applicable. Hold task set, browser backend, budgets, model effort and independent outcome checks fixed. Measure verified completions per elapsed time and cost per accepted result, including failures, fallbacks, source rereads and rework. Count all model tokens and requests; lower input price does not imply fewer tokens.

Offline tests establish contracts, cancellation, stale-state handling and accounting. They do not establish Jev's semantic accuracy or a general speedup. A saved decision reused once is one avoided duplicate transport, not proof that a frontier-model turn was avoided. Qualify new pinned model versions with the same fixtures and held-out tasks before promotion; a moving alias must not silently change a running controller.
