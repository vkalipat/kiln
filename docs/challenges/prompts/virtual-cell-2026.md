# Virtual Cell Challenge 2026

Build and evaluate a competitive, reproducible workflow for the 2026 Virtual Cell Challenge. Take the work from research and ideation through a working prediction pipeline, controlled improvements and a locally validated submission package. Work in this project's existing directory, reuse relevant artifacts and continue until the deliverables and meaningful checks are complete. A research report alone is not the requested result.

## Objective and inputs

Verify the current [Arc announcement](https://arcinstitute.org/news/virtual-cell-challenge-2026), [challenge rules](https://virtualcellchallenge.org/rules), [evaluation specification](https://virtualcellchallenge.org/evaluation) and [official CLI guide](https://vcc-cli-wiki.virtualcellchallenge.org/). Record source URLs, versions and retrieval dates. Use 2026 requirements, not the older 2025 task.

The September 30 starting point is zero-shot prediction of CRISPRi responses in unseen cellular contexts, using their unperturbed controls and the supplied target-gene list. There is no challenge-specific training set. Validation uses contexts A/B/C; final contexts D/E/F are scheduled for October 22, with the deadline November 5, 2026 at 23:59 UTC. Verify those details when the run starts. Finish the available validation-stage package without waiting for future data, and make final-context inference reproducible when it becomes available.

Discover existing account access and datasets without exposing credentials. Use the organizer's current control, gene and perturbation files as authoritative inputs. Preserve file hashes, gene order, context labels, units and transformation history. Keep label identity attached to every cell throughout preprocessing and concatenation. Freeze the current submission schema in executable checks rather than relying on a prose description of dimensions or counts.

## How to work

Compose task-specific responsibilities from the dependencies, with clear artifact ownership and acceptance criteria. Propose viable role alternatives and let Jev choose compatible models and supported effort levels using the task, reviewed benchmark evidence, cost and quality requirements. Include smaller models and lower effort where appropriate; reserve expensive reasoning for work that needs it. Do not impose a fixed model pair, maximum effort or preset team. Use independent review for consequential decisions. Specialist scientific models remain separate tools. Confirm that every selected model and tool complies with the competition's current track rules before generating competition artifacts.

Use Jev for supported bounded decisions, source handling and ambiguous handoffs where it reduces work. Keep scientific judgments with qualified reasoning models and data validation with deterministic code. Check actual environment, storage, GPU access, dependency compatibility and quotas before planning a large run. Use existing authorized resources; retain external usage receipts and report unavailable access precisely.

Establish a reproducible baseline that can traverse the complete data-to-package path. Compare plausible current methods against it under a common evaluation protocol. Consider a simpler or unconventional approach when it targets a clear failure mechanism and can be tested. Choose the research portfolio from observed weaknesses rather than committing in advance to a large foundation model or a fixed agent roster.

Use permitted external data with explicit provenance. Construct local evaluation that tests transfer into held-out cellular contexts. Declare training, tuning and evaluation partitions, contamination checks and any use of public validation feedback. Never fit or tune against unavailable challenge ground truth, imply access to it, or report synthetic fixture performance as competition performance.

Report the relevant component metrics alongside the aggregate, baseline, uncertainty and exact evaluation version. Separate a local proxy score from an official score. Test improvements with ablations that answer specific questions; retain simpler methods when gains do not survive checks. Diagnose data alignment, count distributions, context transfer and prediction variability before interpreting a weak score as a biological failure.

Continue autonomously through implementation, evaluation and correction. Keep the compute monitor active; cache reusable preprocessing, avoid redundant downloads and escalate compute after informative pilot runs. Stop repetitive failures and branches with no useful remaining test. Do not introduce a new arbitrary spending ceiling; existing resource authority and provider limits still apply. Ask only for consequential missing information while continuing unblocked work.

## Completion

Deliver:

- A sourced task contract and data manifest, including access status, dataset hashes, split definitions and the pinned evaluation/submission interfaces.
- A runnable baseline and selected improved pipeline with reproducible commands, configuration, dependencies, seeds and checkpoint provenance.
- An evaluation report comparing methods fairly, including failures, ablations, uncertainty and what is still unmeasured.
- A prediction package for every currently required context, with correct identities and numerical constraints. Validate through the installed official CLI, including `vcc prep --dry-run`; retain the actual command, version and output. A successful packaging check does not establish predictive quality.
- A short guide for reproducing validation predictions and later running the same audited pipeline on final contexts.
- A Kiln run summary with time to the first valid baseline, elapsed time, model/Jev usage, external compute, retries and human interventions. Claim throughput gains only against a comparable measured baseline.

Finish with checked artifact paths and clear remaining limitations. If account access, data or compute block real predictions, finish the independently runnable code and report the exact dependency; do not call fixtures a completed challenge entry. Prepare the submission package for my review. Do not upload predictions, publish artifacts or submit an entry.
