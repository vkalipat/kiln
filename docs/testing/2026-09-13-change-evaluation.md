# Change evaluation: efficiency, recovery and quality

## Conclusion

The changes demonstrably remove unnecessary orchestration work and preserve completed research across interruptions. They do **not yet demonstrate better final ideas**. All new comparisons below use mocked providers; no additional paid model requests were made for this evaluation.

The tested implementation is `5a62d89032fbc233dd362f0723f0126120dee915`, production-source SHA-256 `63d86991e7d969eb6de8220e0316accdff0ec62d7b8895869982f4ee2d6b5928`. It was pushed to `main` after the user authorized changing the repository to private. [GitHub CI passed](https://github.com/vkalipat/kiln/actions/runs/34796514867), including typecheck, the test suite, evaluator-manifest verification and leak checks. This evaluation adds test/report files, not production changes.

## Measured research-recovery changes

Twelve deterministic variants per scenario, both before and after: 72 instrumented traces. Values below are calls **per resumed work unit**, not whole-run averages.

| Scenario | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Completed research waiting for handoff: scout model calls | 2 | 0 | No repeated research |
| Reviewer unavailable, then recovered: total model calls | 3 | 1 | 67% fewer calls; independent review remains |
| Same reviewer-recovery case: retrieval calls | 1 | 0 | No repeated fetch |
| A reviewer genuinely rejected coverage: total model calls | 3 | 3 | Poor research is correctly replaced |
| Same inadequate-coverage case: retrieval calls | 1 | 1 | Caching does not freeze inadequate evidence |

Exact returned findings and scout-owned URLs were preserved in all 72 traces. The comparison executes the actual `e37399d` prior-art module, with import paths relocated, against the current module. Both use current shared dependencies. This isolates the persistence policy; it is **not a full historical-harness comparison**. The historical body is verified against its original SHA-256 after import relocation and trailing-newline normalization.

The variants change report content, length and small scheduling delays. They are controlled fixtures, not independent samples of production traffic. [Raw results](../../test/ideation/recovery-change-evaluation.results.json) retain every row and repeated-test output; [the evaluator](../../test/ideation/recovery-change-evaluation.ts) records source and evaluator hashes.

## Direct-task checks

Seven named behavior cases passed:

| Behavior | Compatibility path | Optimized direct path |
| --- | ---: | ---: |
| Model-driven framing phase invocations | 1 | 0 |
| Independent critique sessions after a clean approval | 2 | 1 |
| Redundant revision after a clean approval | 1 | 0 |
| Critiques when a real correction is required | 2 | 2 |
| Revisions when a real correction is required | 1 | 1 |
| Exact original-request blocks in stable builder context | 0 | 1 |

Resume did not repeat an already accepted critique. Changed bytes did not inherit approval. An interrupted revision did not borrow an earlier approval. Seed drift dispatched no builder work.

These numbers are **assertion-backed current/compatibility checks**, not instrumented execution of a historical binary. The current compatibility path preserves unmarked workflow behavior. Separately, exact pre-consolidation Git source (`2e9ffa7`) verifies the older ordering. Assertion files, case names and archived source excerpts are hash-bound so changes require deliberate reevaluation. Framing invocations and review sessions are not necessarily single provider turns. [Direct results](../../test/benchmarks/direct-change-evaluation.results.json) contain the attribution and limits.

## Repeated stress checks

Ten executions of the same 50 prior-art/enrichment tests produced **500 passes, zero failures, 1,720 assertions**. Coverage includes sibling cancellation, review interruption, explicit inadequate coverage, changed context, packet corruption, scout-owned citations, and complete/overflow probe handoffs. This is ten repetitions of a deterministic suite—not 500 independent end-to-end tasks or a production reliability estimate.

In the current probe-handoff fixtures, a normal complete packet needs one selector call and no acquisition read. Explicit overflow needs two calls and one read. Those observations do not establish real provider latency, token usage or dollar savings.

## What the real output says about quality

An independent, unblinded, post-hoc audit inspected the retained prior live landscape and eight draft dossiers against three declared criteria: distinct/testable mechanisms, brief compliance, and recorded-source grounding. The archive hash matches the [consolidation record](2026-09-13-consolidation.md).

- **Useful hypothesis generation:** concrete intake, triage and pricing-history mechanisms; a candid landscape that corrects a product misclassification and labels evidence gaps, source snippets, marketing and inference.
- **Not eight proven distinct mechanisms:** two drafts substantially overlap in deriving pricing memory from sent quotations. Some differentiation assertions go beyond what the inspected homepages establish.
- **Constraints need screening:** a draft conditions its validity on broadening the human-approval rule, and another's mechanism classification is questionable.
- **Proxies are not outcomes:** a nearest-history retrieval hit does not establish accurate current pricing; interval coverage can be made easy by making the interval too wide; synthetic missing-field examples do not establish real customer prevalence or time savings.

These were unranked candidates. The run never completed its evidence, probe or tournament stages, so the audit neither endorses a final shortlist nor proves that a completed pipeline would accept these weaknesses. That live run also preceded the final persistence fix and used an exploratory route, so it cannot demonstrate live benefits from the later cache fix or the direct-task shortcuts. No numerical idea-quality score or AGI/biological-discovery claim is warranted.

## Reproduction and remaining evidence

```sh
bun scripts/benchmarks/direct-change-evaluation.ts
# Optional, when the local repository contains the baseline Git history:
bun scripts/benchmarks/direct-change-evaluation.ts --verify-history
bun test/ideation/recovery-change-evaluation.ts
bun test test/ideation/priorart.test.ts test/ideation/enrich.test.ts
bun run typecheck
```

The previous paid campaign retains $98.1782305 conservative exposure against its $100 limit. A fresh live ideation test, capped at an additional $25, was requested separately and has not been started without approval. A completed live artifact followed by source, constraint, distinctness and task-success assessment is the next necessary evidence—not more repetitions of these mocks.
