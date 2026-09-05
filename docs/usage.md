# Using Kiln

## Install and start

Kiln requires Bun 1.3.14 or newer and Git.

```sh
git clone https://github.com/vkalipat/kiln.git
cd kiln
bun install
bun link
kiln
```

Without a global link, run `bun run kiln` in the repository.

Bare `kiln` opens the terminal interface. The first unauthenticated launch opens the provider chooser. No model request is made until a seed is submitted.

## Provider access

Connect a subscription with OAuth:

```sh
kiln auth login
kiln auth login anthropic
kiln auth login openai
```

The login callback normally completes in the browser. Kiln also accepts the pasted redirect or code when a callback is unavailable.

Enter an API key through the masked prompt:

```sh
kiln auth key anthropic
kiln auth key openai
```

For automation, pipe the key through standard input and pass `--api-key-stdin`. Existing `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and SDK-recognized provider variables are used in place and never copied into Kiln's credential store.

```sh
kiln auth status
kiln auth status --json
kiln auth logout anthropic
kiln auth logout all
```

Inside the TUI, `/login` opens the provider chooser. `/login anthropic` and `/login openai` start the corresponding OAuth flow; append `key` to enter an API key or `device` after `openai` for device authorization. `/auth` shows the configured sources, and `/logout anthropic|openai|all` removes stored credentials.

## Run lifecycle

```sh
kiln run new "A local tool to compare household energy use" --through checkpoint
kiln ideas pick RUN_ID IDEA_ID
kiln project form RUN_ID
kiln project build RUN_ID --yes
kiln run resume RUN_ID --through reflect
```

The phases are `frame`, `discover`, `ideate`, `checkpoint`, `form`, `build`, and `reflect`. New runs stop at the checkpoint unless another phase is supplied with `--through`.

Useful inspection and control commands:

```sh
kiln run list
kiln run show RUN_ID
kiln run record RUN_ID
kiln project status RUN_ID --json
kiln project audit RUN_ID --json
kiln build pause RUN_ID
kiln model roles
kiln mode show
kiln mode set high
```

Use `--home DIR` to select a separate Kiln home. Otherwise Kiln uses `KILN_HOME` or its default local home. `--out DIR` places the formed project outside that home. `--single-session` selects the experimental persistent-builder arm, and `--reinit` reruns project initialization.

## Terminal controls

The prompt border shows cost, phase, current activity, and directory.

| Key | Action |
| --- | --- |
| `Ctrl+O` | Open the command palette |
| `Ctrl+S` | Change model effort |
| `Alt+T` | Expand or collapse tool details |
| `Esc` | Pause the active step |
| `Ctrl+C` | Exit |

Set `NO_ANIMATION=1` to disable animation. The display label `ultra` maps to the stored effort level `xhigh`.

## Durability and recovery

Build checks run in Kiln, followed by an independent auditor over a detached copy of the exact repository bytes. State, check output, audits, and Git commit evidence support restart after interruption.

A usage pause resumes after its recorded wake time. An operator pause resumes on request. Budget and deadline stops require the corresponding configured target to increase. An integrity failure requires inspection and an explicit relock:

```sh
kiln project relock RUN_ID --confirm
```

The authoritative feature plan, acceptance lock, and state journal live under the run directory. Project-side plan and lock files are inspection mirrors. Reflection records a candidate; it does not directly edit the live playbook.

Provider calls use configured role seating and effort. A run's dollar target is a planning allocation. A provider turn admitted before the limit can complete after crossing it, so final cost can exceed the target.

## Evaluation and evolution

The following checks are read-only and do not call a provider:

```sh
kiln evals verify --home /path/to/kiln-home --json
kiln evals leakcheck --home /path/to/kiln-home --json
kiln evals metrics --home /path/to/kiln-home --evals --json
```

`run new --seed-id dev-product-01` selects a bundled development seed. `--seed-file PATH` reads exact file bytes. Kiln also recognizes seed identity in pasted text. A held-out seed requires an in-progress evaluation ID. Evaluator file changes fail integrity checks for evaluations; ordinary runs record the drift and continue.

An explicit operator correction uses the same structural validation and a model-backed conflict check before commit:

```sh
kiln evolve apply --op edit --id B1 \
  --text "Keep one feature in each fresh builder session." \
  --why "Isolated context makes failed attempts easier to replace." \
  --reason "Correct the build procedure after observed retries." --yes
```

Operator corrections reset the target counters. They are separate from evaluator-gated promotion. The conflict check consumes provider usage, and a missing or refused decision cannot approve a change.

Paid evaluations always require an explicit `--budget`. Kiln prints a projection before confirmation; `--yes` and `--json` skip the interactive question.

- `evals calibrate --labels human|agent` replays judge decisions against best and worst labels. Agent labels cannot authorize judge-based promotion.
- `evals effort ROLE` measures supported effort levels for an exact role, model, and seating profile.
- `evals m1` compares the full loop, a bare baseline, a low-effort arm, and frontier model seating.
- `evals m2 --projects N` compares fresh builder sessions with a persistent session on cloned projects.
- `evolve eval CANDIDATE_ID` compares a candidate with the champion on development and held-out seeds in isolated homes.

Evaluation work and reports survive interruption. Budget checks admit complete units, so an in-flight provider turn is not truncated. Reports expose quality, cost, censoring, calibration provenance, and effective effort.

```sh
kiln evolve list --json
kiln evolve propose
kiln evolve promote CANDIDATE_ID
kiln evolve archive CANDIDATE_ID --reason operator --detail "Reason"
kiln evolve rollback --confirm
```

Confirmation cannot override a loss, censorship, missing human judge calibration, or an unpaired formation comparison. Rollback applies only to an eligible evolution commit at `HEAD` and preserves the journal.

After an interrupted evolution mutation, repeat the same command. Durable intent lets Kiln finish its exact owned changes. Unexpected edits stop recovery for inspection, and evolution commits do not absorb unrelated staged work.

## Operational limits

Kiln's shell and file tools run locally without a host sandbox. Use a disposable checkout or container for untrusted work, and inspect generated checks before a real run.

Repository tests use mock providers and temporary homes. Authenticated runs and model-backed conflict checks consume subscription allowance or API budget. The evaluation machinery is implemented, but until the experiments are run it is not evidence that Kiln outperforms its baselines.

Run the two provider-free autonomy demonstrations with `bun run scripts/usecases/autonomous-tooling.ts all`. Their exact real and mocked boundaries are documented in [testing/usecases.md](testing/usecases.md).
