# Kiln validation

These records describe tested software behavior and its limits. A completed model turn, passing fixture, or recorded routing decision does not establish task quality. Earlier design proposals and narrative reports remain in Git history.

## October 4, 2026 audit and fixes

All nine findings from the local tool, interface, and capacity audit were addressed in the working checkout. The linked CLI and installed plugin helpers received the fixes. The CLI remains 0.1.2; plugin registration remains 0.1.1. This work was not a published release or a remote CI run.

| Finding | Verified result |
| --- | --- |
| Credential inheritance | Real native parent and child fixtures hide credential variables from Bash and JavaScript evaluation. Forced Worker fallback and Python alias filtering pass. Synthetic secret content is redacted from native messages and saved sessions. |
| Plugin completion | Failed and live runs report their actual state. A stopped legacy checkpoint reports `awaiting_delivery`. Native turn completion keeps `taskQualityValidated: false`. |
| Task options | Boolean options preserve prompt text. Unknown, duplicate, missing-value, and inapplicable options fail before dispatch. |
| Budget admission | Smaller affordable requests pass an impossible queue head. Child denials and timeouts preserve parent work. Top-ups include existing reservations. |
| Transcript scaling | Indexed entries and cached layouts avoid repeated full-history work. Terminal and masked-input fixtures pass at four sizes. |
| Product controls | Native plugin start, resume, steer, and pause pass. The palette exposes fresh tasks, monitoring, limits, integrations, and automatic effort. |
| Dependency compatibility | All six packages pin 18.6.1. Frozen installation and both reviewed patch contexts pass. Tampered or misplaced patches fail closed. |
| Accounting scaling | Flushed journal deltas replay every charge, including unknown exposure. Torn history refuses dispatch. Incremental and full monitor totals agree. |
| Workflow capacity | Four active workflows share a cancellable queue of 64 callers. A 72-call research plan under a 64-call allowance performs no classification and retains captured evidence. |

The final full suite passed 2,375 tests with zero failures across 261 files in 179.70 seconds. Typecheck, documentation links, evaluator verification, leak checks, frozen installation, and patch-context checks passed. No real provider requests or user workloads were launched in this audit.

| Synthetic local fixture | Before | After |
| --- | --- | --- |
| Animation tick with 5,000 transcript entries | About 69 ms | About 0.01 ms; initial layout about 13 ms |
| Meter and monitor with 1,500 requests | About 2,487 ms | About 1,124 ms |
| Team claim response with 32 features | 17,270 UTF-8 bytes | 997 UTF-8 bytes |

These timings exclude provider and backend latency. Response bytes are not billed tokens. The fixtures do not establish a live throughput, cost, or task-quality improvement.

Five saved native runs received a read-only catalog check. Three passed; two have frozen catalog mismatches. One also mismatched the prior catalog. The other differs because the update changes model metadata. Records remain intact. Compatible original dependencies or a reviewed new task are required; these checks do not prove live resume succeeds.

ReasonBlocks start returned HTTP 401. No telemetry run was created. Local checks continued, and the finish attempt reported the missing run.

### Retained evidence

- [Final summary](testing/2026-10-04-fixes/results.json) and [full test log](testing/2026-10-04-fixes/test-results.txt)
- [Performance measurements](testing/2026-10-04-fixes/performance.json)
- [Terminal checks](testing/2026-10-04-fixes/ui.json) and [rendered fixtures](testing/2026-10-04-fixes/ui-render.txt)
- [Saved catalog checks](testing/2026-10-04-fixes/saved-catalogs.json) and [automatic-effort resume checks](testing/2026-10-04-fixes/auto-resume.txt)
- [Native credential checks](testing/2026-10-04-fixes/native-credentials.txt)
- [Offline doctor](testing/2026-10-04-fixes/doctor.json), [dependency check](testing/2026-10-04-fixes/frontier.json), and [documentation receipt](testing/2026-10-04-fixes/docs.json)
- [Evaluator verification](testing/2026-10-04-fixes/evals.json) and [leakcheck](testing/2026-10-04-fixes/leakcheck.json)
- [Baseline summary](testing/2026-10-04-audit/results.json), [baseline tests](testing/2026-10-04-audit/test-results.txt), and [baseline terminal rendering](testing/2026-10-04-audit/ui-render.txt)

## October 4 frontier and routing overhaul

The scheduled updater failed because its old callback patch did not match the new native SDK. The corrected baseline pins all six packages to 18.6.1 and verifies both installed patch contexts. Future compatible dependency updates pass the full gates before the isolated publisher opens and merges the exact verified PR. Tests cover changed bases, altered PR files, substituted bytes, and recovery of a prior verified draft.

GPT-6.1 Sol passes metadata admission through both installed OpenAI transports. Codex admission follows the supported tool contract. The bounded routing catalog retains new family revisions, and Jev receives every compatible shortlisted choice. Missing benchmark scores remain unknown; an uncertain classifier retains a compatible current route or uses reviewed fallback evidence. Exact model and effort choices still win.

The final local suite passed 2,381 tests with zero failures across 261 files in 175.60 seconds. Typecheck, documentation links, evaluator verification, leak checks, frozen installation, and both patch contexts passed. Sol fixtures execute the custom tool path and native Bash tool, then resume the saved model at max effort. All model transport in these fixtures was mocked; they do not measure live output quality or provider throughput. See the [overhaul receipt](testing/2026-10-04-fixes/frontier-overhaul.json).

## Earlier qualifications

| Record | What it establishes | Boundary |
| --- | --- | --- |
| [September 30 Jev routing](testing/2026-09-30-jev-resource-routing.json) | A routine fixture selected a cheaper model at minimal effort. Two harder fixtures used recorded conservative fallbacks. Nine classification calls across three attempts are retained. | Selected models were not executed. This is selection behavior, not workload quality. |
| [September 28 Jev transport](testing/jev-live-qualification-2026-09-28.json) | Nine physical requests passed three synthetic fixtures for expected labels, batching, and exact-state reuse. | Each timing comparison has one observation. The run used a longer timeout than the normal service default. |
| [September 28 native browser](testing/jev-native-live-2026-09-28.json) | A development fixture filled a field, clicked Preview, and passed its stated checks with two Jev decisions. | Five prior attempts were incomplete. This is calibration on one fixture, not held-out browser performance. |
| [Research recovery](../test/ideation/recovery-change-evaluation.results.json) | Seventy-two fixture traces preserve completed research and avoid repeated work after supported interruptions. | The comparison isolates persistence policy with fixture providers. It is not a whole historical-harness benchmark. |
| [Direct task behavior](../test/benchmarks/direct-change-evaluation.results.json) | Concrete tasks can skip unnecessary framing and redundant review while retaining required checks. | Assertion-backed compatibility cases do not establish measured provider latency or billed savings. |

Earlier paid pilots included failed or incomplete research, idea comparison, formation, and delivery. They did not establish reliable unattended completion or a completed paired idea-quality advantage. Passing later local tests does not turn those failures into successful live outcomes.

The retained [Virtual Cell smoke helper](../scripts/benchmarks/vcc-smoke.py) and [dependency lock](../scripts/benchmarks/vcc-smoke.requirements.lock) support a CPU scorer-integration fixture. It used synthetic counts with `cell-eval2` 0.16.0 and Scanpy 1.12.4. The fixture produced finite official-preset metrics, not a trained model, real-data prediction result, or leaderboard score. Conditional EGFR and Virtual Cell briefs remain prepared inputs, not completed challenge packages.

Live provider access, entitlement, current quotas, representative task success, and scientific performance need separate evidence. Catalog metadata, model rankings, source hashes, and classifier confidence do not establish those results.

## Reproduce local checks

Use the commands in [development](README.md#development). The suite uses disposable fixtures and mocked model or service transport. Paid comparisons require their own explicit budget and authorization. Preserve failed attempts, unknown usage, source versions, and data identity when comparing results.
