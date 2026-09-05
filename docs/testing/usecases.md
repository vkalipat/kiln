# Autonomous tooling demonstrations

Run both provider-free demonstrations from the repository root:

```sh
bun run scripts/usecases/autonomous-tooling.ts all
```

Run their assertions with:

```sh
bun test test/usecases/autonomous-tooling.test.ts
```

The command prints JSON with the temporary workspace, final status, artifact output, acceptance results, attempt dispositions, commit SHAs, and a compact event trace.

## Scenarios

### `utility-crash-recovery`

Kiln builds a dependency-free Unicode-aware slug CLI. A fault is injected after the successful acceptance check, detached audit, and feature commit but before the final state transition. A new CLI invocation resumes the run, authenticates the real Git trailer, and finishes without another builder model call or duplicate commit.

Observed invariants:

- first CLI invocation exits `1`; the resumed invocation exits `0`;
- `Crème brûlée for Kiln!` produces `creme-brulee-for-kiln`;
- one builder session and one feature commit survive the interruption;
- the resume performs zero additional builder model calls;
- final status is `reflect/done/success`.

### `check-failure-repair`

Kiln builds a JSONL summarizer. The first attempt deliberately uses integer parsing and fails the real decimal-total shell check. The harness records the failed check and audit, restores the real repository to its pre-attempt HEAD, supplies that evidence to a fresh builder session, and accepts the corrected second attempt.

Observed invariants:

- acceptance results are exactly `fail, pass`;
- dispositions are exactly `verify_failed, passed`;
- the final program emits `{"count":2,"total":7.5}`;
- two builder sessions converge on one feature commit;
- the final producer working tree is clean;
- final status is `reflect/done/success`.

## Evidence boundary

These are orchestration demonstrations, not live-provider quality benchmarks.

Real in both scenarios:

- production CLI routing and build/reflect phase control;
- model-directed filesystem tool execution;
- child-process initialization and shell acceptance checks;
- failure restore and durable journal/state recovery;
- local Git repositories, commits, trailers, diffs, and detached auditor snapshots;
- audits, progress, metrics, and terminal status persistence.

Mocked in both scenarios:

- builder, auditor, and reflector model responses and streaming;
- the inert credential resolver passed to the mock stream;
- provider usage lookup.

No network request, real credential, or paid provider call is made. Because the model outputs are scripted, these cases establish that Kiln can execute, verify, reject, recover, and resume autonomous work correctly. They do not establish coding quality or generalization for any live model. A live-provider trial across non-fixture projects remains necessary before making that claim.
