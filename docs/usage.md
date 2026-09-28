# Using Kiln

## Coding-assistant plugin and recovery

If every discovery scout fails with a transient provider/network error (such as DNS `ENOTFOUND`), Kiln stops discovery resumably and preserves the diagnostic. Once connectivity returns, explicitly run `kiln run resume ID` to retry that same phase. It does not automatically retry, switch models, or classify missing research as valid findings. Refusals, mixed failure batches, integrity failures, and invalid output are not cleared by this path.

The [local Codex/Claude Code plugin](../plugins/kiln/README.md) can launch, watch, pause, and resume durable jobs. Its stable request IDs map to explicit `kiln run new --id ID` run IDs; an existing directory is never overwritten by the CLI.

For older runs marked failed by a frame turn cap even though `brief.md` was complete, `kiln run recover-frame ID` validates the existing brief and restores the discovery cursor without provider calls. It refuses other failures, invalid briefs, and active locks. Recovery does not execute discovery; use `kiln run resume ID` only when ready to authorize more provider work. New runs accept a contract-valid brief on the final allowed frame turn without requiring an extra model call.

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

Bare `kiln` opens an editable prompt. Type a task and press Enter; if unauthenticated, the provider chooser opens then and retains the task for submission after connection. No model request is made before submission. Fresh homes enable adaptive routing and autonomous selection; existing configuration choices are preserved.

### Persistent operator conversations

Bare `kiln` and `kiln task` use the native OMP operator. The operator keeps one session across follow-ups, delegates bounded work to native task workers, and invokes the research/ideation module when useful. Messages during a running turn steer that turn; messages after it finishes start a follow-up in the same session.

```sh
kiln task "Implement the requested feature and check it" --cwd . --budget 10
kiln task resume RUN_ID "Continue with the remaining checks"
kiln --run RUN_ID
```

`--budget` and `--wall-seconds` set a new task's allocations. Resume preserves the saved working directory and allocations. A completed operator turn is not an independent quality approval. Inspect its artifacts, checks, and unresolved work before calling the task complete.

The TUI displays work type, selected model and routed effort. Worker routes and pending reviewer recommendations appear in the transcript without replacing the main operator's model display. A failed switch does not publish an applied route.

When `TYPESAFE_API_KEY` is configured, new operator runs use Jev for explicit `route_step auto` handoffs; ordinary prompts make no routing request. Resumed runs preserve their saved routing behavior. Kiln selects the model from its admitted pool and meters classification against the same allocation. Set `KILN_JEV_ENABLED=0` for local routing only. See [integration behavior and limits](optional-integrations.md).

The welcome screen uses large amber-white lettering and a rotating wireframe core with orbital trails, with smaller layouts for narrow terminals. `NO_ANIMATION=1` keeps a static frame. Once a conversation starts, its layout stays stable.

### Current native toolkit

The instantiated operator exposes file reading/writing/editing, shell execution, JavaScript evaluation, glob/grep search, web search, todos, and native `task`/`hub` delegation. Discoverable tools also include AST editing, debugging, and Kiln's `team`, `context_publish`, `context_query`, `route_step`, `ideate`, and `ask_user`. Browser control is available through the `browser` API inside `eval`; it is not the separate Jev ultrafast browser agent.

MCP, LSP, computer control, automatic memory and skill discovery are currently disabled in this embedded session. Available platform tools and connected provider access still depend on the local installation. Kiln's explicit Hindsight CLI is separate from native automatic memory.

### Scoped feature teams

For parallel implementation, the operator plans independently useful features with the `team` tool, then delegates through native `task` workers. Each plan includes an objective, literal relative file/directory paths (no globs), dependencies and acceptance criteria. Workers query the current ledger revision, claim their feature, and hand off artifact hashes plus check reports. Stale revisions, overlapping active scopes and unmet dependencies are rejected.

Only the actual root operator session can plan, accept or reopen features. Worker reports remain `unverified_claim`; acceptance records `parent_reviewed` after rechecking artifact identity and the parent's criterion assessment. Dependency artifact hashes are checked recursively before downstream claims and acceptance. Hashes establish which bytes were reviewed; they do not establish that a reported command ran or that a scientific conclusion is valid.

Use parent `reopen` with a reason when a worker fails or a handoff needs repair. The prior ownership, handoff and review are archived before another worker claims the feature. Reopening a dependency must wait for or resolve active dependent work. The durable ledger is `<run>/team.json`; its statuses are historical, and current artifact checks still matter. Path claims coordinate collaborators without isolating native shell/file tools. Keep the root responsible for integration checks and unresolved requirements.

### Explicit phase workflows and context

`kiln run new` uses the durable phase pipeline described below. Opening a saved phase-pipeline run in the TUI preserves that workflow's resume and checkpoint behavior.

- A newly planned, explicit local implementation task requiring no research preserves the original request in deterministic intake. It does not spend a model call paraphrasing that request or run competitive ideation.
- Formation mechanically validates the plan and obtains independent review. A coherent approval freezes the exact reviewed artifacts; corrections trigger bounded repair and re-review. Builds still require executable checks and usable independent auditing.
- Open-ended tasks use research and idea comparison. Research workers are sized to affordable complete work, with room to summarize their findings. The probe selector receives relevant canonical dossiers directly; oversized material remains explicitly referenced for retrieval.

The original request, frozen checks and full evidence are authoritative. Compact handoffs do not silently replace them. Historical workflows and existing framed work are not rewritten into the new direct-intake mode on resume. Prior-art reviewers assess relevance and coverage explicitly; a parsed search response alone cannot clear the check, and one scout cannot authenticate a collision using another scout's sources. Unassessed or inadequate coverage stays unknown with its reason attached.

Completed prior-art reports are saved before review, with their source URLs and context fingerprint. If a sibling or reviewer is interrupted, compatible saved research can be reused without paying for it again. A completed finding of inadequate coverage retires that pending handoff so new research can address the gap. Cached research never counts as an approval by itself.

Keep the checkout and dependencies downloaded locally. Cloud-optimized folders can evict files and delay startup or testing; Kiln does not move the checkout or change cloud-sync settings automatically.

## Provider access

Connect a subscription with OAuth:

```sh
kiln auth login
kiln auth login anthropic
kiln auth login openai
```

The local login callback uses Kiln's branded browser page and terminal prompts. The page acknowledges receipt; the terminal confirms connection only after token exchange succeeds. Provider-hosted consent continues to show the registered OAuth application's actual identity. Kiln also accepts the pasted redirect or code when a callback is unavailable.

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

The phases are `frame`, `discover`, `ideate`, `checkpoint`, `form`, `build`, and `reflect`. Adaptive runs choose their route from the request: exploration normally ends at the idea checkpoint, while an explicit delivery request proceeds through verified build and reflection. Direct tasks omit competitive ideation, and direct tasks requiring no research omit discovery. `--through` is an explicit invocation control; the frozen interpretation and planned route remain inspectable.

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

The prompt border shows cost, work type or phase, current activity, and directory. Operator sessions also show the selected model and routed effort. The effort control is separate from model selection; a change during work is queued for the next turn.

| Key | Action |
| --- | --- |
| `Ctrl+O` | Open the command palette |
| `Ctrl+S` | Change model effort |
| `Alt+T` | Expand or collapse tool details |
| `Esc` | Pause the active step |
| `Ctrl+C` | Exit |

Set `NO_ANIMATION=1` to disable animation. The display label `ultra` maps to the stored effort level `xhigh`.

## Optional integration commands

`kiln model suggest "task summary" --step implement --json` inspects a local step/model suggestion. Add `--jev` to explicitly request TypeSafe classification using `TYPESAFE_API_KEY`; the response remains advisory. `kiln memory status`, `retain`, and `recall` provide explicit project-scoped Hindsight access. See [configuration, examples and limits](optional-integrations.md).

## Durability and recovery

Build checks run in Kiln, followed by an independent auditor over a detached copy of the exact repository bytes. State, check output, audits, and Git commit evidence support restart after interruption.

A usage pause resumes after its recorded wake time. An operator pause resumes on request. Resume preserves prior spending and elapsed active time; the CLI reports when a budget or deadline requires the corresponding target to increase. It rechecks the latest status under the run lock, so a competing completion or new stop cannot be overwritten by a stale resume decision.

Adaptive discovery has a narrow completion allowance: after every current scout report is complete, research closes and landscape writing may use wall time reserved for phases excluded by the frozen execution. This works automatically and on explicit resume with intact cached reports; it does not repeat scouts, increase dollars, reset turns or extend the total run time. Both originally requested and newly requested phases keep their reserves. Missing, stale or failed reports cannot unlock this allowance.

An integrity failure requires inspection and an explicit relock:

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
