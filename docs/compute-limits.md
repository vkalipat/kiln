# Compute limits and monitoring

Native operator sessions can run without an aggregate dollar or active-time allocation while retaining usage accounting and local loop detection. Uncapped does not prove task completion or bypass provider and tool limits.

## Choose a policy

```sh
# Persist the policy for new native operator sessions, including the TUI.
kiln task limits --uncapped

# Inspect that policy.
kiln task limits

# Override the policy for one new task only.
kiln task "Finish the importer and verify its acceptance conditions" --uncapped

# Set finite allocations for future native sessions.
kiln task limits --budget 100 --wall-seconds 28800

# Inspect a run's last persisted monitor snapshot without invoking a model.
kiln task monitor RUN_ID --json
```

`--uncapped` sets both native allocations to JSON `null`: no aggregate dollar limit and no aggregate active-elapsed-time limit. Numeric values must be positive; either individual flag also accepts `unlimited`. Do not combine `--uncapped` with the individual flags. Changing only one policy field preserves the other. The one-task override does not rewrite the persistent policy.

Existing runs keep their saved allocations, spending and enabled integration policy. Changing defaults does not change a resumed run; conflicting explicit resume allocations are rejected. Start a new task to use a different allocation. Finite allocations are admission controls, not absolute invoice caps: admitted work can finish after a target is crossed.

The operator is instructed to work until the requested deliverable and checks are complete or a concrete dependency blocks progress. User cancellation, provider failures and a local loop pause can still stop a turn. A `completed` turn and its final message are not independent quality certification; the result retains `taskQualityValidated: false`.

## Bounds that remain

Accounting still records known cost, outstanding reservations, unknown exposure and available provider usage. Uncapped does not mean free use or unlimited provider quota. Context windows, output limits, authentication, per-request deadlines, tool bounds, cancellation and concurrency rules remain enforced. Native automatic compaction remains enabled; reasoning effort is not lowered by this feature.

On new sessions with **both** aggregate allocations uncapped, default aggregate Jev request/token allowances are also uncapped. Explicit Jev limits and saved run policies remain authoritative. Per-call limits and the shared maximum of four active workflows remain. Browser workflows still have their decision/deadline bounds; research still has source/concurrency/deadline bounds.

Legacy phase runs and each invoked ideation batch retain finite planning targets. An uncapped native parent does not turn those bounded batches into infinite loops or remove their research/probe controls.

## Read the monitor

The monitor runs deterministic local code and makes **zero model calls**. `compute-monitor.json` in the run directory stores hashed identities/fingerprints, counters and usage summaries rather than raw prompt or tool bodies. The command returns the latest persisted JSON snapshot, not a continuously refreshing stream; older runs may have no receipt yet.

| Signal | Behavior |
| --- | --- |
| Same tool name, arguments and result fail consecutively within one session/turn | Warning at 3; pause at 6 |
| Same successful tool call and result repeat consecutively | Warning at 4; pause at 8 |
| Recognized wait/poll/watch/status operations | Warnings at those thresholds, without an automatic repetition pause |
| Serialized request size grows at least 50% over three consecutive comparisons | Context-growth warning; bytes are not tokenizer counts |
| Observation cannot be fingerprinted within safe bounds | Coverage warning and repetition streak reset |

A pause stops the active turn so its cause can be inspected. Resume with a concrete change of approach or clarified dependency; a new turn resets repetition streaks while accumulated accounting remains.

`totals` reports observed tool calls, failures, exact repeats and evicted session records. `usage` separates input/output/cache-read/cache-write counters, provider-reported totals, known cost, reserved dollars, unknown exposure and rows lacking usage. Provider-reported categories need not be interchangeable; unknown or absent usage is not zero consumption. `sessions` contains bounded per-session observations and `notices` retains the latest 64 notices. At most 256 sessions are retained; eviction counts expose that coverage loss.

This is a diagnostic, not a semantic progress or quality judge. It cannot prove that a repeated successful call was unnecessary, detect every changing-output loop, reconstruct missing provider usage or infer scientific validity. Polling and unsupported fingerprints have weaker repetition coverage. Inspect the underlying checks and artifacts.

## Token optimization without reducing effort

Team mutations return compact receipts for changed features, including revision, scopes, ownership, criterion IDs, current handoff/review evidence and the committed ledger hash. Reuse the returned revision for the next mutation; query when other feature/history information is needed or a revision conflict occurs. Full `team query` and fresh `review_packet` access remain available, and the authoritative ledger is retained.

In a synthetic 32-feature claim fixture, the response shrank from **17,270 to 997 UTF-8 bytes**. This is measured response size, not measured model tokens, billed savings or an end-to-end performance result. Existing provider prompt caching, scoped context views, Jev batching and exact-state request/result reuse address other repeated input. Cache support and hits depend on provider/state; no general savings rate is claimed. These changes do not lower the user's selected `xhigh` effort or select weaker models.
