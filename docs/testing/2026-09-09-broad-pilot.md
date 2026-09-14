# Kiln broad capability pilot — 2026-09-09

**Result:** the bounded pilot completed, but did not establish reliable end-to-end ideation or delivery. Question answering was much more successful; its apparent BBH improvement was attributable to answer-format compliance in this sample. No AGI, scientific-discovery, or leaderboard-performance claim follows.

| Track | Recorded usage cost | Outcome |
| --- | ---: | --- |
| Public reasoning/biology runtime comparison | $5.41153 | 65 matched items / 130 requests completed |
| Full ideation A0/B0 pilot | $26.8901795 | Both arms censored; no ideas or judged pairs |
| Delivery plus separate recovery diagnostic | $2.37729825 | No runnable artifact |
| **Total** | **$34.67900775** | Within the $100 authorized budget |

## Scope and protocol

The user authorized a $100 total provider-usage budget for an exploratory pilot, not a rigorous leaderboard submission. Planned allocations: $20 for matched public reasoning/biology subsets, $60 for internal A0/B0 ideation comparison, a small delivery track, and unused headroom. Costs below are recorded catalog-rate estimates, not a reconciled provider invoice.

Production code was not changed during measurement. The source snapshot covers all 233 files under `src`, `bin`, `prompts`, plus `package.json` and `bun.lock`, including untracked source: `7ef356d324bfc8567abd2c2aa0ae170d5257ee58c44b43c9654911500f50ecdc`. Base commit: `2e9ffa74852e50cce1afb55ef20d5e860781ed52`. New benchmark adapters/tests are separate from that snapshot. No learning or promotion was enabled.

## 1. Public reasoning and biology subsets

Both arms used Fable 5.1 at xhigh effort, at most 4,096 output tokens, a 90-second request timeout, no tools/retrieval, no provider fallback, no requested cache retention, and no answer-feedback retries. The direct arm received the benchmark instruction; the Kiln arm additionally used Kiln's kernel, model addenda, provider shaping, and native agent runtime. This tests the **tool-free runtime wrapper**, not the full frame/research/ideation/build workflow or automatic UI routing.

The frozen sample contained five ARC-AGI-1 tasks, five ARC-AGI-2 tasks, one example from each of 23 BBH task families, and 32 safety-screened college-biology questions. A deterministic hash ranking selected items before outcomes; execution round-robined datasets and launched the two arms of each pair concurrently. Test answers were excluded by explicit input allowlists, and predictions were written before scoring.

| Public subset | Direct Fable | Kiln runtime | Direct / Kiln 95% Wilson intervals |
| --- | ---: | ---: | --- |
| ARC-AGI-1, n=5 | 4/5 (80.0%) | 4/5 (80.0%) | 37.6–96.4% / 37.6–96.4% |
| ARC-AGI-2, n=5 | 1/5 (20.0%) | 2/5 (40.0%) | 3.6–62.4% / 11.8–76.9% |
| BIG-Bench Hard, n=23 | 15/23 (65.2%) | 20/23 (87.0%) | 44.9–81.2% / 67.9–95.5% |
| Screened MMLU college biology, n=32 | 30/32 (93.8%) | 29/32 (90.6%) | 79.9–98.3% / 75.8–96.8% |

All 130 scored requests dispatched; there was no budget censoring or model substitution. Nine ARC responses hit the output-token limit and remain unsuccessful in the primary scores. Strict grading required exactly the requested JSON object; 12 other responses had prose before valid final JSON and counted as malformed.

**Formatting explains the BBH difference.** A separately labeled post-hoc diagnostic that removed preceding prose gave both arms 22/23 on BBH and 31/32 on biology. Primary scores were not replaced. This provides no demonstrated broad reasoning improvement; the ARC-AGI-2 difference is one item with very wide uncertainty.

Recorded cost: **$5.41153**. Conservative budget ledger: **$6.1389275**, including retained reservations on incomplete responses; this is not additional measured billing.

Direct-arm cost was $2.06959 versus $3.34194 for the Kiln arm. Median request durations were 1.941 and 2.188 seconds respectively. These are small, tool-free requests under this pilot's cache settings, not production-workflow latency/cost estimates.

Sources and reproducibility:

- [ARC-AGI-1](https://github.com/fchollet/ARC-AGI), Apache-2.0, commit `399030444e0ab0cc8b4e199870fb20b863846f34`.
- [ARC-AGI-2](https://github.com/arcprize/ARC-AGI-2), Apache-2.0, commit `f3283f727488ad98fe575ea6a5ac981e4a188e49`.
- [BIG-Bench Hard](https://github.com/suzgunmirac/BIG-Bench-Hard), MIT repository, commit `9ee07bd481feebf959a6b59d61ea57bdcf30964d`.
- [MMLU](https://huggingface.co/datasets/cais/mmlu), publisher card MIT, revision `b4f97952bba29f55186343a7693089e4261f3e22`. Of 144 college-biology test items, 92 were eligible after safety/scope screening and 32 were hash-selected. The 52 exclusions include operational, pathogen-related, clinical, sequence, out-of-scope, and answer-leakage cases. This is a custom foundational-biology subset, not full MMLU or a biology-research benchmark.
- Combined frozen fixture SHA-256: `bb6d9230f2cb22d997caff30df4a633687e01406c66094926969e249ba6891e4`.
- Runtime sampling seed: `kiln-runtime-pilot-v1`, with SHA-256 ranks over dataset, path, and original index; biology's separately frozen screening/sampling protocol is embedded in the runtime protocol. [Runner](../../scripts/benchmarks/runtime-pilot.ts). The private runtime archive contains `protocol.json` (ordered IDs and pinned selection), `execution.json` (configuration hashes), `executed-runtime-pilot.ts`, predictions, primary scores, and format diagnostics.

Public-data contamination is possible. These sample sizes, answer-format rules, and output limits do not reproduce official leaderboard protocols. The Wilson intervals are descriptive item-level uncertainty, not evidence of general capability or AGI.

An initial adapter preflight rejected OAuth byte-encoded request bodies before network dispatch. Its zero-dispatch diagnostic run is retained separately and excluded from scores. The corrected run preserved native provider transport, unchanged items, and recorded protocol/script hashes. Independent review checked answer isolation and reservation accounting.

## 2. Full ideation workflow versus its baseline

The internal M1 pilot uses A0 (full loop) and B0 (bare generation with common framing/research/enrichment), one round, frozen Fable/Opus primary seats at xhigh, and provider fallback off. It is not a comparison against a plain chat answer. No human judge calibration was available; any pair scores would be provisional and could not authorize promotion.

Conditions: $60 campaign target, original $25 per-run planning target and phase shares, 6,144 output tokens per call, 25-minute unit limit and 45-minute overall limit. The first paired-cell reservation projected $27.25; the full twelve-seed ceiling projected $327. A separate conservative stream ledger bounded campaign exposure because phase-share projections are not hard execution caps.

The first A0 case finished as **stopped/deadline with an empty frontier**:

- Frame: 129.594 seconds, $0.69869.
- Discovery: 1,366.535 seconds, $13.18250775.
- Ideation: 0.007 seconds before the deadline stop.
- 99 model calls: 22 brain, 77 scout; zero generator, prober, or judge calls.
- Zero ideas emitted. Total $13.88119775.
- 232 tool calls and 91 search-health records. Retrieval included repeated HTTP 403, 404, 406, and 429 failures, despite successful searches.

This measures a workflow scheduling/retrieval bottleneck, **not poor generated-idea quality**: the generator never ran.

B0 was cancelled at the original 45-minute overall deadline while still in discovery:

- Frame: 115.079 seconds, $0.679387.
- Discovery: 1,088.741 seconds, $12.32959475.
- 88 model calls: 15 brain, 73 scout; zero generator, prober, or judge calls.
- Zero ideas emitted. Total $13.00898175. Maximum individual output was 6,144 tokens in both arms.
- Two scout failures were classified as verification failures following provider internal-server errors. These and failed page fetches are retained, not excluded.

Combined: 187 model calls, **zero judged pairs and no relative ideation-quality score**. The remaining canonical seeds were not reached. B0 had less available time because the overall campaign deadline intervened; this is a censored pilot, not a fair completed quality comparison.

Two accounting/persistence caveats matter. The incomplete native `eval.json` contains only A0 and its cost, not B0; its zero rate/pair-censor counter is not a quality score or evidence of no censoring. B0's `status.json` also remains `running/discover` after the process exited. The terminal pilot report and append-only call records are authoritative for this measurement; original files were preserved rather than repaired afterward.

Canonical records total **$26.8901795**. The stream observer initially reported $26.7241955; the $0.165984 difference is an aborted final request whose partial streamed usage survived in the canonical journal while `stream.result()` returned zero usage. A further $4.3016 reservation is retained as conservative uncertainty, not added to actual recorded spend. `pilot-reconciliation.json` documents the exact reconciliation. [Runner](../../scripts/benchmarks/ideation-pilot.ts).

## 3. Local artifact delivery and recovery

Task: produce a dependency-free Python slug-normalization CLI with executable tests and usage documentation. The first attempt used an $8 planning target and a 6,144-token output cap.

- Initial attempt: stopped during formation on its budget boundary; cost $2.00012. No runnable CLI was delivered.
- Separate recovery diagnostic: preserved the original report/config, changed only the isolated dollar target from $8 to the user's normal $25, and resumed the same run. Total track spending was independently capped at $8 including the original attempt.
- Recovery: both Opus critic requests hit the 6,144-token cap without calling the required `critique` tool. The run ended with an honest exit, `not_formable`.
- Additional recovery cost $0.37717825; **cumulative delivery cost $2.37729825**. No outstanding reservations or production source changes.

No executable artifact existed to independently acceptance-test. A zero CLI process exit code did not mean task delivery; the run's semantic outcome is authoritative. This is a failed delivery result under the pilot's output limits, not proof that delivery is impossible with other settings.

The `not_formable` label should not be read as evidence that a slug-normalization CLI is infeasible: the observed cause was missing critic output after token exhaustion. [Recovery runner](../../scripts/benchmarks/delivery-recovery-pilot.ts).

## Interpretation

The runtime can answer many of the sampled questions, but there is no established raw-reasoning benefit over the same base model. More importantly, live orchestration did not reproduce the confidence implied by a passing mocked-provider test suite: research consumed a whole ideation unit, and formation's critic protocol failed under its output cap.

The next evaluation should follow targeted fixes and use a new source/configuration fingerprint. Priorities are downstream time reservation, bounded retrieval expansion, and output-budget/effort settings that allow decision tools to be reached. Preserve these failed/censored baseline runs; do not overwrite them with successful retries.

This pilot does not provide official GPQA, HLE, Terminal-Bench, SWE-bench, BioASQ, PubMedQA, or other full-suite scores, nor an AGI or biological-discovery claim.

## Artifacts and protocol checks

Raw artifacts are archived privately under the local Kiln home's `benchmarks/20260909-pilot.pVkA8H/`, excluded from its Git index. Archives include runtime predictions/answer isolation protocol, the zero-dispatch preflight diagnostic, screened biology metadata, full ideation records/reconciliation, delivery's original and recovery outcomes, and the measured source plus benchmark runners. No credentials were copied. Archive checksums accompany the report.

Eight new benchmark-protocol tests passed (31 assertions), covering payload answer isolation, scoring, limits, native request decoding and reservation accounting; type checking and diff checks passed. Production source fingerprint was identical before and after the pilot. Passing these protocol tests does not change the live failures above.
