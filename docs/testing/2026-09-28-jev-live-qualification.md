# Live Jev batching and reuse qualification

2026-09-28, `jev-1.13.0`. Nine physical TypeSafe requests exercised three synthetic labeled fixtures. All fixture assertions passed. The [sanitized receipt](jev-live-qualification-2026-09-28.json) contains decisions, usage, timing and application reuse identities, without credentials or private task text.

| Fixture | Sequential Jev requests | Batched Jev request | Result |
| --- | --- | --- | --- |
| Browser decision before input | 3 requests; 659.88 ms; 1,189 input tokens | 1 request; 191.25 ms; 517 input tokens | Both arms selected the expected operation, target and incomplete status |
| Research contradiction | 3 requests; 542.26 ms; 1,060 input tokens | 1 request; 193.57 ms; 484 input tokens | Both arms matched expected relevance, contradiction and coverage labels |
| Missing evidence with reuse | Not a sequential comparison | 3 consumers shared 1 physical request; 483 input tokens | Concurrent follower used in-flight result; subsequent consumer used application cache |

Totals: **9 requests, 3,733 input tokens, 487 output tokens, 4,220 total reported tokens**. No request had unknown usage. At the adapter's pinned rate of $0.042 per million input tokens and free output, calculated cost is **$0.000156786**. This is a calculation from reported usage, not an invoiced charge. The test reserved up to $0.024192 conservatively and used a 30-second per-request deadline; that deadline differs from the normal runtime's 1,500-ms default.

Each sequential/batch arm has one timing observation. Their order is recorded in the receipt. These small fixtures demonstrate functioning live transport, expected labels, batching and exact-state reuse on those inputs. They do not establish a representative accuracy rate, latency distribution, task-success improvement or general token reduction. Application reuse is separate from provider prompt caching. Reused consumers incur no additional physical request; the originating computation remains counted.

The browser fixture classifies supplied text; it does not execute browser actions. The research fixture checks labels against constructed evidence; it does not verify source truth. No frontier-model baseline, paid frontier task completion or full native-browser throughput comparison was measured. Keep the workflows experimental pending representative held-out tasks and independent outcome verification.

## Native browser follow-up

Five subsequent live native-browser attempts did not produce a completed verification receipt. The first four performed one correct fill (`Name = Fixture`) and stopped on the second Jev decision because required confidence was not met; independent inspection found the preview still `Waiting`. The fifth filled and clicked Preview, producing `Hello Fixture`, but its final model decision failed the confidence gate and its receipt remained incomplete. None is counted as a verified workflow success.

| Attempt | Physical requests | Input tokens | Output tokens | Result |
| --- | --- | --- | --- | --- |
| Initial native attempt | 2 | 1,239 | 191 | Incomplete after one action |
| Diagnostic repeat | 2 | 1,239 | 192 | Incomplete after one action |
| Already-satisfied fill pruned | 2 | 1,127 | 158 | Incomplete after one action; click confidence 0.28 |
| Pruning plus visible field evidence | 2 | 1,174 | 158 | Incomplete after one action; click confidence 0.72 |
| Shared task/checks and clearer operation criteria | 3 | 1,929 | 220 | Filled and clicked; observed `Hello Fixture`, but receipt incomplete after final low-confidence decision |

These eleven requests are additional to the nine-request classifier qualification above. The first two attempts each had calculated input-price cost $0.000052038; the pruning and field-evidence attempts calculated to $0.000047334 and $0.000049308 respectively. The shared-task attempt calculated to $0.000081018. These are not invoiced costs. The diagnostic showed the already-satisfied fill action still offered to Jev; its next operation distribution split between typing (0.48) and clicking (0.42), with selected-choice confidence 0.31. The controller correctly declined to execute that uncertain decision.

Omitting already-satisfied fill actions and then exposing current field evidence did not complete the first four attempts. Providing shared task, checks and observations plus clearer operation criteria produced the correct fill (confidence 0.99) and preview click (0.89) in the fifth. An additional model call then chose click with confidence 0.66 instead of terminating, so the controller still returned incomplete despite the observed greeting.

The next correction uses host-owned primitive checks on fresh state to identify a possible completed task, then confirms it through the existing atomic verifier before requesting another Jev decision. Failed candidate checks require no extra RPC. The confidence threshold and `specified_checks_only` quality boundary remain unchanged. The subsequent final development attempt passed, as recorded below.

These repeated attempts informed implementation changes on the same fixture. They are development calibration, not held-out validation or a representative performance benchmark.


### Final native development attempt

The [sanitized native receipt](jev-native-live-2026-09-28.json) records **two Jev requests, two decisions and two actions**, with 1,328 input and 158 output tokens. Calculated adapter-price cost was **$0.000055776**, not an invoice amount. No frontier-model calls occurred in this fixture run.

The controller filled `Name` with `Fixture`, clicked Preview and returned `status: verified` after its atomic text check found `Hello Fixture`. A separate DOM read confirmed both the field value and greeting. The receipt retains `quality: specified_checks_only` and `taskQualityValidated: false`. Cancellation and forged-lease rejection checks passed, and the owned tab was closed. The atomic-completion call-count field in the receipt is explicitly a controller-source assertion, not a measured RPC trace.

Shared task/checks/observations made the action heads goal-aware; already-satisfied literal fills were pruned from fresh state. Host-owned primitive checks then identified completion for confirmation through the atomic verifier, avoiding the unnecessary final Jev decision seen in the previous attempt. The confidence threshold was not lowered.

This is one final success after five documented incomplete development attempts on the same fixture: **six native attempts, thirteen native Jev requests**, in addition to the original nine-request classification qualification. Keep all failures in interpretation. It is not a held-out success rate, a representative browser benchmark, or a frontier-model comparison.
