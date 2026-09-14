# Pilot conclusion and fix validation — 2026-09-09

## Conclusion

**Kiln is not yet validated as a reliable unattended ideation-and-delivery harness under the tested limits.** Its tool-free question-answering path was substantially more successful. The live failures are not an AGI verdict or evidence that the base models cannot solve the tasks; they expose failures and limitations in orchestration, resource allocation, and formation policy.

The earlier [broad pilot](2026-09-09-broad-pilot.md) remains unchanged. This continuation fixed reproducible defects, froze new source versions, and reran previously seen diagnostic tasks. These are development/fix-validation runs, not untouched held-out evaluations or proof of a benchmark advantage. No failed result was overwritten or rescored as a success.

## Defects fixed and verified in code

1. Discovery omitted the configured scout turn limit, silently allowing the scout default of 20 rather than the configured six. It now passes the limit explicitly.
2. Follow-up scouts and direct research could expand without a durable run-level bound. Their allowances now persist across resumes.
3. Discovery could borrow the entire run's resources. It now uses cumulative phase dollar/wall accounting and reserves synthesis capacity. New adaptive research profiles receive explicit, more usable allocations while total targets stay unchanged; the ratios are engineering assumptions, not demonstrated optima.
4. An interrupted scout discarded the opportunity to synthesize successful sibling findings. Research-deadline failures now preserve valid completed checkpoints without inventing missing findings.
5. Native output-token exhaustion looked like successful model completion. It is now an explicit resource error; formation no longer turns that particular failure into conceptual `not_formable` and supports explicit resume.
6. Cancellation could omit an unfinished evaluation arm and its recorded usage. The executor and M1 now persist the arm, censoring, and cost before stopping further work.
7. Paused time consumed the active wall budget because no phase boundary was closed. Cancellation now closes actually open phases once, preserving journal sequence order and excluding paused downtime.

Reflection retains its existing bounded output-length retry after the new error classification. The final source passed **1,671 tests, zero failures**, TypeScript checking and diff checks. These tests verify software behavior, not live task success.

## Live outcomes after changes

| Check | Source / condition | Recorded cost | Result |
| --- | --- | ---: | --- |
| First corrected ideation pair | `2f6d9946…`, balanced phase shares, larger output caps | $5.106672 | Both arms hit research deadlines; zero ideas or judged pairs |
| Delivery runner setup error | Same source, accidentally disabled adaptive routing through an internal dependency flag | $0.488361 | Invalid validation condition; retained separately and excluded from capability conclusions |
| Corrected native delivery | Same source, direct workflow verified before dispatch, 16,384 general / 32,768 critic-auditor tokens, xhigh | $2.96657875 | Critics returned valid decisions, but the second critique rejected the revised formation packet; no build started |
| Final ideation pair | `314b58f8…`, configured scout-turn propagation and successful-sibling preservation added | $4.35367575 | A0 reached synthesis but hit the discovery phase deadline; B0 had one connection error and three scout deadlines; zero ideas or judged pairs |

The final ideation trial used the same previously seen case, output caps, balanced shares, $25 per-run target and one-cell diagnostic limit as the first corrected pair. Production source was frozen within each run. It persisted one censored comparison and correctly left the quality score unavailable. No generator, prober or judge was reached. The source fixes improved boundedness and handling of completed evidence; they did not establish successful ideation.

The corrected delivery run made 13 successful provider calls with no output-token stops or provider errors. Thus the earlier critic-output failure did not recur with the larger declared allowance. However, the specification still contained repairable inconsistencies and unsupported claims, alongside review demands about completeness/platform behavior. Formation ended `not_formable` after the second review. No `slugify.py`, test module, README, build-auditor result, or executable acceptance result existed. This is not a delivered task, and a zero process exit code does not change that.

## What the evidence establishes

- The passing mocked-provider suite was insufficient evidence for reliable autonomous completion. Live qualification was necessary and found failures.
- A six-turn configuration must reach the actual scout constructor; having the field in configuration was not enough.
- Bounded research is necessary but insufficient. A hard cutoff can preserve money/time while still preventing a usable synthesis. Resource allocation must be paired with deadline-aware finalization and recognition of completed artifacts.
- The existing formation protocol can stop a straightforward implementation request on repairable specification feedback. Fixing token handling does not fix that policy limitation, and bypassing valid review would not demonstrate quality.
- Retrieval availability and provider errors also affected the ideation trials. The results do not isolate model intelligence or establish that a different model alone solves the problem.
- No live relative ideation-quality advantage has been measured. The earlier small QA samples likewise do not establish an AGI or biological-discovery advantage.

The next substantive work is completion control: bounded revision until a valid packet is reached or an accurately classified resource/blocker stop occurs; proactive research finalization; and phase allocation informed by measured stage costs. Those changes need fresh live qualification before claiming readiness. Further unchanged benchmark runs would mainly repeat known failure modes.

## Budget and provenance

| Work | Recorded usage |
| --- | ---: |
| Original broad pilot | $34.67900775 |
| First corrected ideation pair | $5.106672 |
| Delivery setup error plus corrected native run | $3.45493975 |
| Final ideation pair | $4.35367575 |
| **Total campaign** | **$47.59429525** |

The authorized budget was $100; it was not exhausted. Recorded usage uses catalog-rate accounting, not a reconciled provider invoice. The corrected ideation ledgers retained $7.82688175 and $8.12405725 above canonical recorded costs for aborted/error-call uncertainty; these are conservative reservations, not additional billed spend. Original pilot reservations remain documented separately. Even summing those allowances with recorded usage stays below the campaign budget. No further paid trials were started after the final diagnostic.

Source fingerprints:

- Original pilot: `7ef356d324bfc8567abd2c2aa0ae170d5257ee58c44b43c9654911500f50ecdc`.
- First fixes / native delivery: `2f6d99465d82c8b2381cb40316f774aa81c313d4303b8aac15a78619d143d170`.
- Final fixes: `314b58f881e12a0e38409fa749472a6687abdd69b8a9bff15c31617cbfbb8f73`.

Raw continuation artifacts, reconciliation files, final source and benchmark runners are archived privately under the local Kiln home's `benchmarks/20260909-conclusion.PDkf70/`. The original archive remains under `benchmarks/20260909-pilot.pVkA8H/`. Source hashes/configuration snapshots accompany each trial; the final source and original pilot source have full archived snapshots. No credentials were copied, no evaluation corpus was modified, and no learning/promotion was enabled.
