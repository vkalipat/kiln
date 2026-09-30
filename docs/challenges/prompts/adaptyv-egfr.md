# Anthropic × Adaptyv 2026: conditional EGFR binder

Develop a competitive, reproducible conditional EGFR protein binder submission package for Challenge 1 of the Anthropic × Adaptyv 2026 competition. Take the work from research and ideation through computational design, evaluation, independent review and a locally validated package. Work in this project's existing directory and inspect relevant existing artifacts before creating replacements. Do not stop at a plan or literature summary.

## Objective and inputs

Verify the current [challenge page and FAQ](https://proteinbase.com/competitions/anthropic-adaptyv-2026/challenges/egfr) and [competition terms](https://proteinbase.com/competitions/anthropic-adaptyv-2026/terms) before freezing the target contract. Record source URLs and retrieval dates. Treat the following as a September 30 starting point, with current organizer requirements taking precedence:

- Human EGFR, UniProt P00533-1 extracellular residues 25–645; domain III is recommended, with PDB 6ARU chain A as a reference.
- Prioritize binding at pH 6.5 with no detectable binding at pH 7.4, then mouse cross-reactivity, then human affinity. Preserve tradeoffs instead of reducing everything to a folding score.
- Challenge 1 closes October 4, 2026 at 23:59 AoE. Confirm the applicable track and its submission count.
- Designs must be de novo under the FAQ's definition. Known binders can inform calibration; they cannot be the parent sequence being modified into an entry.
- Ranked CSV fields are `name`, `sequence`, `molecule_class`. Validate lengths and formats for the actual molecular class; do not apply protein-only limits to all antibody formats.

Retrieve the official target sequences and establish explicit human/mouse/structure residue mappings. Account for construct boundaries, missing residues, glycans and accessibility when interpreting a proposed interface. Choose a molecular class based on feasibility and the available tools; document the choice rather than inheriting a scaffold or target from an unrelated campaign.

## How to work

Compose task-specific responsibilities from the dependencies, with clear artifact ownership and acceptance criteria. Propose viable role alternatives and let Jev choose compatible models and supported effort levels using the task, reviewed benchmark evidence, cost and quality requirements. Include smaller models and lower effort where appropriate; reserve expensive reasoning for work that needs it. Do not impose a fixed model pair, maximum effort or preset team. Use independent review for consequential decisions. Specialist scientific models remain separate tools. Confirm that every selected model and tool complies with the competition's current track rules before generating competition artifacts.

Let Jev handle supported bounded decisions and handoffs when it saves work. Selected reasoning models own scientific synthesis and experiment design; deterministic code validates sequences, identities and files. Check actual tool access, licenses, account readiness and available compute. Use existing authorized resources and retain usage receipts. Missing access is a dependency to resolve, not evidence that a computation ran.

Develop a practical design portfolio with a defensible baseline and a contrarian hypothesis whose benefit could be falsified. Investigate current primary literature and implementations only where they affect a decision. Prefer the smallest informative computational comparison before scaling. Preserve diversity that addresses distinct uncertainties; avoid generating many near-duplicates or optimizing a convenient proxy without checking its relevance.

Distinguish model confidence, predicted interface quality, proposed pH mechanisms and experimentally measured binding. Never label pH selectivity, expression or affinity as demonstrated without the relevant measurements. If earlier assay data are reused, keep non-reads, censoring and failed loading separate from binding negatives. Maintain provenance from each generated candidate through every sequence revision and evaluation.

Continue autonomously through implementation and checks. Keep the compute monitor active and reuse cached inputs/results when their provenance matches. Stop repetitive failed calls and branches that no longer answer a useful question. Do not impose a new arbitrary spending ceiling; existing resource authority and provider limits still apply. Ask only for missing information that blocks a consequential decision, while continuing independent work.

## Completion

Deliver an organized package containing:

- A sourced target/rules contract, track-specific submission requirements and unresolved access or rule questions.
- A ranked candidate CSV and FASTA, linked structures and evaluation records, exact sequence hashes, model/tool versions, seeds where applicable and full design lineage.
- A concise methods report explaining the selected strategy, rejected alternatives, novelty evidence, ranking rationale and limitations of each proxy.
- A validation report covering schema, class-specific constraints, duplicates, sequence/structure identity and reproducibility. Preserve failed checks and excluded candidates.
- A Kiln run summary with elapsed time, model/Jev usage, external compute, retries, human interventions and remaining scientific uncertainty. Claim a throughput improvement only with a comparable measured baseline.

Finish with the checked artifact paths and a short account of what is complete and what still needs experimental evidence. If essential compute or data remain unavailable, deliver the runnable work and precise blocker without calling the design package complete. Prepare the package for my review; do not submit it, publish it or place laboratory orders.
