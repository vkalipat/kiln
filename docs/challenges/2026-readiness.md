# 2026 challenge software readiness

Public requirements checked **2026-09-30**. **Neither challenge has been started.** The user will supply their own task prompt and target/data choices later. This document is a software-readiness assessment, not a campaign plan, generated task prompt, submission package or scientific result. No challenge data were downloaded, accounts registered, designs generated, GPU resources rented or submissions made in this assessment.

## Verified public interfaces

**Virtual Cell Challenge 2026.** Arc describes zero-shot perturbation prediction across six unseen cell lines, with no challenge-specific training set. Validation opened August 20; final data are scheduled for October 22 and submissions close November 5, 2026 at 23:59 UTC. These are dated public statements, not account-access verification. [Arc announcement](https://arcinstitute.org/news/virtual-cell-challenge-2026)

The official CLI guide specifies one `.vcc` file covering three contexts: A/B/C for validation, D/E/F for final. It requires the official gene/perturbation lists, 400 cells per target/context, 18,533 genes, finite nonnegative whole raw counts, no control predictions, at most 400,000 cells, at most 4,750,000,000 stored matrix entries and at most 1,000,000 counts per cell. The stated panel has 300 perturbations and 360,000 prediction cells. `vcc prep --dry-run` supports local format checking; `--perts` supplies the perturbation list, whereas `-p` names the perturbation column. Packaging success does not validate biology or catch swapped context identities. Registration and an API key are needed for authenticated operations. The six-component overall uses reference scaling, not percentage accuracy; partition, panel and anchor identity must accompany scores. [Official CLI guide](https://vcc-cli-wiki.virtualcellchallenge.org/)

The [evaluation](https://virtualcellchallenge.org/evaluation) and [rules](https://virtualcellchallenge.org/rules) pages returned only a loading shell to this inspection. Their complete current contents, authenticated account readiness and current leaderboard were **not verified**. Do not substitute the older 2025 rules.

**Anthropic × Adaptyv 2026.** Challenge 1 is currently a conditional EGFR binder task: human UniProt P00533-1 extracellular residues 25–645 (621 amino acids), with domain III recommended and PDB 6ARU chain A referenced. The page requests acidic-pH selectivity (6.5 versus 7.4), mouse cross-reactivity and human affinity. Its deadline is October 4, 2026 at 23:59 AoE—October 5 at 11:59 UTC. Ranked CSV requires unique `name`, `sequence` and `molecule_class`; supported classes include protein, nanobody, scfv, fab_kappa and fab_lambda. Fab variable chains use `VH:VL`. The 10–250-residue restriction applies to single-chain proteins; antibody classification has separate requirements. De novo/zero-shot provenance and researcher review matter; a known binder modified into a candidate does not meet that definition. These facts identify current software requirements only; **no target profile or designs have been prepared**. [Official Challenge 1 page and FAQ](https://proteinbase.com/competitions/anthropic-adaptyv-2026/challenges/egfr)

The detailed FAQ describes Track 1 screening of its top 20 passing designs, while the overview and terms describe approximately 15. Treat the testing allocation as unresolved rather than guaranteeing either. Publication/rights, eligibility, account and track requirements need participant review before any later submission; the public page is not evidence that this user is registered or eligible. [Competition overview](https://proteinbase.com/competitions/anthropic-adaptyv-2026), [official terms](https://proteinbase.com/competitions/anthropic-adaptyv-2026/terms)

## What the existing evidence establishes

The [September 14 readiness record](../testing/2026-09-14-vcc-readiness.md) records provider-free orchestration checks and a pinned `cell-eval2` 0.16.0 CPU/Scanpy integration using synthetic fixtures. It does not establish a trained model, a current valid challenge package, real-data generalization or an official score. Its separate live JSON-utility trial is software evidence, not a perturbation-prediction result.

The older [acceptance protocol](../testing/vcc-acceptance.md) remains historical: its controller-chosen $25 ceiling, approval sequence, old data search and dated leaderboard observation are not current user instructions or fresh access checks. The user's current authorization and saved runtime policy govern future work. This document introduces no new spending ceiling or extra approval process.

## Current offline readiness tools

The current native dependency pin is **18.4.4**; historical 18.4.2 fixture results remain dated evidence. Run `kiln doctor --json` for local core checks, or `kiln doctor --require jev,hindsight --json` to require optional integrations. No provider, DNS, model or service call occurs. Credential presence and compatible model metadata do not establish live authentication, entitlement or quota.

`kiln auth key jev` and `kiln auth key hindsight` provide masked credential entry; nonempty environment keys override stored values. `kiln integrations jev enable` saves workflow policy for new sessions without starting a task; resume retains saved policy, with environment disabling overrides still available. Hindsight requires explicit endpoint and bank configuration and is never automatically provisioned or injected into context.

After local setup, `doctor --require jev` confirms native credentials, a stored Jev credential and enabled Jev workflows. Hindsight has no configured endpoint/bank. This is a dated offline configuration observation, not live service testing or a portable installation default. Neither challenge has started.

## Software checks before a later user-directed run

| Capability to check | Evidence needed | What it does not establish |
| --- | --- | --- |
| Provider and model readiness | Locally discovered access, compatible pinned model/effort and clearly separated live preflight status | Quota or successful execution from a stored credential alone |
| Run controls | Current allocation, cancellation, resume preservation, usage/unknown-exposure accounting and monitor receipts | Completion or scientific quality from an uncapped allocation |
| Optional integrations | Enabled/configured status separate from live connectivity; missing access reported explicitly | Successful Jev/Hindsight operation without a service response |
| Tool execution | Available CPU/runtime dependencies, deterministic subprocess results, failure propagation and scoped worker handoffs | Biological correctness from exit zero or a classifier label |
| Data and construct identity | Later supplied files, source/version/hash, context/gene order or exact molecular class/construct provenance | Target identity inferred from an old competition or unrelated local artifact |
| Format validation | Positive and negative fixtures for the selected current official schema; retained commands, versions and outputs | Official acceptance without the organizer's own validation |
| Scientific evaluation | Distinct synthetic/real labels, declared baseline, complete metric outputs and held-out evaluation where appropriate | Affinity, pH selectivity, generalization or leaderboard performance from software checks |

Challenge-specific data, registration status, service quota, compute requirements and suitable evaluation data remain **unassessed for a new run**. Once the user supplies the task, report those dependencies independently from software readiness. Preserve raw/normalized score distinctions, unknown evidence and failed attempts. Do not call any challenge complete from this document or the historical smoke tests.
