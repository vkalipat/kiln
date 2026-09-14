# Quality-first routing review — 2026-09-09

## Decision

Prioritize task-relevant measured quality, supported tool execution, and a distinct reviewer model. Vendor diversity breaks equal-score ties; it must not promote an unscored or substantially lower-scoring reviewer. Cost constrains scope and admitted work, not the model-quality ranking. Existing dollar/time targets remain unchanged.

Fable 5.1 and Astra are the principal quality finalists. Neither wins every relevant evaluation, and leaderboard performance does not prove Kiln task performance. The routing snapshot uses separate role categories rather than averaging incompatible scores or double-counting a composite and its components.

## Evidence reviewed

Scores retain their published settings. Percentages from different datasets/harnesses are not interchangeable.

| Evidence | Relevant result | Routing use / caveat |
| --- | --- | --- |
| [AA Intelligence Index v4.3](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index) | Fable 5.1 xhigh/max with fallback and Astra xhigh/max round to 53 | Broad planning prior; tied rounded scores, not a unique winner |
| [AA HLE](https://artificialanalysis.ai/evaluations/humanitys-last-exam) | Fable xhigh 58.71%, Astra xhigh 54.59%, Opus 5 xhigh 54.40% | Difficult text-only knowledge: 2,158 questions, pass@1 |
| [Scale HLE](https://scale.com/leaderboard/humanitys_last_exam) | Astra 54.80±1.94%, Fable xhigh 46.50±2.00%, Gemini 3.1 Pro 46.44±1.96% | Different 2,500-question set and judge; Astra effort unspecified. Do not average with AA HLE |
| [GPQA Diamond](https://artificialanalysis.ai/evaluations/gpqa-diamond) | Astra xhigh 96.3%, max 96.1%; Gemini 3.8 Flash high 95.3% | Near saturation on 198 questions; corroboration, not primary router |
| [ARC Prize](https://arcprize.org/leaderboard) | ARC-AGI-2: Astra max 95.0%, Sol max 92.5%, Fable max 90.0% | Supports Astra for novel abstract reasoning |
| [ARC Prize](https://arcprize.org/leaderboard) | ARC-AGI-3 Astra max: 62.7% standard vs 98.6% provider adapter | Large context/adapter effect; the adapter result is not a Kiln result |
| [SciCode](https://artificialanalysis.ai/evaluations/scicode) | Fable max 63.08%, xhigh 60.88%; Sol max 57.06%, Astra max 56.48%, Opus max 56.37% | Executed scientific-code subproblems, scientist-provided background; Fable uses fallback |
| [Terminal-Bench 4.0](https://www.tbench.ai/leaderboard/terminal-bench/4.0) | Astra max/Codex 58.2±2.8%; Fable max/Claude Code 57.9±3.8%; Opus max 51.8±3.4% | Top 95% intervals overlap; compares model-plus-harness systems |
| [SWE-rebench](https://swe-rebench.com/) | May–June window: Fable 5 high 64.5%, Opus 5 high 63.4%, Sol medium 62.3% | No Astra/Fable 5.1 coverage in inspected window; distinguish model rows from agent rows |
| [SWE-bench Verified](https://www.swebench.com/) / [SWE-bench Pro](https://scale.com/leaderboard/swe_bench_pro_public) | Inspected defaults lack current Astra/Fable/Sol coverage | Useful software-task methodology; no missing-model rank inferred |
| [AA-Briefcase](https://artificialanalysis.ai/evaluations/aa-briefcase) | Fable xhigh 1650, Opus xhigh 1625, Astra xhigh 1534 Elo | Professional business deliverables favor Fable/Opus |
| [GDPval-AA v2](https://artificialanalysis.ai/evaluations/gdpval-aa) | Fable xhigh 1745, Opus xhigh 1708, Sol xhigh 1585, Astra xhigh 1555 Elo | Corroborates professional-output choice; not startup-success prediction |
| [AA-Omniscience](https://artificialanalysis.ai/evaluations/omniscience) | Astra high 43.73, Fable xhigh 42.38, Opus xhigh 35.38 index; [GPT-5.5 xhigh](https://artificialanalysis.ai/models/gpt-5-5) 20.52 | Calibration-aware answering proxy, not validated judge performance. Fable max 43.45 is close to Astra high |
| [AA-LCR v1.1](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning) | Kimi K3 max 88.67%, Fable max 85.33%, GPT-5.5 xhigh 84.33%, Sol max 84%, Astra max 80.67% | 10–100k-token document reasoning, not million-token retention; no automatic routing by advertised window size |
| [DeepResearch Bench](https://deepresearch-bench.github.io/) / [live leaderboard](https://huggingface.co/spaces/muset-ai/DeepResearch-Bench-Leaderboard) | Complete research systems; September 1 judge migration with incomplete re-evaluation | No recovered comparable Astra/Fable/Sol base-model rows; separate report quality from citation correctness |

[AA methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking) changed in September: v4.3 uses ten evaluations and includes Terminal-Bench 4.0 with its own mini-SWE-agent setup. That is distinct from the official Terminal-Bench table's Codex/Claude Code submissions. GPQA is no longer in the composite. Old/new index versions must not be mixed.

BrowseComp, MRCR and FrontierMath were not independently verified in this review; no numbers or routing advantages are claimed from them. No benchmark above directly establishes novel-idea quality, safe clinical applicability, or autonomous research reliability.

## Recommended and executable roles

- Planning, ideation, professional deliverables, scientific-code production: Fable 5.1 is a defensible primary under the reviewed evidence. It is not universally superior on reasoning.
- Difficult terminal execution and calibrated cross-checks: Astra is a preferred quality candidate alongside Fable. Calibration evidence supports high effort; terminal results are at max. These do not validate Astra low for the same workloads.
- Current connected executable fallback: Fable 5.1 produces, Opus 5 reviews. Opus's measured calibration is much stronger than GPT-5.5's; same-vendor correlated-error risk is disclosed. External checks remain authoritative.
- GPT-5.5 remains a compatibility/recovery alternative, not the preferred reviewer merely because it belongs to another vendor. Sol/Gemini/Kimi have useful category results but are not promoted based on unsupported transport, absent credentials, or missing matched evidence.

The user's existing Ultra/xhigh settings are preserved. Benchmark effort and fallback/harness conditions are stored per entry; mismatches with actual run effort are disclosed. Maximum effort is not automatically best: Astra's calibration index is higher at high than max in this evaluation. Further effort changes require task evaluations, not a universal max toggle.

## Compatibility boundary

Installed pi 18.1.14 and inspected published catalog 18.1.16 mark `openai-codex/gpt-6-astra` as `code_mode_only`; neither supplies direct `openai/gpt-6-astra`. Kiln has no Code Mode execution adapter. Astra is therefore explicitly excluded from executable plans rather than silently represented as running.

[Official Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) supports function calling through Responses. A verified direct-API model registration is a plausible smaller integration, but needs appropriate credentials, correct API pricing/cache handling, and a live tool roundtrip. A dependency upgrade or deleting the eligibility check is insufficient. No Astra integration or account entitlement is claimed by this routing change.

## Implementation and verification

The new dated snapshot preserves source, metric, effort and evaluation conditions. Reports expose unavailable ranked models with concrete reasons. Adaptive critic/auditor execution honors the selected independent model; quality-first island assignment uses primary generation/probing seats, not routine rotation through recovery alternatives. Historical frozen reports and explicitly injected evaluator islands preserve their previous assignment policy.

New plans use reviewed quality-first evidence; saved runs retain their frozen evidence and model lists. The local benchmark snapshot is backed up before import. No paid model calls, new provider connections, budget increases, or publication are part of this review. Unit/integration tests verify ranking, tie-breaking, exclusion disclosure, distinct identities, actual reviewer dispatch, and island-policy compatibility; they do not validate model output quality.

Verification: **1,642 tests passed, zero failures**, 10,254 assertions across 184 files (132.06 seconds); type checking and diff checks passed. Independent review found no blocking issue. Offline previews confirmed the $25 target is unchanged and actual producer/reviewer selections match the policy.
