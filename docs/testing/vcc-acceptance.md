# Virtual Cell Challenge completion acceptance — draft protocol

Native acceptance status: **proposed, not executed**. The separately authorized CPU scorer integration smoke below has completed. Public-source inspection: **2026-09-14**. Freeze code, this protocol, model configuration and input hashes before any new provider call. This is a bounded computational software/completion test, not a leaderboard submission or a promise to outperform all teams.

## Scope and spending

- The controller announced a **new, shared $25 estimated-exposure ceiling** for this completion pass within the user's task. The user did not specify that numeric amount. This is separate from the earlier broad benchmark campaign; it is not a reset of that campaign's ledger or permission for unmetered trials.
- Include every new provider preflight, native run, critic/judge/auditor call, retry permitted by the frozen native policy, and unresolved in-flight reservation in the same ledger. Report actual usage and conservative exposure separately; neither is a provider invoice.
- No provider dispatch until the parent approves the frozen source/protocol. No automatic recovery, budget reset, model fallback or second trial after a terminal outcome.
- No wet-lab activity, leaderboard submission, account registration/consent, GPU rental, data purchase, private-data access or clinical claims. Do not alter the user's separate later query/run.
- Newly implemented biological-task routing and QuickJS/CodeMode support are prospective conditions. Preserve historical frozen routing; do not retrofit new model preferences into an old run by editing its status/configuration.

## Preserved baseline

The controller retains the exact original seed, run identifier and before-state hashes privately. The user asked to inspect current Virtual Cell Challenge progress and create a system that achieves the challenge's goal and exceeds existing teams. First place remains an aspiration, not an acceptance criterion that can be asserted without authorized official evaluation.

Observed historical state:

| Measurement | Preserved result |
|---|---|
| Terminal state | `failed`, phase `ideate`, `refusal: bio` |
| Recorded provider cost | $14.73636075 |
| Model calls | 80 |
| Output tokens | 236,651 |
| Other recorded token counters | input 1,347; cache read 426,070; cache write 734,540 |
| Ideas | 8 unranked archive entries |
| Prior art | 3 `not_falsified`, 5 `search_failed` |
| Search health | 0.375; novelty enforcement disabled |
| Executed probe | One synthetic, hypothesis-conditioned CPU simulation, reported pass |
| Delivered trained system / official score | None |

The probe explicitly used assumed parameters and oracle modules. Its pass is not evidence of performance on measured perturbation data or any official VCC metric/leaderboard. Likewise, `not_falsified` is not a novelty certification; the stored reasons contain retrieval limitations.

Comparison must retain failures, cache tokens, stopped calls and costs. Report new totals beside this baseline, identifying changed code/models/data conditions. Do not call the comparison a randomized benchmark or manufacture a percentage improvement from a baseline with no completed deliverable.

## Official challenge facts to capture in the delivered artifact

The [official 2026 overview](https://virtualcellchallenge.org/) and [data page](https://virtualcellchallenge.org/datasets) describe zero-shot context transfer: no new Challenge training set; unperturbed controls and 300 target genes for three anonymized validation contexts A/B/C, followed by three different final contexts D/E/F. Existing public or proprietary data may be used only when the entrant has the rights to use it. Final data release is October 22 and final submission deadline November 5, 2026.

The [official evaluation specification](https://virtualcellchallenge.org/evaluation) requires one `.vcc` package containing all three contexts, `obs.target_gene` as gene symbols, 400 cells per target/context, 18,533 genes in the supplied order, finite nonnegative whole raw counts, no non-targeting prediction rows, at most 4,750,000,000 stored matrix entries, and at most 1,000,000 counts per cell. This is 360,000 prediction cells. Dense storage exceeds the stated entry cap; explicitly stored zeros count toward it. Exact column/packaging behavior must be checked against the pinned [official CLI guide](https://vcc-cli-wiki.virtualcellchallenge.org/) before implementing the adapter.

Scoring uses [`ArcInstitute/cell-eval2`](https://github.com/ArcInstitute/cell-eval2) with its **`vcc2026` preset**, not the old 2025 three-metric profile. The scored metrics are PDS, expression MSE, DE log-fold-change NMAE, direction fidelity, direction reach and significance Jaccard. The targeted gene is excluded from all six. The official overall is an unweighted average of reference-scaled scores over six metrics and three contexts. Zero represents the context-mean baseline and one a real-replicate reference; the overall is **not a percentage or bounded accuracy**. Local subset numbers and validation/final panels are not directly interchangeable.

The public [leaderboard](https://virtualcellchallenge.org/leaderboard), inspected on the date above, displayed Illumina AI / PerturbationAI first at overall **0.2812** and 945 teams. This is a dated observation, not a frozen target or evidence about the proposed method. Recheck only if needed before the source freeze; never probe the leaderboard as an optimization oracle.

## Data availability and rights

Filename-only inspection found **no matching `.h5ad`, `.vcc`, VCC or virtualcell-named files** under the two specifically authorized local roots: Downloads and the agents workspace. No patient-file contents or unrelated user data were read. This does not establish that no data exist anywhere else.

- The official 2026 controls bundle is approximately **630 MB** and requires registration/login. Its perturbation-response labels are withheld. Do not download or consent under this protocol.
- Arc's [Virtual Cell Atlas page](https://arcinstitute.org/tools/virtualcellatlas) explicitly labels the **2025 VCC H1 dataset CC0 1.0**. This can support a later licensed public-data proxy, but the inspected public mirror reports approximately 15.5 GB and is not an approved small fixture. Do not treat the mirror's old 2025 format as the 2026 contract.
- Official recommendations include multi-cell-line Perturb-seq datasets, but the listed files are multi-gigabyte. A small real-count slice has **not yet been verified or downloaded**. A genuine cross-cell-line transfer result requires suitable donor/held-out contexts and controlled outcome access, not merely a convenient single-context slice.
- `cell-eval2` code is [MIT-licensed](https://github.com/ArcInstitute/cell-eval2/blob/main/LICENSE), supports Python 3.11+ and a CPU-only installation, and supports CPU DE through explicitly selected `pdex` or `scanpy`. Pin the package/commit and DE engine: backend differences must not masquerade as model improvements. Do not silently substitute another backend.

### Minimal safe metric fixture

The official [`tests/conftest.py::graded_counts_real`](https://github.com/ArcInstitute/cell-eval2/blob/main/tests/conftest.py) is a small, reproducible **synthetic** fixture despite the word `real` in its name: seeded Poisson counts, 120 genes, 200 control cells and 200 cells for each of four perturbations (1,000 cells total). Its targets resolve against the gene index, making it useful for testing the target-exclusion and DE gates. The dense numeric array alone is about 480 KB as float32.

After reviewing and pinning the fixture source, it may be used for a **scorer/adapter regression test**, with exact upstream parameters preserved and all deviations logged. It is not biological data, a valid 2026 submission, a zero-shot transfer benchmark or proof that a learned model improves on real experiments. The existing user-authored synthetic probe is not substituted for it.

### Completed CPU scorer integration smoke

The [test-only smoke helper](../../scripts/benchmarks/vcc-smoke.py) ran successfully in an isolated CPython **3.12.9** environment with **cell-eval2 0.16.0**, explicit **CPU / Scanpy 1.12.4** DE, two numerical threads, and the full **`vcc2026` preset**. No GPU extras, models, registration, training or provider calls were used. The [platform-specific dependency lock](../../scripts/benchmarks/vcc-smoke.requirements.lock) pins the 55 audited binary wheels for macOS arm64; no wheels are vendored in the repository. Every download was below 50 MB (largest 43,331,099 bytes; total wheel bytes 175,642,068, explicitly approved for this installation).

Pins:

- Official source commit: [`5e64833518a6603a0301cbe28185d49c30f4a986`](https://github.com/ArcInstitute/cell-eval2/commit/5e64833518a6603a0301cbe28185d49c30f4a986).
- Package wheel SHA-256: `c78428ba705a94536e4a55464a34d1905aa5730d4f7e52ea8dbef4e7171d4fbe`.
- Complete upstream `tests/conftest.py` SHA-256: `44b6f710239028944889a94712a26c28e0d66906cf0ec03e0bba776e8442f9ab`. Its MIT notice is retained beside the source. The helper verifies this hash, extracts only the reviewed `_GRADED_EFFECTS` constant and `graded_counts_real` function, and removes only the pytest-registration decorator. It does not execute unrelated fixture code or alter the fixture parameters.
- Executed final helper SHA-256: `2962bbf276eb414ff9e76d210a855986dc25b872efb09b645a0261632711fbc4`.

Two diagnostic input pairs passed: reference-as-prediction identity and resampled-control/no-effect counts. Neither is a learned model. Each produced **36 finite per-perturbation rows** and **10 finite upstream aggregate rows**, including all six scored metric names and four diagnostics. Identity PDS/Jaccard equal one and identity log-FC NMAE equals zero, as scorer sanity checks. Total final wall time was **14.61 seconds**. The helper's three offline guard tests (six assertions) also passed.

Two API integration distinctions were found and corrected, with the earlier failed receipts preserved:

1. `compute_metrics` requires matching group labels, including control, on its paired AnnData inputs. The fixture pairs therefore include controls. They are **not submission files**: the actual 2026 upload contract excludes control predictions.
2. `expr_mse_unbiased_capped_norm` is a panel-level ratio-of-sums generated by the upstream `aggregate_metrics` API, not a missing per-perturbation row and not a mean of invented ratios. The helper uses that API directly.

The retained outputs are **raw metric values and upstream aggregates**, not reference-anchor-scaled VCC leaderboard scores. In particular, the raw normalized MSE diagnostic is approximately -0.0110 for identity and 1.0064 for control resampling; these must not be interpreted as the final leaderboard's bounded, scaled expression score. No official overall score is computed. Biological predictive performance remains unmeasured.

The private artifact directory retains the complete dependency/download manifests, verified wheels, isolated environment, upstream source/license, both earlier failed attempts, passing runs, exact executed helper, effective configuration, synthetic H5ADs, raw/aggregate CSV and JSON, logs and command receipts. Reproduction with that retained wheel directory is:

```bash
uv venv --python 3.12 <ARTIFACT_ROOT>/.venv
uv pip install --offline --no-index --find-links <ARTIFACT_ROOT>/wheels \
  --only-binary :all: --require-hashes \
  --python <ARTIFACT_ROOT>/.venv/bin/python \
  -r scripts/benchmarks/vcc-smoke.requirements.lock
<ARTIFACT_ROOT>/.venv/bin/python scripts/benchmarks/vcc-smoke.py \
  --fixture <ARTIFACT_ROOT>/upstream-conftest.py \
  --out <ARTIFACT_ROOT>/results-final
bun test test/benchmarks/vcc-smoke.test.ts
```

Use a new output directory: the helper refuses to overwrite a previous result. A different platform requires another compatible-wheel size/hash audit. This completed smoke satisfies only the scorer-integration portion of gate B; it does not complete the native VirtualCell system or the real-data performance gate.

## Acceptance gates

### A. Correct challenge context and honest candidate selection

1. Produce a source-linked `challenge-context.md` that separates confirmed official 2026 facts, dated leaderboard observations, assumptions and unresolved access requirements. Correct historical guesses; do not perpetuate 2025 schema/metric rules.
2. The actual native harness performs research, candidate generation, required novelty/evidence checks, comparison and a genuine checkpoint selection. Preserve all candidate failures and declared refusal outcomes. Eight IDs alone do not establish eight distinct mechanisms or a deliverable.
3. Verify the selected idea's dossier/render hashes, completed comparison orders and minimum comparison count, admissible evidence/coverage, source access results and explicit probe disposition. No missing/refused verdict counts as a valid vote. Optional probe refusal can be a recorded `not_run`/refusal disposition only when the frozen policy permits continuation; it is never a passing experiment.
4. A controller-side manual audit checks the selected mechanism's distinction from retrieved methods and its compliance with the computational scope. `not_falsified` and numerical judge preferences do not establish novelty or real-world feasibility.

### B. Runnable computational system and official-metric integration

The delivered project must include a documented input schema, runnable prediction entry point, deterministic configuration/seeds, dependency/version lock, tests and a README of exact commands. It must accept control profiles plus target-gene metadata, preserve gene order/context identifiers, and emit the supported raw-count prediction representation. A trained checkpoint may be claimed only if training actually ran on identified, rights-cleared data; otherwise identify the artifact as an untrained method/adapter.

Required verification includes:

- Local input/output tests for missing/extra targets, gene-order drift, non-finite/negative/fractional counts, non-targeting output rows, count limits and sparse stored-entry accounting.
- A CPU scorer smoke test using the pinned upstream fixture and `vcc2026` **preset**, with the DE backend explicit. Inspect the pinned CLI/API before fixing its command syntax; the documented entry point is `cell-eval2 run -ap ... -ar ... --preset vcc2026 --pert-col ...`.
- Preserve raw metric outputs, diagnostics, eligible/omitted perturbations, source/config/fixture hashes and runtime. Missing or non-finite scores are not coerced into success. Distinguish raw metric values from reference-scaled scores and any aggregate actually emitted by the pinned implementation.
- Test scorer/adapter behavior against a declared simple prediction/control-based baseline and upstream invariants. This demonstrates executable integration only; synthetic fixture differences are not a VCC model-performance result.
- Run the project's tests and retain their stdout/stderr, exit codes, commands and generated artifacts. A plan, prose assertion or exit zero without the required artifacts is not completion.

### C. Real-data predictive performance — conditional and currently blocked

This gate requires a verified small public real-count fixture or separately authorized user-provided Challenge-compatible data. Freeze source/license/byte hashes, deterministic selection, donor/train/dev/held-out divisions and metric configuration **before** worker access. Keep held-out perturbation outcomes controller-only; group splits by context and perturbation, not random cells that leak the same response into training and test.

On the same frozen holdout, execute the selected model and declared no-change/control-mean plus simple transfer baselines. Report the complete applicable metric vector, uncertainty/sample size and failures. Claim improvement only where measured. If the proposed method is worse, report that result and do not switch tasks, metrics or baselines after seeing it.

Without suitable real data, report **“software/official-metric integration qualified; biological predictive performance unmeasured.”** Do not claim that the original first-place aspiration is fulfilled. A local proxy cannot establish an official leaderboard rank; no submission is authorized.

## Freeze and receipts required before dispatch

The controller must separately record:

- Exact original seed and any prospectively approved computational-scope wrapper; baseline identity/hash; whether the acceptance attempt is fresh or a native permitted recovery.
- Production commit plus dirty/source hashes, executed driver/helper hashes, model/provider/effort references, CodeMode runtime version and capability preflight, frozen native route/profile, and explicit optional-refusal policy.
- New-pass $25 exposure ceiling, cumulative request/wall limits, exact-wire reservations, queued/dispatched/settled counts, retained unknown charges, and all controller receipts. No spent or uncertain amount is released merely to fit another call.
- Native chosen idea, canonical render/evidence hashes, comparison coverage, probe statuses, source URLs and retrieval failures; no evaluator data or private receipts passed into worker context.
- Dataset and scorer version/license/hash pins; real versus synthetic labels; split manifest; CPU/memory/time limits; exact commands and acceptance predicates.
- Before/after immutable artifacts and journal-prefix checks. Report source changes, failed/cancelled calls, incomplete scoring and data-access blockers independently of the operating-system process exit code.

Baseline comparison reports total calls, input/output/cache token counters, estimated recorded cost, conservative exposure, active wall time, retrieval failures and successfully validated artifacts. A lower token count is not a quality improvement if achieved by skipping research, evidence checks or implementation. No benchmark-module changes or broader benchmark spending are part of this acceptance pass.
