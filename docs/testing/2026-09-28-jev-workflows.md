# Bounded Jev workflow acceptance

Status: final frozen-source repository suite, compiler and whitespace checks pass. Independent workflow and native runtime registration tests pass, and the strengthened native lease passed a real cmux local-fixture smoke with deterministic decisions. No paid calls or live model-performance conclusions are authorized by this record.

The acceptance boundary is observable workflow behavior: preserve requirements and evidence, reject stale/unsupported actions, stop cancellation, retain unknown usage, and require independent completion checks. Finite model outputs are not completion evidence.

## Intended adversarial cases

| Workflow | Required outcome |
| --- | --- |
| Browser capture fails | No classification or action based on invented/empty state. |
| Browser target changes after observation | No action on a stale target; bounded fallback or explicit failure. |
| Browser DONE with unmet requirements | Verification rejects completion. |
| Unsupported browser control | Native fallback remains available; unsupported is not task success. |
| Cancellation during capture/model/action I/O | No subsequent side effect or false completion. |
| Research incomplete or contradictory evidence | Original evidence remains available; unknown is not upgraded to support. |
| Research source bytes change after preparation | Old classifications do not authenticate new artifact bytes. |
| Missing provider usage | Unknown exposure remains distinct from zero cost. |
| Batching comparison | Count actual intercepted requests in both arms; keep identical fixture state/questions and verifier. |

## Measurement contract

`scripts/benchmarks/jev-workflows.ts` uses only deterministic injected transports and controlled local fixtures. Request reduction means observed transport invocations, not an assumed one-frontier-call-per-decision baseline. Mock tokens, elapsed time and successful fixture outcomes are not provider economics, latency or semantic model quality.

## Observed results

`bun test test/usecases/jev-workflows.test.ts` passed **18 tests, 86 assertions**, in 136ms for the recorded slice. These exercise production workflow functions and the actual shared service/meter/adapter using deterministic injected I/O. `git diff --check` for the three owned files passed.

The browser cancellation test initially failed: an uncooperative observation promise prevented cancellation from returning. The implementation owner added a bounded abort/deadline race; the same regression then passed. Research capture mutation during classification led to a rehash check; independently changing captured bytes now yields a changed-integrity/partial receipt with affected fields unknown. Unknown provider usage retains dollar and token exposure across a resumed service under an explicit 100,000-token allowance.

Browser assertions cover failed captures, failed/missing/wrongly bound independent checks, unsupported controls, stale targets, uncertain action acknowledgement without replay, and no mutation beyond the explicit action allowance. A receipt whose supplied checks pass still has `taskQualityValidated: false`; the test deliberately gives a broader task than its supplied assertions. Research assertions preserve full captured bytes even when model context is bounded, retain contradictions, keep missing requirements unknown, reject invented evidence locations, and stop fetch/classification cancellation without false claims.

`bun scripts/benchmarks/jev-workflows.ts` passed both fixtures with matching externally specified answer/acceptance outcomes:

| Fixture | Separate Jev requests | Same-state batch requests | Separate serialized bytes | Batched serialized bytes |
| --- | ---: | ---: | ---: | ---: |
| Relevant contradiction | 3 | 1 | 885 | 633 |
| Incomplete and uncertain evidence | 3 | 1 | 906 | 640 |

The transport intentionally returns no usage counters. The report leaves `frontierRequestsDisplaced`, `providerTokens`, `providerCostUsd`, and `providerLatencyMs` null. This is a **separate-Jev-versus-batched-Jev transport comparison**, not a native frontier or end-to-end task benchmark. The observed byte reduction is not a billed-token estimate. Supplied deterministic answers do not establish Jev semantic accuracy.

Local output records: `/tmp/kiln-jev-workflows-tests.log` and `/tmp/kiln-jev-workflows-benchmark.json`. The benchmark emits its adapter source hash and fixture hashes so later runs can identify changed code/data.

## Native runtime registration acceptance

`bun test test/operator/workflow-runtime.test.ts test/usecases/jev-workflows.test.ts` subsequently passed **24 tests, 125 assertions**, in 1.001s. Log: `/tmp/kiln-jev-workflows-integration.log`.

The six additional runtime cases create the production operator with a fake native session, invoke its actually registered tools, and exercise production workflow wiring. They verify:

- `research_task` uses real HTML extraction, research question construction, batch transport, shared service, per-worker external meter rows and durable receipt publication; citations match captured artifact bytes, contradiction survives and unassessed evidence stays unknown.
- `kiln_browser_decide` charges one batch to the calling session and only uses accepted selected heads; an uncertain unselected head does not grant execution authority or prevent a supported selected decision.
- `browser_task` calls that actual registered decision service through the production bounded workflow and returns incomplete when an independent check fails. The receipt is persisted and remains unvalidated for whole-task quality.
- Explicit disablement and a new run without API/environment opt-in both omit workflow tools and their internal bridges.
- Steering an active native turn invalidates in-flight uncooperative research I/O; no further classification occurs and unfinished evidence remains unknown.

The browser executor is injected in these runtime tests. They do not establish that real cmux pages, cross-realm native script transport, or live sites behave identically; native bridge/DOM tests remain separate evidence.

## Final frozen-source acceptance

The final full-suite log was inspected directly at `/tmp/kiln-jev-full-suite.log`:

| Gate | Result |
| --- | --- |
| `bun test` | **2,198 passed, 0 failed; 13,350 assertions across 242 files; 173.32s** |
| `bunx tsc --noEmit` | Exit 0, reported by the parent validation run |
| `git diff --check` | Exit 0, reported by the parent validation run |
| `bun bin/kiln.ts evals verify --home . --json` | `ok: true`; manifest and split checks pass |
| `bun bin/kiln.ts evals leakcheck --home . --json` | `ok: true`; no reported leakage rows |

The real cmux smoke was rerun after strengthening the tab lease to require a random lease token bound to the original owned tab object. A forged token was rejected before observation or action. With the valid owned lease, the controlled local-page workflow completed **three deterministic decisions and two browser actions**. An independent DOM read confirmed the intended final state. **Zero model calls** were made, and the owned tab was cleaned up. This validates the exercised native bridge/lease/action path, not model decisions or arbitrary website coverage. The smoke owner supplied this evidence separately from the injected-runtime tests.

ReasonBlocks initialization returned **HTTP 401 Unauthorized**. No run ID existed, so no step/finish receipt could be recorded. The harness outage did not trigger duplicate execution or replace local validation evidence.

The Word manual was regenerated from the current user manual and architecture appendix using the managed Codex document runtime. All ten rendered pages were visually inspected: no clipping, overlapping text or split table rows were found. The Markdown manual remains the editable source; both documents describe the experimental workflow limits and remaining live-service qualification.

## Remaining boundaries

`TYPESAFE_API_KEY` was absent from the validation process environment; only presence was checked, never a credential value. No paid model request, external-site task qualification, cold/warm model-latency sample, native frontier comparison, or invoice reconciliation was performed. The real browser smoke used a controlled local page and deterministic decisions. Live Jev semantic accuracy, cost and end-to-end performance remain unqualified. A browser success concerns only the explicitly supplied checks. Research receipts are untrusted evidence collections, not verified answers.

## Subsequent release iteration

The next implementation and independent review loop added exact-state Jev request reuse, atomic browser completion evidence, bounded recovery from proven pre-input staleness, and deterministic team review packets. The public [design decision](../jev-design.md) explains why these were selected over adding more classifiers.

The final full-workspace suite passed **2,219 tests, zero failures, 13,469 assertions across 243 files in 177.31 seconds** (`/tmp/kiln-v1-release-full.log`). TypeScript, evaluation manifest/split verification and leak checks passed. The focused integration slice passed 62 tests and 320 assertions. This workspace includes five historical VCC tests excluded from the public release; GitHub CI on the actual release commit is the authoritative published-tree count.

- Three concurrent identical service evaluations issued one physical request, reservation and settlement. A later cache hit required no additional request. Fixture usage was supplied, not measured provider usage. Independent cancellation, unknown exposure, generation changes and copy isolation passed; sanitized reuse events identify the original request without recording source content.
- The actual native cmux smoke passed again: three deterministic decisions, two actions, matching independent DOM evidence, zero model calls, forged ownership rejected before observation, cancellation and owned-tab cleanup. Final checks and observation now come from the same DOM evaluation. The absence of a second controller completion observation was checked by a source assertion, not a measured RPC counter. Uncertain execution is never replayed; truncated control tables cannot certify field checks.
- Team packets preserve every original criterion, explicit unmapped states and unverified worker claims. Missing, changed or dependency-drifted evidence invalidates identity. Packets do not grant acceptance or prove task quality; legacy unassociated handoff details remain available through `team query`.

The ten-page release manual was rendered and reviewed again. All hyperlinks are HTTPS targets; no local filesystem hyperlinks or personal home paths remain in its XML or relationship files. Staged source patterns contained no detected credential-shaped tokens. Unified patch context is excluded from whitespace diagnostics through `.gitattributes` because its leading context marker is required; the reviewed patch bytes remain unchanged.
